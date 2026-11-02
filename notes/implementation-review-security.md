# 独立评审（安全 / 正确性）：Caddy → 明文 Node 转发代理

> 评审对象：`/workspace/workspace/deployment/runtime/deepseek-harness/`（`node-proxy.mjs`、`docker-entrypoint.sh`、`Dockerfile`、`test-runtime.mjs`；`Caddyfile` 已删除）
> 评审人：review-security（task-5）；评审方式：静态通读 + 构建期测试复跑 + 自建对抗用例 + 真实 DSH 0.2.1-rc.5 栅栏实测 + 入口脚本桩测。
> 本目录只写这一个文件，未修改任何实现文件。

## 0. 评审快照与一个必须说明的前提

评审期间实现文件被更新过一次（mtime 2026-11-02 05:38）。**本报告以评审结束时的最终快照为准**，全部结论都在下列 sha256 上复现：

| 文件 | sha256（前 16） | 行数 |
|---|---|---|
| `node-proxy.mjs` | `5716feb35cf1b067…` | 327 |
| `test-runtime.mjs` | `502371d662120792…` | 445 |
| `docker-entrypoint.sh` | `a97f48ca05e7f0c1…` | 100 |
| `Dockerfile` | `f7ac905ee1382f13…` | 82 |

（旧快照里 403 响应缺 `Referrer-Policy`、访问日志可能重复计数等问题在最终快照中已修复，不再作为发现列出。）

本环境：node v24.22.2、无 docker、非 root。因此**镜像构建期行为（PDF polyfill 后的 `node --test`、真实 `gosu`/`tini`、docker 网络）无法在本机验证**，见第 7 节「未验证」。

## 1. 结论（verdict）

**有条件通过（conditional pass）。**

- **没有发现 P0 级代码缺陷**：代理的 Host 校验、凭证剥离、流式转发、WebSocket 透传、请求走私防护、入口脚本校验与信号处理，在我构造的对抗用例下均表现正确；构建期测试稳定通过（给定 pattern 命中 10/10，连续 3 次；测试文件内共 12 个代理用例，全量运行 12/12 通过）。
- **有 1 个 P1**：`/healthz` 在“后端已发响应头、响应体卡住 ≥2s”时会二次写响应，抛 `ERR_HTTP_HEADERS_SENT` 未捕获异常，**整个转发进程退出 1**。`/healthz` 不需要 Host 白名单也不需要共享密钥，是可无认证触达的端点；触发条件取决于 DSH 后端（`GET /` 在 2s 内没发完 body），属于“低概率但真实、且修复只需几行”的可用性缺陷。**建议发布前修复。**
- **安全边界完全在容器外**（设计如此）：任何能连到 8080 的客户端，只要发 `Host: <DSH_ACCESS_HOST>` 就是 owner 全权；Host 白名单不是安全边界（域名本身是公开信息），共享密钥也只是纵深防御且 `/healthz` 绕过它。因此端口必须严格只回环发布 / 只挂隔离网络，详见 §2。
- 其余 18 项 P2 以加固、可观测性、文档一致性和测试覆盖为主；其中 3 项值得在发布前一并处理：访问日志 EPIPE 崩溃、`/healthz` 绕过共享密钥（与 README 表述矛盾）、客户端半关闭（FIN）后拿不到响应。

## 2. 威胁模型：去掉 Caddy 之后还剩什么

当前架构：`浏览器 → 外部反代(认证+TLS) → 宿主 127.0.0.1:8080 → 容器 0.0.0.0:8080（Node 代理，无认证） → 127.0.0.1:3080（DSH）`。

实测/代码确认的事实：

1. **DSH 自身仍有一道 Host/Origin 栅栏**（不是认证，只防 DNS rebinding / 跨站）。用真实 DSH 0.2.1-rc.5（`--trusted-host 127.0.0.1:7311 dsh.example.com`，库存未打补丁版，因此“栅栏通过 = 401，栅栏拒绝 = 403”）实测 `/api/settings/describe` 与 `WS /api/remote.mux`：

   | Host（Origin） | `/api`（HTTP） | `WS /api/remote.mux` | 含义 |
   |---|---|---|---|
   | `dsh.example.com` | 401 | 401 | 栅栏通过（未认证） |
   | `DSH.EXAMPLE.COM` | 401 | — | 大小写不敏感，通过 |
   | `dsh.example.com:7311` | 401 | — | 端口不敏感，通过 |
   | `dsh.example.com.`（尾点） | **403** | **403** | **栅栏拒绝**，见 P2-7 |
   | `127.0.0.1:7311` | 401 | 401 | 回环恒可信（所以代理的 Host 白名单确实挡住了它，见下） |
   | `evil.invalid` | 403 | 403 | 拒绝 |
   | 同源 Origin + 跨站 `Sec-Fetch-Site: cross-site` | — | **403** | 跨站 WS 被 DSH 拦住 |

   结论：**代理把 Host/Origin/`Sec-Fetch-*` 原样透传是正确设计**；不要照抄 Caddy 的 settings Host 改写。代理侧也实测原样转发这些头（`adv-http` T8.3、`final-checks` C）。
