# 评审问题修复记录（实现落地后）

> 实施完成后由两名独立评审审计（`notes/implementation-review-build.md`、`notes/implementation-review-security.md`），
> 本文件记录每条问题的处理结果与验证方式。评审基线的实现快照已被后续修复覆盖，以本文件为准。

## 1. 发布阻塞项（P0）

| 编号 | 问题 | 处理 | 验证 |
|---|---|---|---|
| B-1 | 发布工作流仍以 `1panel/deepseek-harness:<版本>` / `:latest` 推送，会同名替换 Caddy/HTTPS 镜像 | **已修**：`.github/workflows/deepseek-harness-release.yml` 改为默认发布到独立仓库 `1panel/deepseek-harness-plain`，tag 为 `:<dshVersion>` + `:plain` 别名（`imagetools create`，一次构建同 digest）；新增 `imageName` 输入便于自有仓库 | 工作流 YAML 解析通过；旧 `pushLatest` 两次构建逻辑已删除 |

## 2. P1

| 编号 | 问题 | 处理 | 验证 |
|---|---|---|---|
| P1-1 | `/healthz` 探测在“后端已发响应头、body 卡住”时二次 `writeHead` → `ERR_HTTP_HEADERS_SENT`，代理进程退出 1 | **已修**：`healthz()` 增加 `settled` 守卫 + `writableEnded/destroyed` 判断；探测超时只销毁 probe，不再写响应 | 评审的 R1 复现脚本：首/次 healthz 均 200，2.6 s 后进程仍存活；新增回归测试 `healthz survives a backend that sends headers then stalls` |

## 3. P2（按评审清单）

| 编号 | 问题 | 处理 |
|---|---|---|
| P2-1 | stdout EPIPE 未捕获导致崩溃（访问日志默认开） | **已修**：启动即 `process.stdout.on('error', () => {})`；R2 复现脚本验证 stdout 关闭后仍存活且请求 200 |
| P2-2 | `/healthz` 绕过 Host 白名单与共享密钥，且与 README 矛盾 | **已修**：healthz 只允许**回环来源**或带 `X-DSH-Proxy-Secret` 的请求，否则 403；README 运维章节与「已知限制」已写明 |
| P2-3 | 客户端半关闭（FIN）后拿不到响应（Node 平台语义，Caddy/Go 不会） | **文档化**：README §9「已知限制」注明；nginx/traefik 默认不半关闭上游，实际风险低 |
| P2-4 | 重复 `Host` 被接受（RFC 7230 应 400） | **已修**：按 `rawHeaders` 统计 Host 数量 >1 → 400（普通请求与升级请求都适用）；新增测试 |
| P2-5 | `Connection:` 点名的逐跳头未剥离 | **已修**：请求/响应两个方向都按 `Connection` token 动态剔除；新增测试断言 `X-Secret-Hop` 不到后端 |
| P2-6 | 客户端伪造 `X-Forwarded-*`/`Forwarded`/`X-Real-IP` 原样透传，且不注入真实 IP | **已修**：全部剥离。**未注入**真实客户端 IP（外层反代才可信），README 明确日志 `remote` 是反代地址 |
| P2-7 | 尾点 Host 代理放行但 DSH 403，测试却断言 200 | **已修**：代理对尾点 Host 直接 400（错误信息明确）；测试改为断言 400 并加注释 |
| P2-8 | 502/healthz 把后端地址与错误原文回给客户端 | **已修**：客户端只见 `bad gateway` / `gateway timeout` / `{"ok":false}`；错误详情写容器 stderr |
| P2-9 | healthz / clientError 的 400 缺安全响应头 | **已修**：统一带 `X-Content-Type-Options` 与 `Referrer-Policy` |
| P2-10 | 不剥离上游 `Server` 头 | **已修**：响应侧同时剥离 `Server` / `X-Powered-By`；新增测试 |
| P2-11 | 无上游响应超时，后端卡死时客户端无限挂起 | **已修**：上游 120 s 未返回响应头 → 504（响应开始后不设超时，LLM/SSE 不受影响） |
| P2-12 | 上传中途断开被记 502 而非 499 | **已修**：`request.on('close')` 检查 `request.complete`，未完成即标记客户端离开 |
| P2-13 | WebSocket 升级不写访问日志 | **已修**：升级请求按后端真实状态行记录（101/401/…），带 `"upgrade":true`；回环 e2e 验证日志出现 `status:101` |
| P2-14 | 入口脚本接受 `0.0.0.0`/`255.255.255.255` 作为访问主机 | **已修**：两者拒绝并给出明确错误；`127.0.0.1` 仍允许（本地调试）但打印警告说明会削弱 Host 白名单 |
| P2-15 | 就绪轮询最坏 180 s 而 start_period 只有 120 s | **已修**：Dockerfile 与 compose 的 `start_period` 统一改为 180 s |
| P2-16 | compose healthcheck 缺 `--noproxy '*'`（启用出站代理时会一直 unhealthy） | **已修**：compose、Dockerfile、入口脚本的 curl 全部加 `--noproxy '*'` |
| P2-17 | SIGTERM 时活动流 5 s 后硬切，文档说“优雅关闭” | **已修（文档）**：README 明确“立即停止接收新连接并断开 WebSocket，普通响应最多等 5 s 后退出”；行为本身保留（重启语义清晰） |
| P2-18 | 测试缺口（healthz 卡死、重复 Host、Connection 点名头、XFF、SSE、300 MiB 等） | **部分已修**：新增 healthz 卡死回归、重复 Host、Connection 点名头、XFF 剥离、`Server` 剥离、Host 规范化（含尾点 400）、WS 共享密钥、SIGTERM+活动 WS、healthz 502；14 个代理用例全绿。仍缺：300 MiB 上限（构建期跑 300 MB 不现实）、真实 SSE 断言（用 e2e 手工验证） |
| B-2 | compose `:?` 导致 `HTTPS_ACCESS_HOST` 兼容在 compose 路径不可达 | **已修**：compose 同时转发两个变量（空默认），校验交给入口脚本并保留回退与弃用提示 |
| B-3 | `PROXY_SHARED_SECRET`/`PROXY_ACCESS_LOG` 未在 compose 转发（安全开关静默失效） | **已修**：两项显式转发（`${VAR:-}` / `${VAR:-1}`） |
| B-4 | `image:`+`build:` 默认 pull 优先，`DSH_IMAGE` 指向旧镜像会实际运行旧镜像；版本不进 tag | **已修**：compose 增加 `pull_policy: build`；文档明确要用已构建镜像需删除 `build` + `pull_policy`；镜像内新增 `org.opencontainers.image.version` 标签；发布用 `-plain` 独立仓库 + 版本 tag |
| B-5 | Dockerfile HEALTHCHECK start-period 低于入口等待上限 | **已修**：见 P2-15 |
| B-6 | 文档称旧变量“会提示”，入口脚本实际无提示 | **已修**：入口脚本回退时打印弃用提示 |
| B-7 | README 写 `node-proxy.mjs` 130 行（实际约 490） | **已修**：README 与可行性报告同步为实际行数 |
| B-8 | README §3.3/3.4 未说明 compose 只转发显式变量 | **已修**：README 增加说明并指出哪些变量需取消 compose 注释 |
| B-10 | 测试时序 flaky（400 ms + <300 ms 断言、freePort 竞争） | **已修**：流式用例改为后端 800 ms 间隔 + <600 ms 断言；代理改用 `PROXY_LISTEN_PORT=0` 由内核分配并解析实际端口，消除 reserve/release 竞争 |
| B-12 | 无 `.dockerignore` | **已修**：仓库根新增 `.dockerignore`（`.git`、`.github` 等） |
| B-13 | `.gitignore` 忽略 `runtime/`，fresh clone 无法构建 | **文档化**：README §2 增加 clone 命令；说明 `runtime/` 是上游仓库克隆 |
| B-14 | curl 探测未加 `--noproxy` | **已修**：见 P2-16 |
| B-15 | README 把偶发 502 归因外部 keepalive，无证据 | **已修（代码+文档）**：上游连接池 `timeout: 4000` 低于 DSH 的 ~5 s keep-alive；README 改为“多层 keep-alive，先看访问日志定位” |
| B-16 | `.env.example` 的镜像 tag 示例无流水线产出 | **已修**：示例改为 `deepseek-harness-plain:<dshVersion>`，与工作流一致 |
| B-17 | 测试继承开发机 `PROXY_SHARED_SECRET` 会误失败 | **已修**：`startProxy` 默认置空 `PROXY_SHARED_SECRET`，用例显式开启 |
| B-18 | 镜像缺版本元数据 | **已修**：新增 `org.opencontainers.image.version=${DSH_VERSION}` |
| B-9/B-11 | README 对构建期验证的表述、本机 PDF 测试需镜像期 polyfill | **文档化**：README 附录说明“本地用 `DSH_PROXY_BIN` 跑代理用例；PDF 用例需镜像构建期 polyfill” |

