# 那年今日 (On This Day)

一个跑在 Cloudflare Worker + R2 + D1 上的私人"时光相册"。每天打开都能看到历年同一天拍的照片和视频，灵感来自 Apple Photos 的"回忆"功能。

## 特性

### 核心逻辑
- 自动按"今天的月/日"匹配历年照片，跨年份展示
- 支持文件名带日期（`IMG_20260627_141422.PNG`）和纯序号命名（`IMG_1017.JPG`）两种素材：
  - 带日期的直接按文件名匹配
  - 不带日期的，JPEG/HEIC 读 EXIF `DateTimeOriginal`，其他格式回退用 R2 上传时间近似
- 用 Workers Cache API 缓存无日期文件名的拍摄日期推算结果，避免重复计算
- 同一年的照片按文件名排序，不再是 R2 返回的随机顺序
- 图片/视频代理接口隐藏真实 R2 链接，支持 inline 预览和 `?dl=1` 下载两种模式
- **Live Photo 配对**：同目录下文件名（去掉扩展名）完全相同的一张 HEIC/JPEG + 一段 MOV，自动识别成一条 `type: 'live'` 记录，不会在时间线里重复出现两次；网格缩略图悬浮（桌面）/长按（移动端）播放配对的短视频预览，灯箱大图同样悬浮播放，参考 Apple Photos 的"Live Photo"交互

### 数据索引（photos_index）
- R2 里的照片/视频不再靠每次访问现场 `list()` 扫描——新增了一张 D1 索引表 `photos_index`（key, type, year, month, day, size, uploaded），按 month/day 建了索引，查询比扫全量 R2 便宜得多
- **R2 Event Notification → Queue → `queue()` consumer** 增量维护这张表：新文件一上传（`PutObject`/`CompleteMultipartUpload`/`CopyObject`）就自动建好索引、顺手打分/查地点、清掉对应日期的页面缓存；文件被删除（`DeleteObject`/`LifecycleDeletion`）则把索引、打分、查地点、配套 HEIC 预览图一起清掉，避免页面继续展示已经不存在的照片
- 队列消费者 `max_batch_size` 故意设成 1——批量打分要喂图片给 AI 模型，没有现成 JPEG 预览图的 HEIC 还要现场解码，几条消息的内存压力叠在同一次调用里很容易撞上 Workers 的内存限制（exceededMemory）
- 首次部署或者存量库很大时，需要先跑一次性回填：`GET /admin/backfill-photos-index?token=xxx&limit=200`（见下方 API），Cron 也会自动按节拍慢慢补，不用一直手动点

### 成本控制（边缘缓存）
- `/api/memories`、`/api/map-photos` 的结果都用 Workers Cache API 缓存，避免每次访问都重新扫一遍 R2（List 是 A 类操作，比 Get 贵很多）；新文件上传/删除时队列消费者会自动清掉对应那天的缓存，不用等 30 分钟自然过期
- `/img/` 图片字节本身也显式缓存在边缘节点，同一张照片被反复请求不会重复打 R2；206 Range 响应（视频拖动/取封面帧）不缓存——Cache API 不支持缓存 Partial Content
- AI 打分、查地点、HEIC 转码、索引回填等批量后台处理改用 **Cron 定时任务**（每 10 分钟跑一次，见下方"后台任务"），跟用户访问页面完全分开，不会因为叠加子请求把 `/api/memories` 撞到 Workers 单次调用的子请求上限

### AI 选片 + 文案
- 接入 Workers AI（`@cf/llava-hf/llava-1.5-7b-hf`），给每张照片打三件事：1-10 的"值不值得展示"分、是否检测到人脸、一句中文文案（像相册里手写的一句话），文案展示在灯箱大图下方
- llava-1.5 经常不老实听话用英文回文案，检测到没有中文字符就再过一遍 `@cf/meta/m2m100-1.2b` 翻译模型转成中文
- **HEIC 喂给视觉模型前必须先转成 JPEG**——直接传 HEIC 原始字节会报 `Unsupported image data`，错误会被默默吃掉退化成默认分；优先用已经生成好的 HEIC 预览图（省一次解码），没有的话现场解码一次。没有预览图的 HEIC 不会在新照片上传时立刻打分（避免在同一次队列/Cron 调用里堆叠多次解码撞内存上限），会等预览图转出来后由 Cron 自然补上
- 原始模型返回文本、最后更新时间也存进 D1（`raw_response`、`updated_at`），方便排查模型有没有好好按格式回复、以后改 prompt/换模型时对比效果
- 某一年照片超过 10 张时，自动挑选一部分展示，优先级：视频/Live Photo → 同时带 GPS 坐标 + 检测到人脸的"真实拍摄"照片（按分数从高到低）→ 其他已打分照片 → 还没打分的按时间均匀抽样补位，没被选中的折进"展开查看全部"
- 存量照片库可以用管理接口手动批量打分：`GET /admin/score-photos?token=xxx&limit=5`，需要先配置 `ADMIN_TOKEN`