2. **代理的 Host 白名单挡住了“回环 Host”这条捷径**：`127.0.0.1:3080` 会被 DSH 栅栏接受，但代理只允许 `PROXY_ALLOWED_HOSTS`（由 `DSH_ACCESS_HOST` 派生），规范化后不含回环 → 403（实测 T1.4/T1.11 等）。除非运维把 `DSH_ACCESS_HOST` 设成 `127.0.0.1`（见 P2-14）。
3. **谁能连到 8080，谁就是 owner**：不需要 cookie、不需要 token、不需要 Origin（非浏览器客户端可以不发），只要 Host 对。能“连到 8080”的范围包括：
   - `docker-compose.yml` 只发布 `127.0.0.1:8080`（compose:55-58），所以**宿主机上的任意本地进程/用户**可以直接成为 owner；
   - 容器内是 `0.0.0.0:8080`（entrypoint:88），**同一 Docker 网络里的其他容器**可以直连并绕过外部反代；compose 未声明专用 `internal` 网络；
   - 若有人把发布地址改成 `0.0.0.0`/`8080:8080`，等于把 owner 权限公开到网络。
4. **Caddy 的 basic_auth 是唯一被删掉的认证**；`ONEPANEL_DSH_AUTH_PROXY=1` + `isAuthenticated` 补丁必须保留（否则 `GET /` 与 `/api` 全 401，入口脚本就绪探测与健康检查都会失败）——入口脚本与 Dockerfile 都已保留，未发现回退。

> 因此 P0 级风险不在代码里，而在“端口暴露面”这个运维前提上：只要 8080 的暴露范围超出“外部反代”，就是完整接管。报告把它记为 **P0-1（前提条件，非代码缺陷）**。

## 3. 发现清单

级别定义：**P0** 破坏部署安全/不可用；**P1** 功能性缺陷或可触发的进程崩溃；**P2** 加固/一致性/可观测性。所有条目都在最终快照上验证（“实测”= 有复现；“分析”= 静态推断，未复现的会标注）。

### P0

| 编号 | 位置 | 问题 | 影响 | 复现/证据 |
|---|---|---|---|---|
| **P0-1**（前提条件，非缺陷） | `node-proxy.mjs:8-11,61`；`docker-compose.yml:55-58`；`docker-entrypoint.sh:86-93` | 设计上容器内无任何认证，8080 可达即 owner 全权；Host 白名单只是卫生措施（域名公开），“共享密钥”可选且 `/healthz` 绕过 | 端口若发布到 0.0.0.0 或容器与其它容器共享网络 → 未经认证的完全接管（改设置、读/写凭据、执行 Agent/命令） | 实测：代理对 `Host: <DSH_ACCESS_HOST>` 放行并原样转发；真实 DSH 栅栏对该 Host 返回 401（=栅栏已通过，仅差打补丁），即打补丁后为 owner 全权。缓解：保持 `127.0.0.1` 发布 / 专用 `internal` 网络；必要时启用 `PROXY_SHARED_SECRET` |

### P1

| 编号 | 位置 | 问题 | 影响 | 复现/证据 |
|---|---|---|---|---|
| **P1-1** | `node-proxy.mjs:126-150`（关键在 `144-148`） | `/healthz` 的 backend 探测：先 `response.writeHead/end`（140-141），若之后 probe 再触发 `timeout`/`error`，错误处理里**无条件再次 `response.writeHead(502)`** → `ERR_HTTP_HEADERS_SENT` 未捕获，进程退出 1。同一路径下 `/healthz` 不需要 Host 白名单、不需要共享密钥（166-169） | 转发进程整体崩溃 → tini/容器重启（`restart: unless-stopped`），进行中的 Agent 会话/流被中断；若 DSH `/` 反复出现“头已发、body ≥2s”的卡顿（例如事件循环被大上传/重活阻塞）可形成重启循环 | **实测**：假后端 `GET /` 发 200 头后只写 1 字节不结束 → 2s 后 probe 超时 → 代理 exit=1，stderr 含 `ERR_HTTP_HEADERS_SENT`。见 §5.3 复现 R1 |

### P2

