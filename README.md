# 那年今日 (On This Day)

一个跑在 Cloudflare Worker + R2 + D1 上的私人"时光相册"。每天打开都能看到历年同一天拍的照片和视频，灵感来自 Apple Photos 的"回忆"功能。

## 特性

### 核心逻辑
- 自动按"今天的月/日"匹配历年照片，跨年份展示
- **农历"那年今日"**：顶栏"公/农"滑块切换历法——农历模式下按同一农历日反推历年对应的公历日期来匹配照片（内置 1900–2049 农历压缩表，支持闰月），公历同日已出现过的照片自动去重
- 支持文件名带日期（`IMG_20260627_141422.PNG`）和纯序号命名（`IMG_1017.JPG`）两种素材，**年月日整体取自同一个拍摄日期源**：
  - 带日期的直接按文件名解析年月日（带月/日合法性校验，防毫秒时间戳误判）
  - 不带日期的，JPEG/HEIC 读 EXIF `DateTimeOriginal`（含年份），其他格式回退用 R2 上传时间近似
  - **不信备份路径的年月**——iPhone 备份按"备份时间"落目录，6/14 拍的照片 7 月才备份会躺在 `07/` 目录里，早期"路径出月 + 文件名出日"的拼法会索引出 7月14日 这种不存在的拍摄日
- 同一年的照片按文件名排序，不再是 R2 返回的随机顺序
- 图片/视频代理接口隐藏真实 R2 链接，支持 inline 预览和 `?dl=1` 下载两种模式
- **Live Photo 配对**：同目录下文件名（去掉扩展名）完全相同的一张 HEIC/JPEG + 一段 MOV，自动识别成一条 `type: 'live'` 记录
- **实况照片播放（对齐苹果相册）**：灯箱里照片左上角叠"实况"角标（虚线外圈 + 实线内圈 + 中心点的苹果同款 SVG 图标），打开自动播一遍（静音）；移动端**长按带声循环播放、松手即停**，桌面悬浮静音预览、按住鼠标带声播放。两个 iOS Safari 的坑：长按会被系统"保存图片"菜单抢占，必须 `-webkit-touch-callout: none`（`preventDefault(touchstart)` 拦不住）；video 覆盖层用 CSS Grid `grid-area: 1/1` 叠层而不是 `position:absolute + height:100%`（父元素 `height:auto` 时百分比解析不稳定，画面会偏移）

### 实时共享（Durable Objects）
- 每个日期（"MM-DD"）对应一个 DO 房间实例，家人同时打开同一天时顶部显示"👥 N 人在看"（按唯一用户去重；启用 Cloudflare Access 时用邮箱识别身份并显示 Gravatar 头像）
- **表态**：每张照片可发 emoji 表态（👍❤️😍😂😮😢🔥✨），全员实时看到计数变化；一个人对同一照片同一 emoji 只能点一次，再点一次取消
- 表态存储按照片拆分为 `rx:<photoKey>` 独立 key（避免单 key 128KB 上限），旧格式自动懒迁移
- 计数同步镜像到 D1 `photo_reactions` 表：房间首次有人进入时全量回填历史计数，之后每次写入镜像该照片的全部 emoji——"全家最爱"页靠它跨日期聚合

### 围绕照片的小功能
- **全家最爱 `/loved`**：跨所有日期聚合表态最多的照片排行
- **照片搜索**：顶栏 🔍 按钮，搜 AI 生成的中文文案和拍摄地名（350ms 防抖 + 过期请求丢弃）
- **照片手记**：灯箱详情面板里给任意照片写一句文字注解，存 D1 `photo_notes`
- **年度回忆放映 `/recap`**：取某一年 AI 评分最高的 40 张按时间顺序全屏 Ken Burns 幻灯放映
- **OG 分享卡片**：链接分享到微信/Telegram/Twitter 时，预览卡片自动带上当天最高分照片和日期标题（HTMLRewriter 注入 + `/og-image` 动态生成）
- **PWA 可安装**：manifest + 动态应用图标（`/app-icon` 用全库最高分照片裁方形生成），`<link rel="manifest">` 带 `crossorigin="use-credentials"` 以兼容 Cloudflare Access
- **Telegram 推送**：北京时间每天零点把当天历史照片按 AI 评分挑最高的几张推送到 Telegram 群（配文案 + 跳转链接）；新照片上传即时推送（10 分钟聚合窗口防刷屏）
- **历史上的今天**：Wikimedia Feed API 的当日大事记（中文维基精选优先、英文兜底），折叠在诗词下方，跟着正在浏览的日期切换；边缘缓存 7 天，接口挂了整块隐藏不影响主页面

