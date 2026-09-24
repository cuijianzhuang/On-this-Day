# 那年今日 (On This Day)

一个跑在 Cloudflare Worker + R2 + D1 上的私人"时光相册"。每天打开都能看到历年同一天拍的
照片和视频，灵感来自 Apple Photos 的"回忆"功能。

照片放在自己的 R2 桶里，整站挡在 Cloudflare Access 后面，只有自己和家人能看。

## 亮点

- **公历 / 农历双历法**：顶栏滑块切换，农历模式按同一农历日反推历年对应的公历日期匹配照片
- **宝丽来风格回忆墙**：随机尺寸 + 轻微倾斜 + 图钉挂绳，鼠标经过时指尖联动倾斜
- **Live Photo**：自动配对同名的 HEIC/JPEG + MOV，长按带声播放（对齐苹果相册的交互）
- **实时共享**：家人同时打开同一天时显示在线人数，照片可发 emoji 表态，全员实时同步
- **AI 选片 + 文案**：Workers AI 给每张照片打分、判断有无人脸、生成一句中文文案；
  照片多的年份自动精选
- **足迹地图**：从 EXIF 解析 GPS，Mapbox 3D 地球上聚合打点
- **每日推送**：北京时间零点把当天精选推到 Telegram 群
- 还有：全家最爱排行、照片搜索、照片手记、年度回忆放映、今日诗词、历史上的今天、
  OG 分享卡片、PWA 可安装

每一项的实现细节和踩过的坑，见 [docs/architecture.md](docs/architecture.md)。

## 部署

日常部署是全自动的——**push 到 `master` 即触发 GitHub Actions**
（语法检查 → 打包体积门禁 → `wrangler deploy` → 同步 secrets）。

推之前建议先跑一遍本地预检，它跑的是 CI 里会拦下部署的同一批检查：

```bash
bash scripts/preflight.sh
```

| 场景 | 看哪里 |
|---|---|
| 全新账号 / fork / 灾难重建 | [首次部署指引](.claude/skills/deploy/references/first-deploy.md) |
| 部署失败、线上没生效、要回滚 | [部署 skill](.claude/skills/deploy/SKILL.md)（Claude Code 里直接问"部署失败了"即可） |
| 日常运维、数据修复 | [OPERATIONS.md](OPERATIONS.md) |

用 Claude Code 的话，仓库里带了一个 `deploy` skill——提到部署、上线、CI 挂了、
回滚之类的话题时会自动用上，不需要自己翻文档。

## 目录结构

```
worker.js               # Worker 全部逻辑（API + 图片代理 + AI 打分 + DO + Workflow，单文件）
public/                 # 静态资源（页面 HTML/CSS/JS、PWA manifest、自托管字体与 heic2any）
schema.sql              # D1 基础表结构（后加的列由 ensureAuxTables() 自动 ALTER 补上）
wrangler.toml           # Cloudflare 部署配置（Static Assets、R2、AI、Images、D1、KV、Queue、Workflow、DO、Cron）
scripts/preflight.sh    # 部署前本地自检
.github/workflows/      # GitHub Actions 自动部署
.claude/skills/deploy/  # 部署 skill（Claude Code 用）
docs/                   # 架构笔记、接口参考
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 各功能的实现细节、数据约定（R2 路径 / D1 表 / KV）、HEIC 兜底链路 |
| [docs/api.md](docs/api.md) | 页面路由、数据接口、管理端点 |
| [OPERATIONS.md](OPERATIONS.md) | 日常运维：运维控制台、命令行操作、常见故障处理 |
| [首次部署](.claude/skills/deploy/references/first-deploy.md) | 从零创建资源到首次上线的完整顺序 |

## 已知限制

- HEIC 的 EXIF 解析是手写的 ISOBMFF box 解析，非典型编码的文件可能解析失败，
  会静默回退到 R2 上传时间近似
- 未做存储层访问控制，**必须**配合 Cloudflare Access 或同等方案保护隐私
- AI 打分、反向地理编码、Images 转换都可能产生超出免费额度的费用；Images 免费额度是
  每月 5000 次**独立**变换（同图同尺寸只算一次，结果永久缓存在 PREVIEWS 桶），
  首次填充大库时容易超
- Mapbox secret token 创建时要勾 **Geocoding** 权限，没勾会一直 403
- 表态的 D1 镜像从房间首次被访问时才回填——完全没人再打开过的日期，其照片的历史表态
  暂时不会出现在"全家最爱"里