| 编号 | 位置 | 问题 | 影响 | 复现/证据 |
|---|---|---|---|---|
| **P2-1** | `node-proxy.mjs:106-118`（另见 `299`、`322`） | 访问日志默认开启（`PROXY_ACCESS_LOG !== '0'`，66），日志写入 `process.stdout.write` 没有 `'error'` 监听；stdout 管道断开（EPIPE）时未捕获异常 → 进程退出 1 | 容器 stdout/日志管道异常时转发进程崩溃；日志驱动/父进程异常即可触发 | **实测**：启动代理后关闭 stdout 读端，再发任意请求 → `code: 'EPIPE'`、exit=1；`PROXY_ACCESS_LOG=0` 时不崩。见 §5.3 R2 |
| **P2-2** | `node-proxy.mjs:166-169`；`README.md:108` | `/healthz` 在 **Host 白名单校验之前** 处理，且不校验共享密钥。README 却称“设置 `PROXY_SHARED_SECRET` 后请求不带该头否则 403” | 无认证客户端可反复探测后端健康状态（1 请求 → 1 次后端 `GET /`，无放大）；与文档矛盾；若将来把共享密钥当访问闸门会误判 | **实测**：`PROXY_SHARED_SECRET=s3cret-value` 下 `curl -H 'Host: evil.invalid' http://127.0.0.1:<proxy>/healthz` → 200；非 healthz → 403。见 R3 |
| **P2-3** | Node 平台语义；代理 `node-proxy.mjs:244` | 客户端发完请求后**半关闭**（`shutdown(SHUT_WR)`，只发 FIN 不 RST）时，代理会把 FIN 转给后端，但下游 socket 在响应前就被 Node 关闭，客户端拿到**空响应**（Caddy/Go 能正常回答；Node `http.Server` 对“异步响应 + 半关闭”同样拿不到，已用裸 Node 服务复现作对照） | 使用半关闭语义的客户端/上层代理会收不到响应；nginx/traefik 默认不半关闭上游，实际风险低，但属于相对 Caddy 的行为回归 | **实测**：`adv-edge` E1.1（裸 socket 发请求后 `end()` → 0 字节）；对照：裸 Node `http.Server` 同步响应能回，异步 300ms 响应同样 0 字节。见 R4 |
| **P2-4** | `node-proxy.mjs:170-179` | 重复 `Host` 头被 Node 解析器接受，“第一个生效”（实测 `Host: dsh.example.com` + `Host: evil.invalid` → 200 且后端看到 `dsh.example.com`；反序 → 403）。RFC 7230 §5.4 要求 400；Caddy/Go 会拒绝 | 与上游代理/后端使用的 Host 取值不一致时，理论上有请求走私/缓存投毒的差异面；当前链路（Node→Node）两边都取第一个，未发现可利用路径，但缺少显式拒绝 | **实测** T1.1/T1.2/T1.3、H4.1（`Host` + `host`）。见 R5 |
| **P2-5** | `node-proxy.mjs:84-92`、`95-104` | 逐跳头只按固定清单剥离，**没有剥离 `Connection:` 头里点名的自定义头**（RFC 7230 §6.1）；请求/响应两个方向都实测穿透 | 若上游代理用 `Connection: X-...` 方式标注逐跳字段，会被原样送给 DSH；当前 DSH 不消费这类头，暂无实际影响 | **实测** E5.3/E5.4：`Connection: keep-alive, X-Req-Secret` + `X-Req-Secret: leak` → 后端收到 `x-req-secret`；后端 `Connection: X-Hop-Secret` → 客户端收到 `x-hop-secret` |
| **P2-6** | `node-proxy.mjs:84-92` | 不剥离客户端伪造的 `X-Forwarded-For/Proto/Host`、`Forwarded`、`X-Real-IP`，也**不注入**真实客户端 IP | 访问日志的 `remote` 永远是反代地址（README:109 称日志含“来源”，易被理解为真实客户端）；若 DSH 或将来插件信任这些头则有伪造面（本机 DSH 安装里附带的 dshmarket `trustedRestartRequest` 反而把“存在 XFF”当不可信，属 fail-closed；该包是否在本镜像 web profile 中启用未验证） | **实测** H4.2：客户端自带 XFF/XFH/XFP 原样到达后端；日志 `remote=127.0.0.1`；`x-forwarded-*` 未被注入 |
| **P2-7** | `node-proxy.mjs:44-55`；`test-runtime.mjs:341-354` | 代理白名单把 `dsh.example.com.`（尾点）规范化为 `dsh.example.com` 并放行，但 DSH 栅栏按 WHATWG host 精确比较，尾点 Host **403**；单测却断言“尾点 Host 应 200”，给了端到端可用的错觉 | 若客户端/上游反代发 FQDN 尾点 Host，用户得到 403 `forbidden`（fail-closed，无安全影响），排障困难 | **实测**：真实 DSH 对 `Host: dsh.example.com.` 的 `/api` 与 WS 都 403（§2 表）；代理单测 200 |
| **P2-8** | `node-proxy.mjs:152-159`、`140-148`、`220-228` | 502 响应体把后端错误原文回给客户端，如 `bad gateway: connect ECONNREFUSED 127.0.0.1:3080`；`/healthz`（无认证）也返回 `{"ok":false,"error":"connect ECONNREFUSED 127.0.0.1:<port>"}` | 泄露后端地址/内部错误细节；对 `/healthz` 是无认证信息泄露 | **实测** T6.9、502 用例。见 R6 |
| **P2-9** | `node-proxy.mjs:138-141`、`281-287` | `/healthz` 与 `clientError` 的 400 响应不带 `X-Content-Type-Options`/`Referrer-Policy`，而 `reject()`（403/400/502）带；Caddy 时代 `header` 指令是全局的 | 安全头覆盖不一致（低危） | **实测** T6.5（healthz 两头均无）、E3.3/E3.4（400 只有默认头） |
| **P2-10** | `node-proxy.mjs:95-104` | 不像 Caddy `-Server` 那样剥离上游 `Server` 头 | 若 DSH/中间件返回 `Server`，会原样泄露版本信息；当前 DSH（Node）默认不发 `Server`，未观测到实际泄露（构建期测试 192 行只断言 mock 未设置） | **实测** T5.3：mock 后端的 `Server: dsh-secret-version` 被原样透传 |
| **P2-11** | `node-proxy.mjs:291-293`、`196-228` | `server.requestTimeout=0`、无上游响应超时、无 body 空闲超时；后端“接受连接但永不响应”时客户端无限挂起（实测 3s 客户端超时）；慢速上传可长期占用连接 | 后端卡死/慢速攻击时连接与内存被长期占用（Caddy 默认也无 read timeout，属与旧行为对齐，但这是明文暴露面） | **实测** T4.2（hung backend 3s 无响应）、E2.1（半截 chunked 上传 2.5s 仍挂起） |
| **P2-12** | `node-proxy.mjs:220-228`（对比注释 `186-187`） | 注释声称“客户端走开记 499”；实测：响应中途断开记 499（正确），但**上传中途断开被记成 502**（clientGone 只在 headers 已发分支生效） | 日志误判客户端中止为后端 502，影响排障/告警 | **实测** `log-abort2.mjs`：上传中断日志 `["/upload",502]`；`log-abort.mjs`：流中断 `["/stream",499]` |
| **P2-13** | `node-proxy.mjs:247-279` | WebSocket 升级完全不写访问日志（无 `logLine`），`trackedSockets` 之外也没有连接数指标 | WS（DSH 远程流/终端）不可见，排障只能靠 DSH 侧日志；Caddy 时代同样没日志，属可观测性缺口 | **实测** H4.3：升级请求不出现在 JSON 日志中 |
| **P2-14** | `docker-entrypoint.sh:4-12,32-39` | `is_access_host` 接受 `0.0.0.0`、`255.255.255.255`、`127.0.0.1`（实测）。`0.0.0.0` 会被当作 `--trusted-host` 与代理白名单，但浏览器不会发这种 Host → 白屏；`127.0.0.1` 则把回环 Host 纳入白名单，代理那道额外栅栏失效 | 运维把 `DSH_ACCESS_HOST` 误填为监听地址是最常见的部署事故；后者会削弱本可多加的一层 | **实测**（提取函数直接调用）：`0.0.0.0/127.0.0.1/255.255.255.255 → accept` |
| **P2-15** | `docker-entrypoint.sh:68-84`；`Dockerfile:75-78`；`docker-compose.yml:68-73` | 就绪轮询最坏 `60 × (curl --max-time 2 + sleep 1) ≈ 180s`，而 healthcheck `start_period=120s` | DSH 冷启动极慢（端口已 listen 但不回 `/`）时容器可能先被判 unhealthy（不会重启，但 `depends_on: service_healthy` / 编排器会受影响） | **分析**（未实测最坏路径；正常“连接拒绝”路径约 60s，与文档一致） |
| **P2-16** | `docker-compose.yml:69` vs `docker-entrypoint.sh:70`、`Dockerfile:78` | entrypoint 与 Dockerfile 的 curl 都加了 `--noproxy '*'`，**compose 的 healthcheck 没加**；而 compose 支持并转发 `HTTP_PROXY/HTTPS_PROXY`（README:3.4）。实测 curl 对 `127.0.0.1` 会走 `http_proxy`，只有 `--noproxy '*'` 才直连 | 启用出站代理的部署里，compose 健康检查会失败 → 容器一直 unhealthy（镜像内 HEALTHCHECK 被 compose 覆盖） | **实测 curl 语义**：`http_proxy=http://127.0.0.1:9 curl http://127.0.0.1:7399` → 000；加 `--noproxy '*'` → 200 |
| **P2-17** | `node-proxy.mjs:295-304`；`README.md:172` | SIGTERM 立即销毁 WS socket（无 close 帧，11ms 退出，实测）；活动 SSE/普通流不主动关闭，要等 5s 强制 `process.exit(0)` 才断（实测 5010ms）。README 表述为“关闭 WebSocket/SSE”，实际是 5s 后硬切 | 长流在重启时被突然切断；优雅退出的语义与文档有偏差（`stop_grace_period: 30s` 用不上） | **实测** E7.1（5010ms）、T8.13（WS 11ms） |
| **P2-18** | `test-runtime.mjs` | 覆盖缺口：没有 `/healthz` 卡死用例（即 P1-1）、重复 Host、`Connection` 点名头、半关闭、XFF 伪造、SSE、300MiB 上限；`freePort()`（62-69）先占后放仍有端口竞争；`startProxy` 靠轮询输出（129-134）在慢 CI 上可能 5s 超时；安全头/`Server` 头断言只对 mock 成立 | 现有 12 个代理测试质量不错（Host 规范化、WS 密钥、SIGTERM+WS 都是后补的好用例），但以上缺口正是本次发现 P1/P2 的地方，说明“测试全绿”不足以代表端到端可用 | 已读 + 复跑（§5） |