### 拍摄地点 + 地图
- 从 EXIF 解析 GPS 坐标（JPEG 和 HEIC 都支持，HEIC 走的是 ISOBMFF box 解析），用 Mapbox Geocoding API 反向地理编码成地名
- `/map` 页面用 Mapbox GL JS 把**当天**匹配到的、带坐标的照片打点在地图上（不是整个照片库），鼠标移到红点上直接展示缩略图
- 存量照片库可以用管理接口手动批量查地点：`GET /admin/locate-photos?token=xxx&limit=10`

### 后台任务（Cron，每 10 分钟）
- 优先级：**服务器真实的"今天"** + "最近有人在看的那一天"（记录在 D1 的 `meta` 表里，可能是某个历史日期）取并集——刚拍完传上来的照片不会因为有人在翻旧日期就一直排不上号
- 候选池查的是 `photos_index` 表，不再现场扫 R2（之前在库变大之后稳定触发 `exceededMemory`，整个 Cron 直接被杀掉）
- 每批最多处理 10 张打分/查地点；HEIC 转码批量给得更小（1 张/次，解码一张全尺寸 HEIC 到原始像素的内存开销比打分/查地点都重得多）
- **索引回填**跟**HEIC 转码**是这个函数里最吃内存的两步，按当前分钟单双轮流跑（每 20 分钟一半时间回填、一半时间转码），保证它俩永远不会出现在同一次调用里

