# 接口参考

整站挡在 Cloudflare Access 后面，下列接口都需要先通过 Access 认证。

## 页面

| 路径 | 说明 |
|------|------|
| `/` | 回忆墙主页，支持 `?month=06&day=27` 指定日期 |
| `/map` | 足迹地图（3D 地球）：不带参数=全库足迹，带 `?month=&day=`=单天 |
| `/loved` | 全家最爱——表态最多的照片排行 |
| `/recap` | 年度回忆放映，支持 `?year=2023` |

## 数据接口

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

## 管理端点

不再单独校验 token——整站已经挡在 Cloudflare Access 后面，管理端点跟其它接口同一道门。
（历史上这里要求 `?token=` 匹配 `ADMIN_TOKEN`，那套校验已经从 worker.js 里移除了。）
日常运维优先用运维控制台 `/admin/ops`，见 [OPERATIONS.md](../OPERATIONS.md)。

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
