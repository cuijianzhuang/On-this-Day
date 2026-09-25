#!/usr/bin/env bash
# 部署前自检：把 CI 里会拦下部署的检查搬到本地先跑一遍。
#
# 为什么要有这个脚本：这个项目的部署是 push master 自动触发的，一旦 CI 拦下来，
# 你已经把提交推上去了——要么带着红叉，要么再推一个修复提交。先在本地跑一遍，
# 语法错误和体积异常在推之前就能发现。
#
#   bash scripts/preflight.sh
#
# 退出码 0 = 可以推；非 0 = 有问题，输出里写了是哪一项。

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo "[1/5] 语法检查"
for f in worker.js $(find src -name "*.js" | sort) public/app.js public/map.js; do
  if node --check "$f" 2>/dev/null; then ok "$f"; else bad "$f 语法错误：$(node --check "$f" 2>&1 | head -3)"; fi
done

echo "[2/5] 单元测试"
# 农历换算、EXIF 解析、文件名日期这些纯函数决定了"照片落在哪一天"，
# 错了不会报错，只会让照片悄悄出现在错误的日期上——这类 bug 只有测试拦得住
if test_out=$(npm test --silent 2>&1); then
  ok "$(printf '%s\n' "$test_out" | grep -E '^# pass' | sed 's/^# pass /通过 /') 项$(printf '%s\n' "$test_out" | grep -E '^# todo [1-9]' | sed 's/^# todo /（另有 /; s/$/ 项待办）/')"
else
  bad "单元测试失败："
  printf '%s\n' "$test_out" | grep -E '^not ok|^# fail' | grep -v '# TODO' | sed 's/^/      /'
fi

echo "[3/5] wrangler.toml 占位符"
# CI 里 KV 占位符会被自动替换，其余占位符没人管——带着占位符部署出去的是个连不上
# 自己资源的 Worker，页面全 500，比部署失败还难查
if placeholders=$(grep -n 'REPLACE_WITH_[A-Z_]*' wrangler.toml); then
  while IFS= read -r line; do
    if printf '%s' "$line" | grep -q 'REPLACE_WITH_KV_NAMESPACE_ID'; then
      warn "wrangler.toml:${line%%:*} KV 占位符（CI 会自动供给，本地 wrangler deploy 会失败）"
    else
      bad "wrangler.toml:${line%%:*} 未替换的占位符：$(printf '%s' "$line" | grep -o 'REPLACE_WITH_[A-Z_]*')"
    fi
  done <<< "$placeholders"
else
  ok "无未替换占位符"
fi

echo "[4/5] wrangler 版本一致性"
# 两处版本必须一致。wrangler-action 自带的 3.x 不认识 [images] 配置段，只警告不报错，
# 部署出来的 Worker 会静默丢掉 IMAGES 绑定——缩略图全挂，而且部署是"成功"的
pkg_ver=$(node -p "require('./package.json').devDependencies.wrangler" 2>/dev/null | tr -d '^~')
ci_ver=$(grep -o 'wranglerVersion: *"[^"]*"' .github/workflows/deploy.yml | grep -o '[0-9][0-9.]*')
if [ -n "$pkg_ver" ] && [ "$pkg_ver" = "$ci_ver" ]; then
  ok "package.json 与 workflow 都是 $pkg_ver"
else
  bad "版本不一致：package.json=$pkg_ver workflow=$ci_ver（改一处必须同步改另一处）"
fi

echo "[5/5] 打包体积门禁（gzip ≤ 1MB）"
# 付费版硬限制是 gzip 10MB，这里卡 1/10 当预警线：真正要防的是误引入一个大 npm 依赖，
# 等逼近 10MB 才发现就晚了。public/ 走 Static Assets，不计入这个体积
if ! command -v npx >/dev/null 2>&1; then
  warn "找不到 npx，跳过（装好 Node 后重跑）"
elif [ ! -d node_modules ]; then
  warn "node_modules 不存在，先跑 npm install 再重跑这一项"
else
  out=$(mktemp -d)
  if npx --no-install wrangler deploy --dry-run --outdir "$out" >/dev/null 2>&1; then
    size=$(gzip -c "$out/worker.js" | wc -c | tr -d ' ')
    if [ "$size" -gt 1048576 ]; then
      bad "打包后 gzip ${size}B（$((size / 1024)) KiB）超过 1MB 预警线"
    else
      ok "打包后 gzip $((size / 1024)) KiB"
    fi
  else
    warn "wrangler dry-run 失败（多半是本地没登录或占位符未替换），这项以 CI 为准"
  fi
  rm -rf "$out"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "预检通过，可以 push。"
else
  echo "预检未通过，修完再 push。"
fi
exit "$fail"