### 数据索引（photos_index）
- R2 里的照片/视频不再靠每次访问现场 `list()` 扫描——D1 索引表 `photos_index`（key, type, year, month, day, size, uploaded, width, height），按 month/day 建了索引
- **缩略图宽高（消除布局跳动）**：`width`/`height` 存的是等比缩略图的像素尺寸，`/api/memories` 一并下发，前端用它把照片墙的占位框一开始就撑成正确比例——图片加载完不再从 1:1 跳成真实比例（一屏几十张就是几十次布局位移）。取值只从**已生成的等比缩略图**量（`/thumb/` 生成时顺手 `IMAGES.info()`，不计费），不量原图：Images 的 transform 会应用 EXIF 旋转，竖拍照片原图像素是横的、输出却是竖的，量原图会把方向搞反；`fit=cover` 那种裁过的也不能用来量。存量照片由 Cron 慢慢回填（只探测 PREVIEWS 里已有的缩略图，不触发任何转换），或手动跑 `/admin/backfill-photo-dims`
- **R2 Event Notification → Queue → Workflow** 增量维护：新文件一上传，`queue()` consumer 只负责触发 `PhotoProcessingWorkflow`，索引、HEIC 转预览、AI 打分、查地点、清缓存分散到 Workflow 的独立步骤里（每步持久化、独立重试）；删除事件轻量内联处理，同步清掉索引/打分/地点/预览图/日期缓存
- 首次部署或存量库很大时跑一次性回填：`GET /admin/backfill-photos-index?token=xxx&limit=200`；Cron 也会自动补，**全部补完后写 `backfill_done_at` 标记，降频为每天核对一次**，不再空转扫桶
- **存量日期重算**：索引日期规则变更后（见"核心逻辑"），Cron 在回填的对侧分钟自动分批重算存量行（每趟 200 行，进度存 KV，扫完写 `reindex_dates_done_at` 后永久跳过），修正的行顺手清掉新旧两天的缓存；`/admin/reindex-photo-dates` 可手动加速

### 成本控制（边缘缓存）
- `/api/memories`、`/api/map-photos` 结果用 Workers Cache API 缓存；新文件上传/删除时自动清对应日期的缓存
- `/img/` 图片字节显式缓存在边缘节点；206 Range 响应（视频拖动）不缓存
- `/thumb/` 缩略图由 Cloudflare Images binding 转成 WebP 后写入 `PREVIEWS` 桶，302 跳公开预览 URL，后续同尺寸请求不再重复转换；转码失败时 HEIC 回退到预转 JPEG 预览（而不是浏览器显示不了的原图）
- **前端直连缩略图，跳过 302**：缩略图在 PREVIEWS 里的 key 是完全确定的（`thumbs/{w}/{原key去扩展名}.webp`），所以照片墙和胶片卷直接拼最终地址，不再每张图先请求 `/thumb/` 再跟一次重定向——一屏几十张就是省掉几十次往返和几十个 Worker 请求。地址由 `window.PREVIEWS_BASE`（worker 注入首页）拼出，算法必须和 `handleThumb` 逐字一致；缩略图还没生成时直连是 404，前端 `onerror` 回落到 `/thumb/` 由它现场生成，所以只有"从没被看过的照片"才会退化成原来的两跳
- 页面 CSS/JS 由 Cloudflare Static Assets 托管，Worker 只处理动态路由
- **零境外 CDN 依赖**：Space Grotesk 字体自托管（可变字体单个 latin 子集 woff2，22KB 覆盖 400-600 字重）；heic2any（1.3MB）也在 `public/vendor/` 自托管且**懒加载**——只在"服务端转码缺失 + 缩略图加载失败"的兜底路径第一次被走到时才动态注入
- AI 打分、查地点、HEIC 转码、索引回填等批量后台处理走 **Cron 定时任务**，跟用户访问完全分开