## 4. 已实测确认正确的部分（正向结论）

以下均为**本机实测**，不是代码推断：

1. **Host 白名单/规范化**：大小写、端口、尾点（代理层）、多条目、带端口的白名单项；`user@host`、`host.evil` 后缀、4000/20000 字节 Host、缺失 Host（HTTP/1.0 与 1.1）全部 403/400；`*` 条目不会放行任何请求；IDN 不被隐式转换。
2. **凭证剥离**：请求 `Authorization`、`Proxy-Authorization`、`X-DSH-Proxy-Secret` 不达后端；WS 升级路径同样剥离；响应侧 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin` 强制覆盖。
3. **请求走私类**：`CL+TE`、重复 `Content-Length`、`Content-Length` 后跟多余字节、obs-fold、负数 CL 全部在代理层 400，且不会到达后端（后端请求计数 0）；chunked 上传被正确重编码（后端见 `Transfer-Encoding: chunked`、无 CL），body 完整。
4. **流式/大 body**：首块 41ms 到达（无缓冲）；4MB 上传原样到达；`100-continue` 端到端正常（客户端收到 100，后端收到 body 与 `Expect`）；HEAD 无 body、OPTIONS、204/304、多 `Set-Cookie`、`Content-Encoding: gzip` 透传。
5. **异常/断连**：客户端在挂起请求上断开、流式中途断开、后端截断 body（CL=100 只发 10 字节）、后端连发 20 次 RST、客户端在上传中途断开——代理进程均存活、后端 socket 被回收（`resClosed=true`）。
6. **WebSocket**：101 透传；Host/Origin 原样到达；跨站 Origin/`Sec-Fetch-Site` 由 DSH 拒绝（真实 DSH 实测 403）；SIGTERM 时有开着的 WS 也能 0 退出（11ms）；用**与 DSH 相同的 `ws@8.22.1`** 作后端时，客户端断开后后端 socket/WS 正常 close（无泄漏）；并发 WS + SSE 正常。注：用“不处理 FIN 的裸 `http.Server`”作后端时观察到的 socket 残留**不是代理缺陷**——真实 DSH 的 `ws` 会在 `end` 后 `socket.end()`，链路闭合。
7. **共享密钥**：常量时间比较（长度先比，泄露长度可忽略）；错误/前缀/10KB/重复头 → 403；正确 → 200；不会转发；WS 同样要求（构建期测试 366-400）；`/healthz` 例外（P2-2）。
8. **healthz 语义**：后端 200 → 200 `{ok:true,backend:200}`；后端不可达 → 502 `{ok:false}`（构建期测试已覆盖，我也复现）；客户端中途断开不崩（但 P1-1 的“已发响应后超时”会崩）。
9. **入口脚本**（用 fake `gosu/install/curl/node` 桩测）：
   - 校验矩阵与 `.env.example` 一致：拒绝 scheme/端口/下划线/路径/IPv6/尾点/空值/非法 IPv4；接受主机名、IPv4、大写、`localhost`（`0.0.0.0` 见 P2-14）；
   - `DSH_ACCESS_HOST` 优先，`HTTPS_ACCESS_HOST` 回退并打印弃用警告（32-34）；
   - 环境正确下发：`--trusted-host 127.0.0.1:3080 <host>`、代理 `PROXY_ALLOWED_HOSTS=<host>`、`0.0.0.0:8080`；`DSH_HOME/HOME/DSH_TELEMETRY_DISABLED/ONEPANEL_DSH_AUTH_PROXY` 就位；`DSH_ACCESS_HOST/HTTPS_ACCESS_HOST` 被 unset，子进程看不到；
   - `gosu node env` **不会清空环境**：`PROXY_SHARED_SECRET`/`PROXY_ACCESS_LOG` 会被代理继承（同时 dsh 也会继承，非缺陷）；
   - 信号/退出：SIGTERM → 143，两个子进程都收到 TERM；代理先退出时容器以代理退出码退出（wait -n 语义正确）；dsh 在就绪前崩溃 → 快速以 dsh 码退出（未等满 60s）。
10. **`--self-test`**：`dsh-node-proxy --self-test` 在无 `PROXY_ALLOWED_HOSTS` 时 0 退出（Dockerfile 需要的顺序正确）；入口脚本 `--self-test` 0 退出；**无扩展名的 `/usr/local/bin/dsh-node-proxy` 在 node 24 下能被 ESM 语法检测正常执行**（本机复制为无扩展名文件实测：启动、监听、SIGTERM 0 退出），Dockerfile 的 COPY 路径与 chmod 无隐患。
11. **keep-alive/空闲**：代理上游 pool 在“连续两次 5.5s 空闲的 SSE 流”下都正常（新增的 `agent timeout: 4000` 不会杀活动流；6s 空闲的 SSE 也正常，且日志计时准确）。`upstream` socket 复用未见 ECONNRESET。

## 5. 测试执行结果（我实际观察到的）

### 5.1 构建期测试套件（重点）

命令（与任务给定一致，PDF 用 pattern 过滤）：

```bash
DSH_PROXY_BIN=/workspace/workspace/deployment/runtime/deepseek-harness/node-proxy.mjs \
  node --test --test-name-pattern='proxy|healthz' \
  /workspace/workspace/deployment/runtime/deepseek-harness/test-runtime.mjs