### 前端体验
- 宝丽来风格错落"回忆墙"：随机尺寸 + 轻微倾斜 + 挂绳图钉效果，悬停时指尖联动倾斜
- 点击照片弹出灯箱预览，支持左右切换、键盘方向键、ESC 关闭、移动端左右滑动手势
- "播放回忆"按钮：自动全屏幻灯片播放，多种随机转场效果（淡入淡出 / 缩放 / 左右滑动）
- "唤醒林间"开关：一个开关同时控制暖色光斑视觉效果（铺满整页）和林间环境音播放，切换时有阳光扫过的过渡动画；开启后文字自动转深色保证可读性
- 自制日历选择器（不依赖浏览器原生 `<input type="date">`），点哪天直接跳转，"回到今天"是真正的链接而不是 JS 按钮（更稳，不依赖 JS 执行成功）
- 自定义鼠标指针：相机对焦取景框样式，悬停可点击元素时角括号收紧、中心点变亮
- Space Grotesk 字体用在标签/数字类文字上，正文仍是系统字体
- 支持 URL 参数 `?month=06&day=27` 查看指定日期，不传则用浏览器本地日期
- 移动端做了响应式适配：缩略图分辨率按视口宽度 × 设备像素比算（不再照搬桌面端的随机尺寸，省流量/更清晰）；灯箱用 `touch-action: pinch-zoom` 既能双指缩放看细节又不会被单指滑动手势带着背后整页一起滚动；顶部悬浮控件用 `env(safe-area-inset-*)` 适配刘海屏/灵动岛
- 缩略图加载失败会按 5s/15s/45s 退避自动重试（破缓存重新请求 `/thumb/`），很多裂图只是服务端转码还没追上，不用手动刷新整页；重试用完才退回到 HEIC 现场解码/原图兜底
- 副标题下方有一行"今日诗词"（接的 [jinrishici.com](https://www.jinrishici.com/doc/) 的 API），按"今天"的真实日期缓存一份，跟翻看哪个历史日期无关；第三方接口挂了不影响主页面

## 目录结构

```
worker.js       # Worker 全部逻辑（API + 图片代理 + AI 打分 + 地图页 + 前端页面，单文件）
wrangler.toml   # Cloudflare 部署配置（R2/AI/D1 绑定、路由、环境变量、Cron）
schema.sql      # D1 数据库表结构
```

## 数据约定

R2 桶里照片需按以下路径存放：

```
Photos/MobileBackup/iPhone/{年}/{月}/{文件名}
```

月份目录下不需要再按天分文件夹，靠文件名或 EXIF 判断具体日期。

AI 打分、拍摄地点、照片索引、"最近查看的日期"这几类元数据存在 **D1**（`memories-db`），不再是 R2 里的 JSON 文件：

- `photos_index (key, type, year, month, day, size, uploaded, updated_at)` —— 照片/视频索引，靠 R2 Event Notification 增量维护，按 month/day 建了索引
- `photo_scores (key, score, has_face, caption, raw_response, updated_at)` —— AI 打分/文案结果，`raw_response` 是模型原始返回文本
- `photo_places (key, lat, lon, name)` —— 反向地理编码结果
- `meta (key, value)` —— 目前只有一行 `last_viewed_day`，记录最近一次访问的 month/day

## 部署

1. 安装并登录 wrangler：

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. 创建 D1 数据库并应用表结构（首次部署才需要）：

   ```bash
   wrangler d1 create memories-db
   # 把命令输出里的 database_id 填进 wrangler.toml 的 [[d1_databases]]
   wrangler d1 execute memories-db --remote --file ./schema.sql
   ```

3. 创建队列、配好 R2 事件通知（首次部署才需要）：

   ```bash
   wrangler queues create photo-index-queue
   # 新增/修改和删除各配一条通知规则，都指向同一个队列
   wrangler r2 bucket notification create <你的照片桶名> --event-type object-create --queue photo-index-queue --prefix "Photos/MobileBackup/iPhone/"
   wrangler r2 bucket notification create <你的照片桶名> --event-type object-delete --queue photo-index-queue --prefix "Photos/MobileBackup/iPhone/"
   ```

4. 编辑 `wrangler.toml`：
   - `PHOTOS` 绑定的 `bucket_name` 改成你存原图的 R2 桶名；`PREVIEWS` 绑定指向另一个单独的桶，专门存 HEIC 转出来的 JPEG 预览图（两个桶都要先用 `wrangler r2 bucket create <桶名>` 建好）；`PREVIEWS` 桶建议配一条 7 天的生命周期规则自动清理（`wrangler r2 bucket lifecycle add <桶名> <规则名> --expire-days 7`）
   - `routes` 里的 `pattern` / `zone_name` 改成你要绑定的自定义域名（该域名需已托管在 Cloudflare）
   - `[ai]` 绑定不需要额外创建资源，是账号自带的平台功能
   - `[[d1_databases]]` 里的 `database_id` 换成上一步创建出来的 ID
   - `[[queues.consumers]]` 里的 `queue` 名字要跟第 3 步创建的队列名一致
   - `[vars]` 里的 `ADMIN_TOKEN` 建议换成你自己生成的随机字符串；如果仓库会推到公开/共享的地方，更安全的做法是改用 `wrangler secret put ADMIN_TOKEN`（加密存储，不会出现在任何文件里），再把 `[vars]` 里这行删掉
   - `[vars]` 里的 `MAPBOX_PUBLIC_TOKEN` 必须是 Mapbox 的 **public token**（`pk.` 开头），会原样发给浏览器跑地图。反向地理编码用的是另一个 **secret token**，要用 `wrangler secret put MAPBOX_TOKEN` 单独存（千万不要把 secret token 写进 `wrangler.toml`），创建这个 token 时记得勾上 **Geocoding** 权限范围，没勾会一直 403

5. 部署：

   ```bash
   wrangler deploy
   ```

6. 首次部署、存量库较大时，跑一次性回填把已有文件补进 `photos_index`（Cron 也会自动慢慢补，手动跑能更快补齐）：

   ```bash
   curl "https://你的域名/admin/backfill-photos-index?token=xxx&limit=200"
   # 反复跑，直到返回里的 remaining 降到 0
   ```

## 鉴权

本项目本身不做登录鉴权，建议用 **Cloudflare Zero Trust Access** 在边缘层拦截：

1. Cloudflare Dashboard → Zero Trust → Access → Applications → Add an application → Self-hosted
2. 域名填 Worker 绑定的自定义域名
3. 配置访问策略，比如只允许自己的邮箱；如果要分享给家人，可以用 "One-time PIN" 身份提供程序——对方不需要注册任何账号，靠邮箱收验证码登录即可

## API

### `GET /api/memories?month=MM&day=DD`

返回指定月日在各年份下匹配到的照片/视频列表，按年份从新到旧排序，每张照片附带 AI 打分、人脸检测结果、拍摄地点。

```json
{
  "month": "06",
  "day": "27",
  "years": [
    {
      "year": "2023",
      "photos": [
        { "key": "...", "url": "/img/...", "type": "image", "size": 123, "uploaded": "...", "score": 8, "hasFace": true, "place": "杭州" }
      ]
    }
  ]
}
```

### `GET /img/{key}?dl=1`

图片/视频代理。不带 `dl` 参数时强制 `inline` 展示；带 `dl=1` 时返回 `Content-Disposition: attachment` 触发下载。

### `GET /map?month=MM&day=DD`

地图页面，默认今天。

### `GET /api/map-photos?month=MM&day=DD`

返回指定月日匹配到的、带坐标的照片列表，给地图页打点用。

### `GET /admin/score-photos?token=xxx&limit=5`

管理端点，需要 `token` 匹配 `ADMIN_TOKEN` 才能调用。每次只处理一小批未打分的照片（默认 5 张，最多 20 张），避免单次请求超时。多次调用直到返回的 `remaining` 降到 0，存量照片就都打完分了。

```json
{ "scoredThisBatch": 5, "remaining": 37, "totalPhotos": 42 }
```

### `GET /admin/locate-photos?token=xxx&limit=10`

同上，但处理的是拍摄地点（每次最多 20 张）。

### `GET /admin/convert-heic-photos?token=xxx&limit=3`

批量给 HEIC 照片生成 JPEG 预览版（服务端解码，需要 Workers Paid 套餐）。之前失败过的会按重试次数自动重试（上限 5 次，见下方"HEIC 照片"）。

### `GET /admin/backfill-photos-index?token=xxx&limit=200`

一次性回填脚本，把上线 R2 Event Notification 之前已经存在的旧文件补进 `photos_index`（最多 300 张/次）。新上传的文件由队列消费者增量维护，这个端点只用来补历史存量，跑到 `remaining` 降到 0 就完事了。

```json
{ "indexedThisBatch": 200, "remaining": 7800, "totalCandidates": 8000, "alreadyIndexed": 200, "errors": [] }
```

### `GET /admin/purge-cache?token=xxx&month=MM&day=DD`

手动清掉某个 month/day 的 `/api/memories`、`/api/map-photos` 边缘缓存。新文件上传/删除时队列消费者会自动清，这个端点主要用于手动验证效果或者排查问题。

### `GET /api/poem`

返回"今日诗词"（接的 jinrishici.com），按真实日期缓存一份，跟历史日期浏览无关。第三方接口挂了返回 204。

### `POST /api/upload-heic-preview?key={原图key}`

浏览器端 heic2any 现场解码兜底成功后，前端会把结果回传到这个接口存进 `PREVIEWS` 桶，下次同一张照片就不用别的访问者再解码一遍。Body 是 JPEG 字节，会校验 magic bytes 和大小（≤10MB）。整站本来就建议配 Cloudflare Access，这个接口没有再加 `ADMIN_TOKEN`。

## HEIC 照片

Cloudflare 的图片处理（Images binding、Image Resizing）都不支持 HEIC 作为输入格式，浏览器原生也大多解不开 HEIC，所以：

- `/thumb/` 接口会优先找 `PREVIEWS` 桶里的 `{年}/{月}/{日}/{文件名}.heic-preview.jpg`（提前转码好的 JPEG，跟原图分桶存，按拍摄日期分文件夹而不是照搬原图的年/月路径），按那个做缩放；也可以调用 `/admin/convert-heic-photos?token=xxx&limit=3` 让服务端自己解码生成（需要 Workers Paid 套餐）。在改成按日期分文件夹之前生成的旧预览图（路径直接照搬原图的年/月）也认得，不会被当成"没转"重新生成，但新生成的都会落在新路径下
- 没有伴生文件时，前端会用 [heic2any](https://github.com/alexcorvi/heic2any) 在浏览器里现场解码兜底——能用，但每个访问者都要重新解码一次，HEIC 多的话会很慢
- 所以建议用 `scripts/convert-heic-previews.sh` 提前批量生成预览图，新增 HEIC 照片后也跑一遍：

  ```bash
  npm install   # 装 heic-convert
  # 拿到所有 HEIC 的 key 列表（已经打过分/查过地点的，覆盖大部分）：
  npx wrangler d1 execute memories-db --remote --json \
    --command "SELECT key FROM photo_scores WHERE key LIKE '%.heic' UNION SELECT key FROM photo_places WHERE key LIKE '%.heic'" \
    | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d[0].results.map(r=>r.key).join('\n'))" > heic_keys.txt
  bash scripts/convert-heic-previews.sh heic_keys.txt
  ```

  已经生成过预览图的会自动跳过，可以放心重复跑。

- Cron 任务（`scheduled()`）也会自动跑这个转码，但**只转服务器真实"今天"拍的**（不像打分/查地点那样还顺带覆盖"最近浏览日期"或者存量库），每次最多 1 张（解码一张全尺寸 HEIC 到原始像素的内存开销很重，调太大容易撞上 Workers 的内存限制），且跟索引回填错峰跑（同一次 Cron 调用不会同时出现）
- 转码失败的会写一个 4 字节的占位 JPEG 标记"试过了"，并记一个重试次数（R2 自定义元数据）。**服务端**重试次数没到 **5 次**上限之前还会继续重试，到了上限就放弃自动重试（避免对一张真解不开的坏文件反复浪费 CPU）；**浏览器端**（`heic2any`）解码不占用这个重试名额——哪怕服务端 5 次都失败放弃了，用户自己在浏览器里解码成功并回传上来，照样会被接受存进去
- HEIC 服务端解码用的是 `libheif-js` 的 wasm 构建，必须用 `new WebAssembly.Instance()`（同步 API）而不是 `WebAssembly.instantiate()`（异步 API）创建实例——用异步 API 会在 libheif 的 embind 类注册跑到一半时被打断，报 `Cannot read properties of undefined (reading 'overloadTable')`，这是库本身的问题，跟 Workers 无关，在纯 Node 环境下用同样的异步加载方式也能复现
- AI 打分喂图片给视觉模型前，HEIC 必须先转成 JPEG（直接传原始字节会报 `Unsupported image data`）——优先用已经生成好的预览图，没有的话现场解码一次；为了不在同一次调用里堆叠多次解码撞内存上限，没有预览图的 HEIC 不会在"新照片上传"这个时机立刻打分，会等 Cron 转出预览图后自然补上
- 浏览器端 `heic2any` 解码成功后会通过 `/api/upload-heic-preview` 把结果回传存进 `PREVIEWS` 桶，下次别的访问者就不用再解码一遍
- `PREVIEWS` 桶配了 7 天的生命周期规则，预览图过期自动删除，省存储空间——下次再被访问到时会重新生成

## 已知限制

- HEIC 的 EXIF 解析是按 ISOBMFF 容器结构手写的 box 解析（meta/iinf/iloc），对非典型编码方式的 HEIC 文件可能解析失败，失败会静默回退到 R2 上传时间近似，不会报错
- 月份目录下文件较多且大量缺日期文件名时，首次访问会因逐个判断拍摄日期而变慢（命中缓存后会快很多）；`matchPhotosForDay`（页面实际展示用的匹配逻辑）目前仍然现场扫 R2 + 限并发（8）读 EXIF，没有切到 `photos_index`，库特别大时这部分仍有压到子请求/内存上限的风险，后台任务（Cron）已经切过去了
- 未做存储层的访问控制，必须配合 Cloudflare Access 或同等方案保护隐私
- AI 打分、反向地理编码都会产生外部调用费用（超出免费额度部分），自动处理只在 Cron 里小批量跑，不会扫全量库，但仍建议关注 Cloudflare / Mapbox 账单
- Mapbox 的 secret token 创建时要勾上 **Geocoding** 权限范围，没勾会一直 403（跟 token 过期/拼错无关，是权限范围没给对）
- `ADMIN_TOKEN` 如果写在 `wrangler.toml` 的 `[vars]` 里，会以明文形式出现在该文件中，注意不要把它推到公开仓库
