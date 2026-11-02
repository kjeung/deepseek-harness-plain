#!/usr/bin/env bash
# Sync the plain-HTTP fork with upstream 1Panel-dev/runtime and refresh the
# deployment snapshot (compose/docs/patches repository).
#
# Workflow (see SYNC-UPSTREAM.md):
#   upstream dev  ──rebase──▶  plain-http (fork: kjeung/runtime)
#                                   │
#                                   └─ snapshot ─▶ deployment repo runtime/ + patches/
#
# Usage:
#   scripts/sync-upstream.sh                       # fetch + rebase + tests + export patches
#   scripts/sync-upstream.sh --repo ../dsh-plain   # also refresh that deployment clone
#   scripts/sync-upstream.sh --repo ../dsh-plain --push
#   scripts/sync-upstream.sh --skip-tests
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/runtime"
INVOCATION_DIR="$PWD"
DEPLOY_REPO=""
PUSH=0
TESTS=1

die() { printf 'sync-upstream: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }

while (($#)); do
  case "$1" in
    --repo)
      DEPLOY_REPO="${2:?--repo 需要一个路径}"
      # Resolve against where the user invoked the script, not runtime/.
      [[ -d "$INVOCATION_DIR/$DEPLOY_REPO" ]] || die "--repo 目录不存在: $DEPLOY_REPO"
      DEPLOY_REPO="$(cd "$INVOCATION_DIR/$DEPLOY_REPO" && pwd)"
      shift 2
      ;;
    --push) PUSH=1; shift ;;
    --skip-tests) TESTS=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -d "$RUNTIME_DIR/.git" ]] || die "runtime/ 不是 git 仓库（见 README「快速开始」）"
[[ -d "$RUNTIME_DIR/.git/rebase-merge" || -d "$RUNTIME_DIR/.git/rebase-apply" ]] && \
  die "runtime/ 有未完成的 rebase，请先解决冲突并 git rebase --continue"

cd "$RUNTIME_DIR"

say "拉取 upstream 与 origin"
git fetch --quiet upstream dev
git fetch --quiet origin
UPSTREAM_SHA="$(git rev-parse upstream/dev)"
BASE_SHORT="$(git rev-parse --short "$UPSTREAM_SHA")"
echo "upstream/dev = $UPSTREAM_SHA"

[[ "$(git rev-parse --abbrev-ref HEAD)" == "plain-http" ]] || git switch plain-http

if git merge-base --is-ancestor "$UPSTREAM_SHA" HEAD; then
  say "plain-http 已包含 upstream/dev，无需 rebase"
else
  say "rebase plain-http 到 upstream/dev"
  if ! git rebase "$UPSTREAM_SHA"; then
    cat >&2 <<'EOF'

rebase 冲突，请手动解决后重新运行本脚本：
  1) cd runtime && git status                     # 看冲突文件
  2) 解决冲突（我们改动集中在 5 个文件）：
       deepseek-harness/Dockerfile
       deepseek-harness/docker-entrypoint.sh
       deepseek-harness/test-runtime.mjs
       deepseek-harness/patch-dsh-authenticated-settings.mjs
       .github/workflows/deepseek-harness-release.yml
     注意：Caddyfile 在本分支已被删除；上游若修改它，确认删除仍然成立。
  3) git add <files> && git rebase --continue
  4) 重新执行 scripts/sync-upstream.sh
EOF
    exit 1
  fi
fi

# --- 版本提示：上游 workflow 默认的 dsh 版本 vs 本仓库 compose 默认 ---
WF="$RUNTIME_DIR/.github/workflows/deepseek-harness-release.yml"
UP_DSH="$(grep -m1 'default: "' "$WF" | sed 's/.*default: "//; s/".*//')"
COMPOSE_DSH="$(sed -n 's/.*DSH_VERSION:-\{0,1\}\([0-9][^}  ]*\).*/\1/p' "$ROOT/docker-compose.yml" | head -1)"
if [[ -n "$UP_DSH" && -n "$COMPOSE_DSH" && "$UP_DSH" != "$COMPOSE_DSH" ]]; then
  printf '\n⚠ 版本不一致：上游 workflow 默认 dsh=%s，compose 默认=%s\n' "$UP_DSH" "$COMPOSE_DSH"
  printf '  升级 dsh 版本前请先看 SYNC-UPSTREAM.md 的「dsh 版本升级」清单。\n'
fi

if ((TESTS)); then
  say "自检"
  node --check deepseek-harness/node-proxy.mjs
  node deepseek-harness/node-proxy.mjs --self-test
  bash deepseek-harness/docker-entrypoint.sh --self-test
  if [[ -d /usr/local/lib/node_modules/@deepseek-ai/dsh ]]; then
    say "代理测试套件（14 个用例）"
    DSH_PROXY_BIN="$RUNTIME_DIR/deepseek-harness/node-proxy.mjs" \
      node --test --test-name-pattern='proxy|healthz|SIGTERM' \
        deepseek-harness/test-runtime.mjs
  else
    echo "跳过代理测试：本机没有安装 @deepseek-ai/dsh（镜像构建期会跑完整测试）"
  fi
fi

say "导出补丁与 bundle（相对 upstream/dev）"
rm -f "$ROOT"/patches/*.patch "$ROOT"/patches/*.bundle
git format-patch "upstream/dev..HEAD" --output-directory "$ROOT/patches" >/dev/null
git bundle create "$ROOT/patches/plain-http.bundle" "upstream/dev..HEAD" >/dev/null
printf '%s\n' "$UPSTREAM_SHA" > "$ROOT/patches/BASE"
echo "baseline -> patches/BASE（$UPSTREAM_SHA）"
ls -1 "$ROOT/patches"

if [[ -n "$DEPLOY_REPO" ]]; then
  say "刷新部署仓库快照：$DEPLOY_REPO"
  [[ -d "$DEPLOY_REPO/.git" ]] || die "--repo 不是 git 仓库: $DEPLOY_REPO"
  rsync -a --delete --exclude '.git' "$RUNTIME_DIR/" "$DEPLOY_REPO/runtime/"
  cp "$ROOT"/patches/*.patch "$ROOT"/patches/plain-http.bundle "$DEPLOY_REPO/patches/"
  cp "$ROOT/patches/BASE" "$DEPLOY_REPO/patches/BASE"
  for f in scripts/sync-upstream.sh SYNC-UPSTREAM.md; do
    [[ -f "$ROOT/$f" ]] || continue
    mkdir -p "$DEPLOY_REPO/$(dirname "$f")"
    cp "$ROOT/$f" "$DEPLOY_REPO/$f"
  done
  ( cd "$DEPLOY_REPO" && git add -A && \
    git commit -q -m "sync: upstream runtime@$BASE_SHORT" && \
    echo "已提交: $(git log --oneline -1)" )
else
  echo "未指定 --repo：只更新本目录 runtime/ 与 patches/"
fi

if ((PUSH)); then
  say "推送到 fork：origin/plain-http"
  git push --force-with-lease origin plain-http
  if [[ -n "$DEPLOY_REPO" ]]; then
    say "推送部署仓库"
    ( cd "$DEPLOY_REPO" && git push )
  fi
fi

say "完成"
printf 'upstream/dev : %s\n' "$UPSTREAM_SHA"
printf 'plain-http   : %s\n' "$(git rev-parse --short HEAD)"
printf 'patches/BASE : %s\n' "$(cat "$ROOT/patches/BASE")"