```

结果：该 pattern 命中 **10 个用例，10/10 通过，连续 3 次稳定**（每次约 4.8–5.1s）。命中用例：Host/Origin 透传+凭证剥离+安全头、未知 Host 403、流式不缓冲、WS 101/403、502、共享密钥、healthz 200、Host 规范化、healthz 502、4MB body。

注意：测试文件里实际有 **12 个代理用例**，其中 `the shared secret is required for WebSocket upgrades too` 与 `SIGTERM drains an open WebSocket and exits 0` 名字里不含 `proxy`/`healthz`，**不会**被给定 pattern 选中；全量运行（见下）时 12 个代理用例全部通过。

**完整套件（不过滤）在本机跑的结果**：`tests 14 / pass 12 / fail 2`，失败的是两个 PDF 用例（`ReferenceError: Iterator is not defined`）——这是预期的：PDF 兼容 polyfill 在**镜像构建期**由 `patch-dsh-authenticated-settings.mjs` 注入，本机库存 DSH 未打补丁。因此“镜像内完整 `node --test` 全绿”**未验证**（无 docker），见 §7。

### 5.2 我自己的对抗用例（脚本在 `.work/review-security/`，gitignore 内）

| 套件 | 结果 | 说明 |
|---|---|---|
| `adv-http.mjs`（Host/走私/方法/断连/安全头/healthz/密钥/WS/日志/启动参数，82 项） | 80 pass / 2 fail | 2 个 fail：`T9.1` 即 P2-1（EPIPE，真实缺陷）；`T8.15` 是“用不处理 FIN 的裸 http 后端”造成的假阳性，已用真实 `ws` 后端证伪 |
| `adv-edge.mjs`（半关闭、截断上传、CONNECT/TRACE、healthz 带 body+keep-alive、Set-Cookie/gzip/Connection 点名头、白名单变体、SIGTERM 活动流、204/304，28 项） | 27 pass / 1 fail | 唯一 fail 是 P2-3（半关闭无响应，已用裸 Node 服务作对照证明是平台语义） |
| `adv-crash.mjs`（healthz 卡死、RST 风暴、异步响应竞争、Host 大小写重复、XFF、WS 不写日志、CL 溢出，9 项） | 8 pass / 1 fail | 唯一 fail 是 **P1-1**（确定性崩溃） |
| `entry-clean.sh`（入口脚本桩测，24 项） | 22 pass / 2 “fail” | 2 个 fail 是桩计数误差（`PROXY_SHARED_SECRET`/`PROXY_ACCESS_LOG` 在 dsh 与 proxy 两个子进程 env 里各出现一次），非缺陷 |
| 真实 DSH 栅栏探针（`dsh web` 127.0.0.1:7311 + 裸 socket/curl） | 全部符合预期 | 见 §2 表（Host/Origin/WS/跨站） |
| `ws-lib.mjs`（真实 `ws@8.22.1` 作后端） | 通过 | 客户端断开 → 后端 `socket close` + `ws close`，无泄漏 |
| `idle-timeout.mjs` / `reuse-stream.mjs` | 通过 | 6s 空闲 SSE、复用连接上的 5.5s 空闲 SSE 均不中断 |
| `log-abort.mjs` / `log-abort2.mjs` | 复现 P2-12 | 流中断=499，上传中断=502 |

### 5.3 关键复现命令

**R1（P1-1，代理崩溃）**

```bash
# 假 DSH：/ 发 200 头 + 1 字节后永不结束
node -e 'require("http").createServer((q,s)=>{s.writeHead(200,{"content-type":"text/plain"});s.write("x")}).listen(7301,"127.0.0.1")' &
# 代理
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=7302 PROXY_BACKEND_PORT=7301 \
PROXY_ALLOWED_HOSTS=dsh.example.com PROXY_ACCESS_LOG=0 \
  node runtime/deepseek-harness/node-proxy.mjs &
