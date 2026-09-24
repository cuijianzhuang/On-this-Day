# 首次部署 / 从零重建

用于全新 Cloudflare 账号、fork 到自己账号、或者灾难重建。日常部署不需要这份文档。

整个过程的顺序是有依赖的：**先把资源建出来拿到 ID，填进 wrangler.toml，
才能部署**。跳步的话 `wrangler deploy` 会因为绑定指向不存在的资源而失败。

## 0. 前置

```bash
npm install
npx wrangler login
```

需要一个 Cloudflare 账号（Workers 免费版即可起步，但注意 Images Transformations
免费额度是每月 5000 次独立变换，首次填充大照片库容易超）。

## 1. R2：两个桶

```bash
npx wrangler r2 bucket create image             # 原图，唯一真数据源
npx wrangler r2 bucket create image-previews    # 派生物：WebP 缩略图、HEIC 预转、OG 图、应用图标
```

桶名可以自己取，取完要同步改 wrangler.toml 的 `bucket_name`。

`image-previews` 需要**开公开访问**并绑一个域名——前端现在直连这个域名取缩略图
（跳过 `/thumb/` 的 302）。拿到域名后填进 wrangler.toml 的 `PREVIEWS_PUBLIC_URL`。
建议给它配 7 天生命周期规则，派生物删了会自动重建。

原图桶按这个路径结构放照片：

```
Photos/MobileBackup/iPhone/{年}/{月}/{文件名}
```

月份目录下不用再按天分文件夹，具体日期靠文件名或 EXIF 判断。

## 2. D1

```bash
npx wrangler d1 create memories-db
# 输出里的 database_id 填进 wrangler.toml 的 [[d1_databases]]
npx wrangler d1 execute memories-db --remote --file ./schema.sql
```

schema.sql 建的是基础表。后来新增的列（比如 `photos_index.width/height`）由
运行时的 `ensureAuxTables()` 自动 `ALTER TABLE ADD COLUMN` 补上，不需要手工迁移。

## 3. KV

```bash
npx wrangler kv namespace create MEMORIES_KV
# 输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
```

走 GitHub Actions 部署的话这步可以跳过：wrangler.toml 里的 id 还是
`REPLACE_WITH_KV_NAMESPACE_ID` 占位符时，CI 会先查同名 namespace（没有才创建），
把 id 注入本次构建（幂等，不改仓库文件）。前提是 API Token 带
**Workers KV Storage:Edit** 权限。

## 4. Queue + R2 事件通知

```bash
npx wrangler queues create photo-index-queue

# 注意：通知规则绑在 R2 桶上，跟 wrangler.toml 无关，必须单独建，
# 而且 create/delete 两种事件都要建——只建 create 的话，删掉的照片会一直留在索引里
npx wrangler r2 bucket notification create image \
  --event-type object-create --queue photo-index-queue \
  --prefix "Photos/MobileBackup/iPhone/"
npx wrangler r2 bucket notification create image \
  --event-type object-delete --queue photo-index-queue \
  --prefix "Photos/MobileBackup/iPhone/"
```

## 5. 改 wrangler.toml

逐项对照改完，漏一项就是一个线上故障：

| 字段 | 改成 |
|---|---|
| `name` | 你的 Worker 名字 |
| `routes` | 你的自定义域名 + zone |
| `[[r2_buckets]]` PHOTOS `bucket_name` | 第 1 步的原图桶名 |
| `[[r2_buckets]]` PREVIEWS `bucket_name` | 第 1 步的预览桶名 |
| `[[d1_databases]]` `database_id` | 第 2 步的输出 |
| `[[kv_namespaces]]` `id` | 第 3 步的输出（或留占位符交给 CI） |
| `PREVIEWS_PUBLIC_URL` | 预览桶的公开域名，**不带结尾斜杠** |
| `MAPBOX_PUBLIC_TOKEN` | 你自己的 public token，必须 `pk.` 开头（这个会发到浏览器，可以提交） |

## 6. Secrets

```bash
npx wrangler secret put MAPBOX_TOKEN          # 反向地理编码，创建 token 时必须勾 Geocoding 权限
npx wrangler secret put TELEGRAM_BOT_TOKEN    # 可选，不配就是不推送
npx wrangler secret put TELEGRAM_CHAT_ID      # 可选
```

`ADMIN_TOKEN` 不需要——已废弃，worker.js 里不再读它。

## 7. 首次部署

```bash
bash scripts/preflight.sh
npx wrangler deploy
```

## 8. GitHub Actions（之后走自动部署）

仓库 Settings → Secrets and variables → Actions 配：

- `CLOUDFLARE_API_TOKEN` —— 权限至少要有 Workers Scripts:Edit、Workers KV Storage:Edit、
  D1:Edit、R2:Edit、Queues:Edit
- `CLOUDFLARE_ACCOUNT_ID`
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`（可选）

**不要同时启用 Cloudflare Build 的 Git 连接**。两边都监听 master 会互相竞态，
慢的一方后完成会用旧版本覆盖新部署；Cloudflare Build 的"非生产分支构建"还会上传
未部署版本，导致 Actions 的 secrets 同步被 10215 拒绝。只留 GitHub Actions 这一条路径。

## 9. 存量回填

照片已经在桶里、但索引是空的，需要把存量灌进去。反复调到 `remaining` / `nextKey` 归零：

```bash
curl "https://你的域名/admin/backfill-photos-index?limit=200"   # 反复跑到 remaining=0
curl "https://你的域名/admin/backfill-photo-dims?limit=50"      # 用返回的 nextKey 喂 &after= 继续，到 nextKey=null
```

不手动跑也行，Cron（每 15 分钟）会自己慢慢追上——只是首屏体验会差一阵子。
之后的日常运维看 `OPERATIONS.md`。

## 10. 鉴权（强烈建议）

项目本身不做登录鉴权，必须在边缘层挡一道，否则你的家庭照片是公开的：

1. Zero Trust → Access → Applications → Add an application → Self-hosted
2. 域名填 Worker 绑定的自定义域名
3. 策略比如只允许自己的邮箱；分享给家人用 One-time PIN（邮箱收验证码）
4. 启用后实时房间会用 `Cf-Access-Authenticated-User-Email` 识别身份、显示 Gravatar 头像；
   PWA manifest 请求已带 `use-credentials` 兼容 Access，不用额外放行