### AI 选片 + 文案
- 接入 Workers AI（`@cf/llava-hf/llava-1.5-7b-hf`），给每张照片打：1-10 分、是否有人脸、一句中文文案（展示在灯箱大图下方）
- 文案没有中文字符时自动过一遍 `@cf/meta/m2m100-1.2b` 翻译成中文
- HEIC 喂给视觉模型前必须先转 JPEG——优先复用已生成的预览图，没有的话现场解码一次
- 某一年照片超过 10 张时自动精选：视频/Live Photo → 带 GPS + 人脸的"真实拍摄"照片（按分数）→ 其他已打分照片 → 未打分的按时间均匀抽样，其余折进"展开查看全部"

### 拍摄地点 + 足迹地图
- 从 EXIF 解析 GPS 坐标（JPEG/HEIC 都支持），Mapbox Geocoding 反向地理编码成地名
- `/map` 页面是 **3D 地球**（Mapbox GL globe 投影 + 星空大气层）：
  - 不带参数 = 全量足迹模式，整个照片库的带坐标照片打点
  - 带 `?month=&day=` = 单天模式（从"那年今日"跳过来）
  - 原生 GeoJSON 聚合（cluster），聚合圈点击弹"附近有 N 张照片"缩略图九宫格，单点点击弹照片详情卡（图 + 地点·日期 + 设备/坐标/海拔），点图跳回那一天

### 后台任务（Cron）
- `*/10 * * * *`：维护任务——新照片聚合推送、索引回填（完成后降频）、存量日期重算（完成后跳过）、AI 打分、查地点、HEIC 转码
- `0 16 * * *`：北京时间零点，当天精选推送 Telegram
- 打分/查地点候选**在 SQL 侧用 LEFT JOIN 直接筛选**（`findUnscoredKeys` / `findUnlocatedKeys`），不再把整张表读进内存过滤；优先处理"服务器真实的今天" + "最近有人在看的那一天"
- 索引回填（`listAll` 大数组）跟日期重算/HEIC 转码按分钟单双错峰跑，保证吃内存大户永远不同时出现

### 前端体验
- 宝丽来风格错落"回忆墙"：随机尺寸 + 轻微倾斜 + 挂绳图钉效果，悬停指尖联动倾斜（触屏设备自动禁用 3D 倾斜，避免 tap 合成事件导致比例错乱）
- 灯箱预览：左右切换、键盘方向键、ESC 关闭、移动端滑动手势、双指缩放 + 拖动平移看细节（桌面端鼠标拖动同样支持）
- **灯箱详情面板**：EXIF（设备/参数/海拔）、拍摄地点迷你地图（点击跳足迹地图）、直方图、照片手记，顶栏 ⓘ 开关——**触屏设备默认收起**（iPad 上 390px 侧栏会把照片挤小），手机上以全屏浮层展开
- "播放回忆"自动全屏幻灯片，多种随机转场
- "唤醒林间"开关：暖色光斑 + 林间环境音，切换有阳光扫过的过渡动画
- 自制日历选择器 + 公/农历法滑块（迷你分段滑块：公历白片、农历金片，浅色模式深色轨道）
- 骨架屏过渡、缩略图退避重试（5s/15s/45s）、视频 IntersectionObserver 懒加载
- 副标题下"今日诗词"（jinrishici.com），按北京时间日期存 D1，第三方接口挂了不影响主页面
- 移动端：缩略图分辨率按视口 × DPR 计算、`env(safe-area-inset-*)` 适配刘海屏、iOS 缩放横向偏移自动恢复

## 目录结构