# 触发；约 2s 后代理退出（stderr: ERR_HTTP_HEADERS_SENT）
curl -s -H 'Host: dsh.example.com' http://127.0.0.1:7302/healthz; sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7302/ || echo 'proxy crashed'
```

**R2（P2-1，EPIPE 崩溃）**

```bash
# 先正常启动，1s 后关闭 stdout 读端 => 之后的访问日志写入触发 EPIPE
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=7303 PROXY_BACKEND_PORT=7301 \
PROXY_ALLOWED_HOSTS=dsh.example.com PROXY_ACCESS_LOG=1 \
  node runtime/deepseek-harness/node-proxy.mjs 2>err.log | (sleep 1; exit) &
sleep 1.6
curl -s -H 'Host: dsh.example.com' http://127.0.0.1:7303/ ; sleep 0.5
grep -q EPIPE err.log && echo 'EPIPE crash reproduced'
# 注：若读端在启动 banner 之前就关了，会在启动阶段以同样的 EPIPE 崩溃
```

**R3（P2-2，healthz 绕过共享密钥/Host 白名单）**

```bash
PROXY_SHARED_SECRET=s3cret PROXY_ALLOWED_HOSTS=dsh.example.com \
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=7304 PROXY_BACKEND_PORT=1 \
  node runtime/deepseek-harness/node-proxy.mjs &
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.invalid' http://127.0.0.1:7304/healthz   # 200（无 secret）
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: dsh.example.com' http://127.0.0.1:7304/api/x     # 403（要 secret）
```

**R4（P2-3，半关闭拿不到响应；含裸 Node 对照）**

```bash
# 正常响应的后端 + 代理（7306/7307）
node -e 'require("http").createServer((q,s)=>{s.writeHead(200);s.end("ok")}).listen(7306,"127.0.0.1")' &
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=7307 PROXY_BACKEND_PORT=7306 \
PROXY_ALLOWED_HOSTS=dsh.example.com PROXY_ACCESS_LOG=0 \
  node runtime/deepseek-harness/node-proxy.mjs &