## 4. 未修 / 接受的风险

| 项 | 原因 |
|---|---|
| P0-1 端口暴露面（无认证） | 设计前提：认证在外部反代。compose 已限制为 `127.0.0.1` 发布；README 安全章节强调专用网络与共享密钥 |
| P2-3 半关闭语义 | Node `http.Server` 平台行为，改造需改用 net 层自研 HTTP 解析，成本远超收益；实际反代不半关闭上游 |
| 真实客户端 IP | 不可信来源无法区分，选择剥离伪造头；需要真实 IP 由外层反代记录 |
| 300 MiB 上限测试 | 构建期跑 300 MB 传输不稳定且慢；DSH 自身返回 413，代理不设更小上限 |
| SIGTERM 硬切活动流 | 保留 5 s 排空 + 强制退出，与容器重启语义一致；文档已说明 |

## 5. 修复后的验证

```bash
cd runtime/deepseek-harness
node node-proxy.mjs --self-test                                   # 0
bash docker-entrypoint.sh --self-test                             # 0
DSH_PROXY_BIN=$PWD/node-proxy.mjs \
  node --test --test-name-pattern='proxy|healthz|SIGTERM' test-runtime.mjs
# → tests 14 / pass 14 / fail 0
```

另做过一次真实 DSH 0.2.1-rc.5 端到端回归：`GET /` 200、`/healthz` 200、`settings/describe` 200 `ok:true`、
WS `101`、尾点 Host 400、未知 Host 403、SSE 首帧正常且访问日志记 499（客户端断开）、WS 日志记 101。

未验证（本环境无 docker）：镜像实际构建与运行、镜像内完整 `node --test`（含 PDF 用例）、
arm64/QEMU 时序、真实 `gosu`/`tini` 行为、compose 的 pull/build 实际动作。