```
worker.js               # Worker 全部逻辑（API + 图片代理 + AI 打分 + 地图/最爱/放映页 HTML + DO + Workflow，单文件）
public/index.html       # 主页面静态 HTML
public/app.css          # 主页面样式
public/app.js           # 主页面交互（日期切换、灯箱、Live Photo、实时表态、搜索、手记等）
public/map.css          # 足迹地图页样式
public/map.js           # 足迹地图页交互（3D 地球、聚合、照片卡）
public/manifest.json    # PWA manifest
public/vendor/          # 自托管第三方资源（Space Grotesk 字体、heic2any）
public/favicon.ico      # 站点图标（标签页 favicon，多尺寸 ico）
public/favicon.svg      # 矢量图标（manifest 兜底）
schema.sql              # D1 数据库表结构
wrangler.toml           # Cloudflare 部署配置（Static Assets、R2、AI、Images、D1、KV、Queue、Workflow、DO、Cron）
.github/workflows/deploy.yml  # GitHub Actions 自动部署（push master 触发）
node-shims.js           # 本地/打包环境需要时的 Node 兼容占位
package.json            # 锁定 wrangler 版本（devDependencies）
```

## 数据约定

R2 桶里照片需按以下路径存放：

```
Photos/MobileBackup/iPhone/{年}/{月}/{文件名}
```

月份目录下不需要再按天分文件夹，靠文件名或 EXIF 判断具体日期。

元数据都存在 **D1**（`memories-db`）：

- `photos_index (key, type, year, month, day, size, uploaded, width, height, updated_at)` —— 照片/视频索引，R2 Event Notification 增量维护；`width`/`height` 是等比缩略图的像素尺寸，用于前端占位比例
- `photo_scores (key, score, has_face, caption, raw_response, updated_at)` —— AI 打分/文案结果
- `photo_places (key, lat, lon, name)` —— 反向地理编码结果
- `photo_reactions (key, emoji, count)` —— 表态计数镜像（权威数据在 DO Storage，这张表供"全家最爱"跨日期聚合）
- `photo_notes (key, note, updated_at)` —— 照片手记
- `meta (key, value)` —— 杂项：`poem:*`（每日诗词）、`notify:*`（待聚合的新照片推送队列）

全局轻量状态存 **Workers KV**（比 D1 meta 表更轻，全球复制读取快）：`jinrishici-token`（今日诗词 API token）、`last_viewed_day`（最近浏览的日期）、`backfill_done_at`（回填完成标记）、`reindex_dates_offset` / `reindex_dates_done_at`（存量日期重算进度/完成标记）

## 部署

### 自动部署（推荐）

push 到 `master` 即触发 GitHub Actions（`.github/workflows/deploy.yml`）：语法检查 → **打包体积门禁**（`wrangler deploy --dry-run` 先打包，gzip 超 1MB 预警线直接拦下——付费版硬限制 10MB，当前实际约 30KB，防的是误引入大依赖）→ `wrangler deploy` → 同步 secrets。需要在仓库 Settings → Secrets 配置：

- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
- `ADMIN_TOKEN` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`（部署后自动注入为 Worker Secret）

三个踩过的坑，改 workflow 前务必知道：

1. **wrangler 版本必须锁 4.x**（`wranglerVersion` + package.json 双处锁定）——wrangler-action 自带的 3.90 不认识 `[images]` 配置段，只警告不报错，部署出来的 Worker 会**静默丢掉 IMAGES 绑定**，缩略图全挂
2. **Node ≥ 24**——wrangler 4.107 在 Node 20 上直接退出
3. **不要同时启用 Cloudflare Build（Git 连接）和 GitHub Actions**——两边都监听 master 会互相竞态：构建慢的一方后完成会用旧版本覆盖新部署；Cloudflare Build 的"非生产分支构建"还会上传未部署版本，导致 Actions 的 secrets 同步被 10215 拒绝。二选一，只留一条部署路径

### 手动部署（首次初始化）

1. 安装并登录 wrangler：

   ```bash
   npm install
   npx wrangler login
   ```

2. 创建 D1 数据库并应用表结构：

   ```bash
   npx wrangler d1 create memories-db
   # 把输出的 database_id 填进 wrangler.toml 的 [[d1_databases]]
   npx wrangler d1 execute memories-db --remote --file ./schema.sql
   ```

3. 创建队列、配好 R2 事件通知：

   ```bash
   npx wrangler queues create photo-index-queue
   npx wrangler r2 bucket notification create <你的照片桶名> --event-type object-create --queue photo-index-queue --prefix "Photos/MobileBackup/iPhone/"
   npx wrangler r2 bucket notification create <你的照片桶名> --event-type object-delete --queue photo-index-queue --prefix "Photos/MobileBackup/iPhone/"
   ```

4. 创建 KV namespace（存全局轻量状态）：

   ```bash
   npx wrangler kv namespace create MEMORIES_KV
   # 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
   ```

   走 GitHub Actions 部署的话这步可以跳过——workflow 里有自动供给：`wrangler.toml` 的 id 还是
   `REPLACE_WITH_KV_NAMESPACE_ID` 占位符时，CI 会先查同名 namespace（没有才创建），把 id 注入
   本次构建（幂等，不改仓库文件）。前提是 `CLOUDFLARE_API_TOKEN` 带 **Workers KV Storage:Edit** 权限

5. 编辑 `wrangler.toml`：
   - `PHOTOS` 绑定的 `bucket_name` 改成你存原图的 R2 桶名；`PREVIEWS` 指向另一个单独的桶（存 HEIC 预览和 WebP 缩略图），建议配 7 天生命周期规则
   - `routes` 改成你的自定义域名；`PREVIEWS_PUBLIC_URL` 改成预览桶的公开访问域名
   - `[[d1_databases]]` 的 `database_id` 换成第 2 步创建出来的 ID
   - `MAPBOX_PUBLIC_TOKEN` 必须是 public token（`pk.` 开头）；反向地理编码用的 secret token 用 `npx wrangler secret put MAPBOX_TOKEN` 单独存，创建时勾上 **Geocoding** 权限
   - `ADMIN_TOKEN` 等敏感值一律 `npx wrangler secret put`，**不要写进 wrangler.toml**

6. 部署并回填存量：

   ```bash
   npx wrangler deploy
   curl "https://你的域名/admin/backfill-photos-index?token=xxx&limit=200"   # 反复跑到 remaining=0
   ```

## 鉴权

本项目本身不做登录鉴权，建议用 **Cloudflare Zero Trust Access** 在边缘层拦截：

1. Zero Trust → Access → Applications → Add an application → Self-hosted
2. 域名填 Worker 绑定的自定义域名
3. 策略比如只允许自己的邮箱；分享给家人可以用 "One-time PIN"——邮箱收验证码登录即可
4. 启用 Access 后实时房间会用 `Cf-Access-Authenticated-User-Email` 识别身份（在线列表显示 Gravatar 头像）；PWA 的 manifest 请求已带 `use-credentials` 兼容 Access，无需额外放行

## API

### 页面

| 路径 | 说明 |
|------|------|
| `/` | 回忆墙主页，支持 `?month=06&day=27` 指定日期 |
| `/map` | 足迹地图（3D 地球）：不带参数=全库足迹，带 `?month=&day=`=单天 |
| `/loved` | 全家最爱——表态最多的照片排行 |
| `/recap` | 年度回忆放映，支持 `?year=2023` |

### 数据接口

| 路径 | 说明 |
|------|------|
| `GET /api/memories?month=MM&day=DD&lunar=1` | 历年同日照片列表；`lunar=1` 时附带农历同日段落（`data.lunar.years`） |
| `GET /api/map-photos?month=MM&day=DD` | 带坐标照片列表；不带参数返回全库 |
| `GET /api/exif?key=...` | 单张照片 EXIF（设备、参数、GPS、海拔） |
| `GET /api/search?q=...` | 搜 AI 文案和拍摄地名 |
| `GET /api/note?key=...` / `POST /api/note` | 读/写照片手记 |
| `GET /api/top-loved` | 表态聚合排行（5 分钟边缘缓存） |
| `GET /api/recap?year=YYYY` | 某年评分最高的 40 张（放映数据源） |
| `GET /api/poem` | 今日诗词（jinrishici.com，D1 按北京日期缓存，挂了返回 204） |
| `GET /api/onthisday?month=MM&day=DD` | 历史上的今天（Wikimedia，中文优先英文兜底，边缘缓存 7 天，挂了返回 204） |
| `GET /api/static-map?lat=&lng=` | 拍摄地点迷你地图（Mapbox Static） |
| `WS /api/room/{MM-DD}` | 实时房间 WebSocket（在线人数 + 表态） |
| `GET /img/{key}?dl=1` | 图片/视频代理；`dl=1` 触发下载 |
| `GET /thumb/{key}?w=&h=&fit=` | WebP 缩略图（Images binding 转换 + PREVIEWS 桶缓存 + 302） |
| `GET /og-image?month=&day=` | OG 分享卡片图 |
| `GET /app-icon?size=180` | PWA 应用图标（全库最高分照片裁方形） |
| `POST /api/upload-heic-preview?key=...` | 浏览器端 heic2any 解码结果回传（校验 magic bytes，≤10MB） |

### 管理端点（需 `?token=` 匹配 `ADMIN_TOKEN`）

| 路径 | 说明 |
|------|------|
| `GET /admin/score-photos?limit=5` | 批量 AI 打分，反复调到 `remaining=0` |
| `GET /admin/locate-photos?limit=10` | 批量查拍摄地点 |
| `GET /admin/convert-heic-photos?limit=3` | 批量 HEIC 转 JPEG 预览 |
| `GET /admin/backfill-photos-index?limit=200` | 存量文件回填进 photos_index |
| `GET /admin/backfill-photo-dims?limit=50&after=` | 存量照片回填缩略图宽高（只读已有缩略图，不触发转换）|
| `GET /admin/reindex-photo-dates?limit=200&offset=0` | 按新规则重算存量索引行的年月日（Cron 会自动跑，此端点用于手动加速；按返回的 `nextOffset` 翻页，`null` 表示扫完） |
| `GET /admin/backfill-workflows?limit=20` | 历史积压照片批量触发 Workflow（转码+打分一条龙） |
| `GET /admin/purge-cache?month=MM&day=DD` | 手动清某天的边缘缓存 |
| `GET /admin/test-telegram` | 手动触发一次 Telegram 每日推送 |

## HEIC 照片

浏览器原生大多解不开 HEIC，项目准备了服务端 + 浏览器端多条兜底链路：

- `/thumb/` 优先用 Cloudflare Images binding（原生支持 HEIC 输入）转 WebP 写入 `PREVIEWS` 桶；转换失败（如 Transformations 额度用完）时回退到预转的 JPEG 预览，再不行才回原图，且失败原因会打进日志
- AI 打分前优先复用预览图，没有再现场解码一次
- 前端 heic2any 做最后兜底（懒加载，只在需要时注入）：解码成功后回传 `/api/upload-heic-preview` 存进 `PREVIEWS` 桶，后续访问者不用再解码
- 服务端解码用 `libheif-js` wasm 构建，必须用 `new WebAssembly.Instance()`（同步 API）——异步 API 会打断 embind 类注册报 `overloadTable` 错误
- 转码失败按重试次数（R2 自定义元数据）最多自动重试 5 次；浏览器端解码成功不占这个名额
- 历史 HEIC 批量补：`GET /admin/backfill-workflows?token=xxx&limit=20`

## 已知限制

- HEIC 的 EXIF 解析是手写的 ISOBMFF box 解析，非典型编码的文件可能解析失败，会静默回退到 R2 上传时间近似
- 未做存储层访问控制，必须配合 Cloudflare Access 或同等方案保护隐私
- AI 打分、反向地理编码、Images 转换都可能产生超出免费额度的费用；Images 免费额度是每月 5000 次**独立**变换（同图同尺寸只算一次，结果永久缓存在 PREVIEWS 桶），首次填充大库时容易超
- Mapbox secret token 创建时要勾 **Geocoding** 权限，没勾会一直 403
- 表态的 D1 镜像从房间首次被访问时才回填——完全没人再打开过的日期，其照片的历史表态暂时不会出现在"全家最爱"里