sleep 0.5
node -e '
const net=require("net");
const s=net.connect(7307,"127.0.0.1",()=>{s.write("GET / HTTP/1.1\r\nHost: dsh.example.com\r\n\r\n");s.end()});
let d="";s.on("data",c=>d+=c);s.on("close",()=>{console.log("bytes:",d.length);process.exit(0)});
setTimeout(()=>{console.log("timeout; bytes:",d.length);process.exit(0)},2000)'
# 输出 bytes: 0；把同样的客户端打到一个“同步响应”的裸 Node http.Server 则有 200 响应
```

**R5（P2-4，重复 Host 首个生效）**

```bash
exec 3<>/dev/tcp/127.0.0.1/7307
printf 'GET /dup HTTP/1.1\r\nHost: dsh.example.com\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n' >&3
cat <&3    # 200；反序（evil 在前）则 403
exec 3<&-
```

**R6（P2-8，502 泄露后端地址）**

```bash
PROXY_ALLOWED_HOSTS=dsh.example.com PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=7305 \
PROXY_BACKEND_PORT=1 PROXY_ACCESS_LOG=0 node runtime/deepseek-harness/node-proxy.mjs &
curl -s -H 'Host: dsh.example.com' http://127.0.0.1:7305/x
# bad gateway: connect ECONNREFUSED 127.0.0.1:1
```

**R7（P2-7，尾点 Host：代理放行 / DSH 403）**

```bash
# 代理层（单测即断言 200）：test-runtime.mjs:349
# DSH 层（需真实 dsh 在跑，如 --host 127.0.0.1 --port 7311 --trusted-host … dsh.example.com）：
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Host: dsh.example.com.' \
  -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:7311/api/settings/describe   # 403
