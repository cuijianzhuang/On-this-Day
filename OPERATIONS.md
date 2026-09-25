# 运维手册

日常运维的首选入口是 **运维控制台 `/admin/ops`**（首页头部齿轮图标可进；整站在 Cloudflare
Access 后面，不需要额外 token），系统状态、批量维护、
错误数据修复都可以在页面上点按钮完成。本文档记录控制台背后的原理和控制台覆盖不到的
命令行操作。

## 架构速记

- **R2 `image` 桶**：原图，唯一真数据源，其他一切都可从它重建
- **R2 `image-previews` 桶**：全是派生物——`thumbs/`（WebP 缩略图）、`{年/月/日}/*.heic-preview.jpg`（HEIC 预转）、`tg/`、`og/`、`icon/`
- **D1 `memories-db`**：`photos_index`（索引，照片可见性的唯一依据）、`photo_scores`（AI 评分+文案+分类标签，可再生）、`photo_places`（地点，可再生）、`photo_reactions`（表态 D1 镜像，权威在 DO）、`photo_comments`（手记评论串）、`meta`（诗词缓存 `poem:*`、待推送队列 `notify:*`）
- **KV**：后台任务状态位（`backfill_done_at`、`reindex_dates_done_at/offset`、`last_viewed_day`、`jinrishici-token`）
- **数据流**：照片上传 R2 → 事件通知 → Queue → Workflow 五步流水线（索引→HEIC 转码→AI 打分→查地点→清缓存）；存量照片靠 Cron（每 15 分钟）回填追赶

## 运维控制台 /admin/ops

- **系统状态**：索引量、待打分/待查地点积压、推送队列、回填/重扫进度
- **维护任务**：手动触发一批索引回填 / AI 打分 / 查地点 / HEIC 转码 / 补流水线 / 测试推送
- **缓存**：按天清 `/api/memories` `/api/map-photos` 边缘缓存（改完数据必点）
- **状态开关**：重启索引回填、重跑日期重扫（清 KV 标记，Cron 自动推进）
- **照片数据修复**：按 key 搜索 → 改拍摄日期 / 改地点名 / 重查地点 / 重新打分 / 删手记 / 从索引移除

管理端点也可直接 curl（同样不需要 token，但要带上能过 Cloudflare Access 的凭证）：
`/admin/backfill-photos-index?limit=300`、`/admin/reindex-photo-dates?limit=200&offset=0`、
`/admin/backfill-photo-dims?limit=50&after=<上次返回的 nextKey>`（回填缩略图宽高，返回 `nextKey` 为 null 表示扫完）、
`/admin/score-photos?limit=10`、`/admin/locate-photos`、`/admin/convert-heic-photos`、
`/admin/purge-cache?month=MM&day=DD`、`/admin/backfill-workflows`、`/admin/test-telegram`、
`/admin/ops-status`、`/admin/photo-info?q=…`。

## 边缘缓存是否生效

走缓存的接口（`/api/memories`、`/api/map-photos`、`/api/stats`、`/img/`、`/og-image` 等）
响应头都带 `x-edge-cache: HIT` 或 `MISS`。浏览器 DevTools → Network 里点开请求看响应头，
**同一个请求刷新两次，第二次应该是 HIT**。

一直是 MISS 说明 Cache API 在这个部署下没生效（Cloudflare 文档提到"被 Cloudflare Access
挡在前面的 Worker 不能用 Cache API"——按文档，自定义域名 + Zero Trust 应用的组合应当不受影响，
但措辞有歧义，以这个头的实际表现为准）。响应里根本没有这个头，说明请求没走到带缓存的代码路径。

## 命令行操作（控制台覆盖不到的）

```bash
# 实时日志（console.error 全量保留）
npx wrangler tail memories-today

# D1 任意查询 / 备份
npx wrangler d1 execute memories-db --remote --command "SELECT COUNT(*) FROM photos_index"
npx wrangler d1 export memories-db --remote --output backup.sql   # 另有 30 天 Time Travel

# KV 状态位
npx wrangler kv key list --namespace-id 416a9183c40347288fbd9c05c7a4a295 --remote

# R2 派生文件（坏缩略图删掉即自动重新生成；HEIC 占位图删掉即重置重试计数）
npx wrangler r2 object delete "image-previews/thumbs/400/Photos/.../IMG_1234.webp" --remote
npx wrangler r2 object delete "image-previews/2023/06/14/IMG_1234.heic-preview.jpg" --remote
```

## 常见故障 → 处理

| 症状 | 处理 |
|---|---|
| 新照片没出现在页面 | 控制台清那一天缓存；仍没有→看 Workflows 面板哪一步失败→「补触发流水线」 |
| 照片日期错了 | 控制台搜到照片→改拍摄日期（自动清新旧两天缓存）。注意文件名/EXIF 带日期的照片会被「日期重扫」按解析结果覆盖 |
| AI 文案/评分不满意 | 控制台「重新打分」（同步调 AI，等几秒） |
| 地点错/缺 | 「重查地点」或直接「改地点名」 |
| 原图删了页面还显示 | 「从索引移除」（不动 R2） |
| 缩略图裂 | 先等自动重试；不行就删 PREVIEWS 里对应 webp 让它重新生成；HEIC 全裂查 Transformations 免费额度（每月 5000 次） |
| 推送没发出来 | 控制台「测试 Telegram 推送」验证配置；`meta` 表 `notify:%` 堆积说明发送持续失败，看 tail 日志 |
| 索引数 < R2 对象数 | 「重启索引回填」，Cron 每 30 分钟补 300 张 |
| Telegram/诗词等第三方挂了 | 都有降级（推送重试、诗词 204），不影响主页面 |

## 心法

R2 原图是唯一不可丢的；scores/places 删了会自动重算；`photos_index` 可全量重建；
**改完任何数据，最后一步永远是清对应日期的边缘缓存**。
