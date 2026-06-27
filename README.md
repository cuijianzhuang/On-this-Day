# 那年今日 (On This Day)

一个跑在 Cloudflare Worker + R2 上的私人"时光相册"。每天打开都能看到历年同一天拍的照片和视频，灵感来自 Apple Photos 的"回忆"功能。

## 特性

- 自动按"今天的月/日"匹配历年照片，跨年份展示
- 支持文件名带日期（`IMG_20260627_141422.PNG`）和纯序号命名（`IMG_1017.JPG`）两种素材：
  - 带日期的直接按文件名匹配
  - 不带日期的，JPEG 读 EXIF `DateTimeOriginal`，其他格式回退用 R2 上传时间近似
- 用 Workers Cache API 缓存无日期文件名的拍摄日期推算结果，避免重复计算
- 图片/视频代理接口隐藏真实 R2 链接，支持 inline 预览和 `?dl=1` 下载两种模式
- 宝丽来风格错落"回忆墙"：随机尺寸 + 轻微倾斜
- 点击照片弹出灯箱预览，支持左右切换、键盘方向键、ESC 关闭
- "播放回忆"按钮：自动全屏幻灯片播放，多种随机转场效果（淡入淡出 / 缩放 / 左右滑动）
- 支持 URL 参数 `?month=06&day=27` 查看指定日期，不传则用浏览器本地日期
- 移动端做了响应式适配

## 目录结构

```
worker.js       # Worker 全部逻辑（API + 图片代理 + 前端页面，单文件）
wrangler.toml   # Cloudflare 部署配置（R2 绑定、路由）
```

## 数据约定

R2 桶里照片需按以下路径存放：

```
Photos/MobileBackup/iPhone/{年}/{月}/{文件名}
```

月份目录下不需要再按天分文件夹，靠文件名或 EXIF 判断具体日期。

## 部署

1. 安装并登录 wrangler：

   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. 编辑 `wrangler.toml`：
   - `bucket_name` 改成你的 R2 桶名
   - `routes` 里的 `pattern` / `zone_name` 改成你要绑定的自定义域名（该域名需已托管在 Cloudflare）

3. 部署：

   ```bash
   wrangler deploy
   ```

## 鉴权

本项目本身不做登录鉴权，建议用 **Cloudflare Zero Trust Access** 在边缘层拦截：

1. Cloudflare Dashboard → Zero Trust → Access → Applications → Add an application → Self-hosted
2. 域名填 Worker 绑定的自定义域名
3. 配置访问策略（如限定到你的邮箱）

## API

### `GET /api/memories?month=MM&day=DD`

返回指定月日在各年份下匹配到的照片/视频列表，按年份从新到旧排序。

```json
{
  "month": "06",
  "day": "27",
  "years": [
    {
      "year": "2023",
      "photos": [
        { "key": "...", "url": "/img/...", "type": "image", "size": 123, "uploaded": "..." }
      ]
    }
  ]
}
```

### `GET /img/{key}?dl=1`

图片/视频代理。不带 `dl` 参数时强制 `inline` 展示；带 `dl=1` 时返回 `Content-Disposition: attachment` 触发下载。

## 已知限制

- HEIC 格式暂未解析 EXIF，无日期文件名的 HEIC 文件用 R2 上传时间近似拍摄日期，可能有偏差
- 月份目录下文件较多且大量缺日期文件名时，首次访问会因逐个判断拍摄日期而变慢（命中缓存后会快很多）
- 未做存储层的访问控制，必须配合 Cloudflare Access 或同等方案保护隐私