```

**R8（P2-14，入口脚本接受 0.0.0.0）**

```bash
bash -c 'source <(sed -n "4,12p" runtime/deepseek-harness/docker-entrypoint.sh); is_access_host 0.0.0.0 && echo accept'  # accept
```

## 6. 修复清单（按优先级；未实现，供实现方采纳）

1. **（必做，P1-1）** `healthz()` 里加“只写一次”的守卫：probe 的 `timeout`/`error` 回调先判断 `response.headersSent || response.writableEnded`（或统一 `settled` 标志），拿到响应头后 `clearTimeout`/`probe.setTimeout(0)`；整个回调加 `try/catch`。这样后端“头已发、body 卡住”只会让该 healthz 请求失败，不会崩进程。
2. **（建议发布前，P2-1）** 给 `process.stdout`/`process.stderr` 挂 `'error'` 空处理（或写入前判断 `writable`），避免 EPIPE 让进程 exit 1；同时让 `shutdown()`/启动 banner 的写日志失败不影响退出。
3. **（建议发布前，P2-2）** `/healthz` 的二选一：① 只在 `remoteAddress` 为回环（Docker healthcheck 就是回环）时响应，非回环走 Host/密钥校验；② 仍要求 `X-DSH-Proxy-Secret`（则 healthcheck 需带该头，或允许 `PROXY_HEALTHZ_TOKEN`）。无论哪种，都要同步修正 `README.md:108` 的表述。
4. **（P2-4）** 在入口 handler 里检查 `request.rawHeaders` 中 `host` 出现次数 >1 → 400（RFC 7230），与 Caddy/Go 对齐；升级路径同样处理。
5. **（P2-5）** 逐跳头按 RFC 处理：解析 `Connection` 里的 token 列表，在请求/响应两个方向一并剥离，然后再剥固定清单。
6. **（P2-6）** 入站剥离 `Forwarded`/`X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host`/`X-Real-IP`（默认剥离；如确需真实客户端 IP，增加 `PROXY_TRUST_FORWARDED=1` 时才“信任并规范化”），并据此把日志里的 `remote` 换成真实来源或明确标注 `peer`。
7. **（P2-3）** 在文档中声明“不支持半关闭客户端”，或在代理里监听 `socket 'end'` 并在请求已完成时主动 `upstream.end()`/`response.end()`（注意不要破坏正常 keep-alive）；至少补一条测试固定行为。
8. **（P2-7）** 统一 Host 规范：要么在转发前把尾点 Host 规范化（同时考虑 Origin 比较），要么在入口直接拒绝尾点 Host 并给出明确 400；把 `test-runtime.mjs:341-354` 中“尾点 200”的断言改成端到端可成立的行为（当前它掩盖了真实 403）。
9. **（P2-8/P2-9/P2-10）** 502/healthz 对外只回通用文案（`bad gateway` / `{"ok":false}`），细节只写日志；`healthz` 与 `clientError` 补齐安全头；响应侧剥离 `Server`（保持 Caddy `-Server` 语义）。
10. **（P2-11）** 增加可配置的上游超时（连接已建立后的响应头/空闲超时，默认给个几十秒），并明确 `requestTimeout`/`headersTimeout` 的选择与文档；参考 Caddy 行为但不要无限挂起。
11. **（P2-12/P2-13）** 统一日志：客户端在中途走开一律 499（含上传阶段）；WS 升级至少记 `path/remote/status=101/时长`（或在 shutdown 时汇总连接数）。
12. **（P2-14/P2-15/P2-16）** 入口校验拒绝 `0.0.0.0`/`255.255.255.255`（可选拒绝回环），并在错误信息里说明“这是浏览器访问的地址，不是监听地址”；就绪轮询上限与 `start_period` 对齐（或把 60 次改为按 120s 计算）；compose 健康检查补 `--noproxy '*'`（compose 属 task-6 范围）。
13. **（P2-17）** 修正 README “关闭 SSE”的表述，或把 shutdown 的 5s 强制退出改成可配置（`PROXY_SHUTDOWN_GRACE_MS`），并给 WS 发 close 帧后短暂等待。
14. **（P2-18）** 测试补齐：healthz 卡死（P1-1 回归测试）、重复 Host、`Connection` 点名头、半关闭、XFF 伪造、SSE/`Accept: text/event-stream`、300MiB 413、以及“真实 ws 后端断开后无泄漏”的用例；`freePort()` 改为让代理 `listen(0)` 并回读端口（现有 `startProxy` 已支持 `PROXY_LISTEN_PORT=0`，只是测试没用）。

## 7. 未验证 / 无法在本环境验证的项（明确标注）

1. **镜像构建期完整测试**：`Dockerfile:60-66` 的 `node --test` 需要构建期 PDF polyfill；本机无 docker 且库存 DSH 未打补丁，只验证了“12 个代理测试通过、2 个 PDF 测试因缺 polyfill 失败”。**未验证镜像内 14/14 全绿**。
2. **真实补丁版 DSH 的端到端功能**：`ONEPANEL_DSH_AUTH_PROXY=1` + `isAuthenticated` 补丁后的 Web UI / settings / credentials / terminal 全链路（Lead 的功能测试覆盖）。我在本机只能验证“DSH 栅栏行为 + 代理透传语义”，没有跑打补丁的实例。
3. **P1-1 在真实 DSH 上是否会被触发**：我用 mock 后端确定性复现了崩溃，但**没有**让真实 DSH 的 `GET /` 卡在“头已发、body 未完”状态；触发条件（事件循环被大上传/重活阻塞 ≥2s）是推断。
4. **300MiB body 上限 / DSH 413**：未测（只测到 4MB）。
5. **docker 网络可达性**：容器内 `0.0.0.0:8080` 对同网络其他容器的实际暴露范围、compose 默认网络的连通性（无 docker）。
6. **真实 `gosu`/`tini` 语义**：用 fake `gosu`（`shift; exec "$@"`）+ 直接跑 entrypoint 验证信号与环境；真实 gosu 的 env 继承按“不清空环境”推断（与 gosu 文档/实现一致），但未在镜像内验证。
7. **compose healthcheck 在真实 `HTTP_PROXY` 环境下的失败**：只验证了 curl 对回环会走 `http_proxy` 的语义，没有起容器实测（无 docker）。
8. **`PROXY_SHARED_SECRET` 在真实部署里由外部反代注入的端到端**（nginx 配置片段见 README:81）：未测。
9. **压缩/HTTP2**：Caddy `encode zstd gzip` 与 h2 是否必需，沿用 `reports/node-proxy-feasibility.md`（DSH 自身 gzip）的结论，本报告未重新验证。
10. **构建上下文/发布工作流**（Dockerfile 的 COPY 路径、release workflow 打 tag）：属 task-6；我只验证了 Dockerfile 中与代理/入口相关的自检与 healthcheck 路径，且 `Dockerfile` 在评审期间也改过（当前快照 sha 见 §0）。

## 8. 附：本次评审产生的证据文件（均在 gitignore 的 `.work/review-security/`，可复跑）

`adv-http.mjs`（82 项）、`adv-edge.mjs`（28 项）、`adv-crash.mjs`（9 项）、`epipe2.mjs`、`ws-lib.mjs`、`halfclose.mjs`/`halfclose3.mjs`（半关闭对照）、`idle-timeout.mjs`、`reuse-stream.mjs`、`log-abort.mjs`/`log-abort2.mjs`、`entry-clean.sh`（入口脚本桩测）、`dsh-ws-probe.mjs`（真实 DSH 栅栏）、以及 `adv2.out`/`edge2.out`/`crash2.out` 原始输出。评审期间启动的 dsh/代理/假后端进程均已清理。
