# 互动 Bot 设计（Telegram Serverless）

家人在 Telegram 里跟 bot 对话就能翻相册：发"今天"收当天的那年今日精选，发"7月10日"看指定日期，发"海边"/"美食"直接搜索，发"随机"来一个惊喜日子。

## 架构原则：Telegram 侧是哑管道，Worker 侧是大脑

```
家人发消息 → Telegram Serverless handler（跑在 Telegram 基础设施上）
                │  只做两件事：原文转发 + 渲染回复
                ▼
        GET /api/bot/query?q=<原文>     ← 带 Cloudflare Access Service Token
                │  意图解析、查库、生成图片直链，全在 Worker 侧
                ▼
        { text, photos: [{url, caption}], webUrl, total }
                │
                ▼
        bot 按结构渲染：sendMediaGroup / sendPhoto / sendMessage
```

这样切分的理由：

- **逻辑跟数据放在一起**——照片索引、AI 评分、地名都在 D1/R2，查询逻辑写在 Worker 里能直接复用 `matchPhotosForDay`/搜索 SQL/`tgPhotoUrl`，还能用 `wrangler dev` 本地测试
- **Telegram Serverless 侧代码越薄越好**——那边是新平台（tgcloud CLI、handler 签名、内置 SQLite DSL），代码越少踩坑面越小，以后想换回 Workers webhook 模式也只需要重写这层薄壳
- **图片必须走公开直链**——站点在 Cloudflare Access 后面，Telegram 服务器抓不到 `/img/*`；`/api/bot/query` 返回的是 PREVIEWS 公开桶的 `tg/` 前缀 JPEG 直链（复用每日推送的 `tgPhotoUrl` 机制，已有缓存）

## 意图表（Worker 侧解析，bot 无感知）

| 用户输入 | 意图 | 行为 |
|---|---|---|
| `今天` / `/today` / `/start` / 空 | 那年今日 | 北京时间今天的 月-日，跨年份精选 |
| `7月10日` / `7-10` / `7/10` | 指定日期 | 该 月-日 的跨年份精选 |
| `随机` / `惊喜` / `/random` | 随机回忆 | 只在"有照片的日子"里随机抽一天 |
| 其他任意文字 | 关键词搜索 | AI 文案 / 拍摄地名 / AI 标签 LIKE 匹配 |

选片口径与每日零点推送一致：最多 5 张，有 AI 分的按分数优先、没分的按上传时间补位；`total` 带全量数字，bot 提示"共 N 张"并附 `webUrl` 引导去网页看全部（家人浏览器里本来就过了 Access 登录）。

## Worker 侧接口（已实现）

`GET /api/bot/query?q=<用户原文>`

响应：

```json
{
  "q": "今天", "mode": "day", "month": "07", "day": "17",
  "total": 12,
  "text": "📅 7 月 17 日，那些年的此刻\n横跨 3 个年头 · 共 12 张",
  "webUrl": "https://memories.cuijianzhuang.com/?month=07&day=17",
  "photos": [
    { "url": "https://previews.cuijianzhuang.com/tg/....jpg", "year": "2024", "caption": "2024 年 · 一家人在海边散步" }
  ]
}
```

鉴权：不加自定义 token（与 /admin/* 决策一致），靠 Cloudflare Access Service Token：

1. Zero Trust 控制台 → Access → Service Auth → 创建 Service Token，得到 `CF-Access-Client-Id` / `CF-Access-Client-Secret`
2. 站点的 Access 应用策略里加一条 **Service Auth** 类型的 Allow 规则，选中这个 token
3. bot 侧每个请求带上这两个 header 即可穿过 Access；泄漏了就在控制台吊销重发

## Telegram Serverless 侧（参考骨架）

> ⚠️ Telegram Serverless（core.telegram.org/bots/serverless）是 2026 年新平台，
> 以下按官方文档的项目结构（`handlers/` 按 update 类型分文件、`lib/` 共享代码、
> `schema.js` 建表）写的参考骨架，**部署前以官方文档的实际 API 签名为准**。

```
tg-bot/
├── handlers/
│   └── message.js      # 收到消息 → 调 /api/bot/query → 渲染回复
├── lib/
│   └── api.js          # 封装带 Service Token 的 fetch
└── schema.js           # 暂时不需要表（会话状态以后再说）
```

`handlers/message.js` 的核心逻辑（伪代码级别）：

```js
// 1. 取消息文本，原样转发给 Worker
const resp = await fetch(
  "https://memories.cuijianzhuang.com/api/bot/query?q=" + encodeURIComponent(msg.text || ""),
  { headers: { "CF-Access-Client-Id": CLIENT_ID, "CF-Access-Client-Secret": CLIENT_SECRET } }
);
const data = await resp.json();

// 2. 渲染：多图 sendMediaGroup（第一张带 caption），单图 sendPhoto，没图 sendMessage
if (data.photos.length > 1) {
  await bot.sendMediaGroup(chatId, data.photos.map((p, i) => ({
    type: "photo", media: p.url, ...(i === 0 ? { caption: data.text + "\n" + data.webUrl } : {}),
  })));
} else if (data.photos.length === 1) {
  await bot.sendPhoto(chatId, data.photos[0].url, { caption: data.text + "\n" + data.webUrl });
} else {
  await bot.sendMessage(chatId, data.text);
}
```

## 边界与注意事项

- **Telegram Serverless 没有定时任务**（按 update 触发）——每日零点推送、Cron 维护全部留在 Workers，bot 只管"有人问才答"
- **handler 里不能上传/下载文件**（当前限制，响应上限 32MB）——发图只能走 URL，这正是接口返回公开直链的原因
- **内置 SQLite 只用来存会话状态**（以后如果要做"翻页看更多"之类），**绝不复制照片元数据过去**——双数据源的同步是无底洞；当前骨架干脆不建表
- **持续 CPU 型任务不要放过去**（官方明确不适合媒体转换/模型推理）——HEIC 转码、AI 打分留在 Workflow
- 隐私：`tg/` 直链是公开 URL（无 Access），发进聊天后拿到链接的人都能打开——家庭群可接受，介意的话未来可改 multipart 直传字节

## 渐进路线

1. ✅ Worker 侧 `/api/bot/query`（本仓库，已实现，可先用 curl + Service Token 验证）
2. 控制台建 Service Token + Access 策略放行
3. 按官方文档初始化 tgcloud 项目，抄上面的骨架接通 `message` handler
4. 之后再考虑：inline 按钮翻页（"再看 5 张"）、`/loved` 排行、每周家庭数字摘要（这个要定时，仍由 Workers Cron 推）
