---
name: deploy
description: 部署「那年今日」到 Cloudflare Workers——日常部署（push master 触发 GitHub Actions）、部署前本地预检、部署后验证、回滚，以及从零或 fork 的首次资源初始化（D1 / KV / R2 / Queue / 事件通知 / secrets）。只要用户提到部署、上线、发布、deploy、推上去、CI 挂了、Actions 红了、wrangler 报错、回滚、Worker 没更新、代码改了线上没生效、缩略图突然全挂、绑定丢了、换账号重建、首次配置，就用这个 skill；用户只说「能上线吗」「为什么没生效」「怎么发布」这类没点名部署的说法时同样适用。
---

# 部署「那年今日」

这个项目**只有一条部署路径**：push 到 `master` → GitHub Actions
(`.github/workflows/deploy.yml`) → `wrangler deploy`。没有手动部署环节，
本地 `npx wrangler deploy` 只在首次初始化和救火时才用。

先判断用户处在哪种情况，再往下走：

| 情况 | 去哪一节 |
|---|---|
| 改完代码要上线 | 「日常部署」 |
| Actions 红了 / 部署失败 | 「部署失败速查」 |
| 部署成功但线上没变化 | 「线上没生效速查」 |
| 要撤回刚上线的改动 | 「回滚」 |
| 全新账号 / fork / 灾难重建 | 读 `references/first-deploy.md` |

## 日常部署

### 1. 推之前先本地预检

```bash
bash scripts/preflight.sh
```

这一步跑的是 CI 里会拦下部署的同一批检查（语法、单元测试、wrangler.toml 占位符、
wrangler 版本一致性、打包 gzip 体积）。**值得先跑**：部署是 push 触发的，
等 CI 拦下来时提交已经在 master 上了，只能再推一个修复提交。

预检报错就先修，别推。它不通过而你仍想推，说明预检规则本身需要改。

### 2. 推

```bash
git push origin master
```

Actions 会自动跑。也可以在仓库 Actions 页面点 **Run workflow** 手动触发一次
（`workflow_dispatch`），用于「代码没变但想重新部署一遍」——比如改了 GitHub Secrets 之后。

### 3. 确认部署结果

用 GitHub MCP 工具查 `deploy.yml` 最近一次 run 的 `conclusion`。正常在 40 秒左右完成。

**不要只看 workflow 绿了就算完。** 这个项目有一类失败是"部署成功但东西是坏的"
（见下面的 IMAGES 绑定丢失），workflow 照样绿。改动涉及 worker.js 的绑定、
wrangler.toml、或缩略图链路时，顺手开一下线上页面看缩略图是否正常。

## 部署失败速查

先用 GitHub MCP 拉失败 job 的日志，再对照这张表：

| 日志里的症状 | 原因 / 处理 |
|---|---|
| `node --check` 失败 | 语法错误。本地 `bash scripts/preflight.sh` 复现后修掉 |
| `Unit tests` 失败 | `npm test` 本地复现。农历表相关的失败别急着改夹具——`test/fixtures/lunar-months.txt` 是外部参照（独立库 + 天文合朔校正），它和代码不一致时，先怀疑代码 |
| `Worker 打包后 gzip ... 超过 1MB 预警线` | 多半是误引入了大 npm 依赖。查 `package.json` 新增项；确实需要就调整门禁阈值，但先确认不是误引入 |
| `error 10211` / DO migrations 相关 | 必须走 `wrangler deploy`，不能用 `versions upload`。workflow 里 `command: deploy` 就是为这个锁的，别改 |
| `error 10215`（拒绝改 secret） | Cloudflare Build 的 Git 连接传了未部署版本。secrets 同步那步是 `continue-on-error`，不影响本次部署正确性。根治办法是断开 Cloudflare Build 的 Git 连接（见下） |
| `KV namespace 创建/查询失败` | API Token 缺 **Workers KV Storage:Edit** 权限 |
| wrangler 提示 Node 版本 | wrangler 4.107 要求 Node ≥ 22，workflow 锁的是 24。本地复现时先升 Node |

## 线上没生效速查

| 症状 | 原因 / 处理 |
|---|---|
| 部署绿了但线上还是旧代码 | **同时启用了 Cloudflare Build（Git 连接）和 GitHub Actions**。两边都监听 master，慢的一方后完成会用旧版本覆盖新部署。二选一，只留 Actions，去 Cloudflare 控制台断开 Worker 的 Git 连接 |
| 缩略图全挂 / `env.IMAGES` undefined | wrangler 版本掉回 3.x。3.90 不认识 `[images]` 配置段，只警告不报错，部署出来的 Worker **静默丢掉 IMAGES 绑定**。`wranglerVersion`（workflow）和 `devDependencies.wrangler`（package.json）必须都是 4.x 且一致——preflight 第 3 项查的就是这个 |
| 页面数据是旧的 | 是边缘缓存，不是部署问题。响应头 `x-edge-cache: HIT` 就是命中了缓存；去 `/admin/ops` 清那一天的缓存（见 OPERATIONS.md） |
| 新增的 secret 读不到 | secrets 只在 deploy 之后那一步同步，且 `MAPBOX_TOKEN` 根本不在同步列表里（见下） |

## Secrets

CI 会从 GitHub Secrets 同步到 Worker 的，只有这两个：

- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` —— 每日推送用，不配就是不推送，不影响主站

**不经过 CI、必须手动设一次的：**

```bash
npx wrangler secret put MAPBOX_TOKEN    # 反向地理编码用，创建时必须勾 Geocoding 权限，没勾会一直 403
```

这是个容易踩的坑：`MAPBOX_TOKEN` 是 secret（不同于 wrangler.toml 里那个公开的
`MAPBOX_PUBLIC_TOKEN`），但它不在 workflow 的同步列表里，换账号重建时很容易漏掉，
表现是地图有点、照片没有地名。

`ADMIN_TOKEN` 已经废弃——worker.js 里一处都不再读它（整站挡在 Cloudflare Access
后面，管理端点不再单独校验 token）。不需要为它配任何东西。

## 回滚

Cloudflare 侧回滚最快：控制台 → Workers → `memories-today` → Deployments →
选上一个版本 → Rollback。立即生效，不用等 CI。

代码侧回滚（让仓库和线上一致，否则下次 push 又把问题带回去）：

```bash
git revert <出问题的提交>
git push origin master
```

**不要用 `git reset --hard` + force push 回滚 master**——那会让所有人的本地
checkout 失效，revert 是安全的做法。

数据层没有自动回滚。这个项目的迁移都是 `ensureAuxTables()` 里的
`ALTER TABLE ... ADD COLUMN`（加列，向后兼容），回滚代码不需要回滚数据库。
真要恢复数据用 D1 Time Travel（30 天）。

## 首次部署 / 重建

从零开始、fork 到自己账号、或者灾难重建，读
`references/first-deploy.md`——那里是完整的资源创建顺序（D1 → KV → R2 → Queue →
事件通知 → secrets → 首次部署 → 存量回填）和每个 wrangler.toml 字段要改成什么。

日常部署用不到那份文档，别提前读进来占上下文。
