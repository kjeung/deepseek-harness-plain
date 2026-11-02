# 可行性验证用原型（不是生产代码）

这是为《可行性报告：去认证 + 去 TLS，用 Node 反代替换 Caddy》配套的**实测用**小工具，
用来证明"Node 代理能否替代 Caddy"。

> **生产版已经落地**：`../runtime/deepseek-harness/node-proxy.mjs`。它在本目录原型的基础上补齐了
> Host 白名单、安全响应头、JSON 访问日志、`/healthz`、可选共享密钥、优雅退出与错误处理，
> 并改由 entrypoint 以 node 用户启动。本目录仅保留作为可行性验证的历史证据，**不要用于生产**。

| 文件 | 作用 |
|---|---|
| `node-proxy.mjs` | 130 行反代原型：HTTP 流式透传、保留 Host/Origin、转发 WebSocket upgrade |
| `patch-loader.mjs` / `register.mjs` | 用 Node 模块加载钩子复刻镜像里的 `isAuthenticated` 补丁（`ONEPANEL_DSH_AUTH_PROXY=1` 时恒真），用于本地跑真实 DSH |
| `ws-test.mjs` | WebSocket 握手探测（打印状态行） |
| `fence-test.sh` | Host/Origin/跨站 栅栏矩阵测试 |
| `test-backend.mjs` | 假后端：验证流式不缓冲（3 chunk × 400ms）与 8MB 上传透传 |

## 复现

```bash
# 1) 起真实 dsh（打了等价补丁），后端只听 127.0.0.1:4555
DSH_HOME=$PWD/.run/dsh HOME=$PWD/.run/dsh/home ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals --import ./prototype/register.mjs \
  /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --no-open --host 127.0.0.1 --port 4555 \
  --trusted-host 127.0.0.1:4555 example.test

# 2) 起代理（明文、无认证）
LISTEN_PORT=8080 BACKEND_PORT=4555 node prototype/node-proxy.mjs

# 3) settings 端点（Host+Origin 原样透传，不需要 Caddy 的 Host 改写）
curl -sS -X POST -H 'Content-Type: application/json' \
  -H 'Host: example.test' -H 'Origin: http://example.test' \
  -d '{"type":"client-request","rpcId":"1","method":"settings/describe","payload":{"args":{}}}' \
  http://127.0.0.1:8080/api/settings/describe | head -c 200

# 4) WebSocket（期望 101）
node prototype/ws-test.mjs 8080 example.test http://example.test
```

> 注意：8080/3090 等端口请避开宿主上已有服务；DSH 固定拒绝 `--host 0.0.0.0`。
