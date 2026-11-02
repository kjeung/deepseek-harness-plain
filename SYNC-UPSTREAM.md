# 与上游同步（1Panel-dev/runtime）

本项目的源码来源有两条线，要分开维护：

```
1Panel-dev/runtime : dev ──(rebase)──▶ kjeung/runtime : plain-http   ← 镜像源码（带完整上游历史）
                                            │
                                            └──(快照同步)──▶ kjeung/deepseek-harness-plain : main
                                                             （compose/文档/patches/runtime 快照）
```

## 1. 一次性准备（已在本机完成）

```bash
# fork 上游（服务端创建，带完整历史；无需上传历史对象）
gh repo fork 1Panel-dev/runtime --clone=false          # -> kjeung/runtime
# 本地 runtime/ 的 remote 约定：
#   origin   = https://github.com/kjeung/runtime.git      （我们的 fork）
#   upstream = https://github.com/1Panel-dev/runtime.git  （上游）
```

## 2. 日常同步（推荐：一行脚本）

```bash
cd deployment
scripts/sync-upstream.sh                       # 只同步源码 + 导出补丁
scripts/sync-upstream.sh --repo ../dsh-plain   # 同时刷新部署仓库快照并提交
scripts/sync-upstream.sh --repo ../dsh-plain --push
```

脚本做的事：

1. `git fetch upstream dev` + `git fetch origin`；
2. 若上游前进：把 `plain-http` **rebase** 到 `upstream/dev`（冲突时停下并给出指引）；
3. 跑自检与 14 个代理测试（本机无 dsh 包时跳过，镜像构建期还会跑）；
4. 重新导出 `patches/*.patch` 与 `plain-http.bundle`，把新基线写入 `patches/BASE`；
5. `--repo` 指定部署仓库克隆时，用 `rsync` 同步 `runtime/` 快照、复制 patches、提交
   `sync: upstream runtime@<sha>`；
6. `--push`：`git push --force-with-lease origin plain-http`，并推送部署仓库。

脚本不会自动解决冲突，也**不会**自动改 `DSH_VERSION`。

## 3. 手动流程（等价，便于理解）

```bash
cd runtime
git fetch upstream dev
git switch plain-http
git rebase upstream/dev          # 冲突见第 4 节
# 自检 + 测试
node deepseek-harness/node-proxy.mjs --self-test
DSH_PROXY_BIN=$PWD/deepseek-harness/node-proxy.mjs \
  node --test --test-name-pattern='proxy|healthz|SIGTERM' deepseek-harness/test-runtime.mjs
# 导出补丁
rm -f ../patches/*.patch ../patches/*.bundle
git format-patch upstream/dev..HEAD -o ../patches
git bundle create ../patches/plain-http.bundle upstream/dev..HEAD
git rev-parse upstream/dev > ../patches/BASE
# 推送 fork（rebase 改写了提交，必须 force-with-lease）
git push --force-with-lease origin plain-http
```

部署仓库（快照）刷新：

```bash
rsync -a --delete --exclude .git runtime/ /path/to/dsh-plain/runtime/
cp patches/*.patch patches/plain-http.bundle patches/BASE /path/to/dsh-plain/patches/
cd /path/to/dsh-plain && git add -A && git commit -m "sync: upstream runtime@$(cat patches/BASE | cut -c1-7)" && git push
```

## 4. 冲突处理（可预期，集中在 5 个文件）

| 文件 | 冲突原因 | 处理原则 |
|---|---|---|
| `deepseek-harness/Dockerfile` | 上游改 Caddy 阶段/版本、包列表 | **删除**上游新增的 Caddy 相关行；保留本分支的 node-proxy COPY、8080、`/healthz` |
| `deepseek-harness/docker-entrypoint.sh` | 上游改认证/证书逻辑 | 保留本分支：无用户名密码、无 CA、启动 node-proxy；保留 uid/gid、就绪等待、`--trusted-host`、`ONEPANEL_DSH_AUTH_PROXY` |
| `deepseek-harness/test-runtime.mjs` | 上游改 Caddy 测试 | 保留 PDF 用例 + 本分支 14 个代理用例；若上游新增测试针对 Caddy，改写或删除 |
| `patch-dsh-authenticated-settings.mjs` | 上游改补丁字符串 | 只在注释上有改动时应保留；**上游改 DSH 版本时补丁可能失效（见第 5 节）** |
| `.github/workflows/deepseek-harness-release.yml` | 上游改 tag/输入 | 保留本分支：独立仓库名、`:<dshVersion>` + `:plain` 别名、context |

`Caddyfile` 在本分支已删除；上游若修改它，保持删除即可（除非决定重新引入 Caddy）。

## 5. dsh 版本升级（最需要注意的一步）

上游 workflow 的 `dshVersion` 默认值变化时，脚本会打印警告。升级 dsh 版本前：

1. **补丁可能失效**：`patch-dsh-authenticated-settings.mjs` 用精确字符串匹配修改
   `isAuthenticated()`，DSH 源码形状一变，镜像构建期（`Dockerfile` 里执行该脚本）会直接失败——
   这是 fail-fast，不是坏事。需要在 `runtime/` 里更新匹配字符串。
2. **行为可能变化**：DSH 的 WebSocket 路径、`/api` 栅栏、gzip、300 MiB 上限都依赖 DSH 实现，
   升级后必须重跑端到端（见下）再发布。
3. 更新默认版本：`docker-compose.yml` 的 `DSH_VERSION`、`.env.example`、
   `runtime/.github/workflows/...` 的 `dshVersion` 默认值，三者保持一致。
4. 构建镜像并跑 `docker compose up -d --build`，确认日志出现
   `DeepSeek Harness is available at http://…:8080`。

端到端回归（本机有 dsh 时）：

```bash
# 终端 1：真实 dsh
DSH_HOME=$PWD/.e2e/dsh HOME=$PWD/.e2e/dsh/home ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals --import ./prototype/register.mjs \
  /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open \
  --host 127.0.0.1 --port 4599 --trusted-host 127.0.0.1:4599 example.test
# 终端 2：代理
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=8096 PROXY_BACKEND_PORT=4599 \
  PROXY_ALLOWED_HOSTS=example.test node runtime/deepseek-harness/node-proxy.mjs
# 终端 3：验证
curl -fsS -H 'Host: example.test' http://127.0.0.1:8096/healthz
curl -fsS -X POST -H 'Content-Type: application/json' -H 'Host: example.test' \
  -H 'Origin: http://example.test' \
  -d '{"type":"client-request","rpcId":"1","method":"settings/describe","payload":{"args":{}}}' \
  http://127.0.0.1:8096/api/settings/describe | head -c 120
node prototype/ws-test.mjs 8096 example.test http://example.test   # 期望 101
```

## 6. 可选：GitHub 上直接同步 fork

fork `kjeung/runtime` 与上游的 `dev` 可以用网页 **Sync fork** 或命令行：

```bash
gh repo sync kjeung/runtime --source 1Panel-dev/runtime --branch dev
```

但它只更新 fork 的 `dev` 分支，**不会**把 `plain-http` 重新 rebase。
rebase + 测试 + 补丁导出仍要用上面的脚本（脚本直接从 upstream fetch，不依赖 fork 的 dev 是否已同步）。

## 7. 验证同步结果

```bash
git -C runtime log --oneline -3
git -C runtime rev-parse upstream/dev plain-http
cat patches/BASE                       # 补丁基线
git -C runtime status                  # 应为干净
curl -fsS "$(gh api repos/kjeung/runtime/commits/plain-http --jq '.commit.url')" >/dev/null && echo ok
```
