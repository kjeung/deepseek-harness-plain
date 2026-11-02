# 可行性报告：去掉登录认证 + 用 Node 反向代理替代 Caddy

> 场景：容器前面已经有一层反向代理（1Panel/OpenResty/Nginx）负责**登录认证**与 **TLS**，
> 容器内**不需要** basic auth、不需要 TLS。目标：移除 `DSH_AUTH_USERNAME` / `DSH_AUTH_PASSWORD` 及关联登录逻辑，
> 并把 Caddy 换成 Node 转发。
>
> 结论基于**真实 DSH 0.2.1-rc.5 进程 + 130 行 Node 代理的实测**（不是纸面推演），
> 证据与复现命令见 `notes/caddy-parity.md` 与第 9 节；代码仓库已克隆在 `runtime/`。
>
> **状态：方案 A 已实施。** `runtime/deepseek-harness/` 中已删除 `Caddyfile`，入口脚本去掉
> 用户名/密码校验、argon2 哈希与证书/CA 逻辑，新增生产版 `node-proxy.mjs`（约 490 行：
> Host 白名单、安全响应头、访问日志、健康检查、可选共享密钥、优雅退出），构建期测试重写为
> 14 个代理用例并通过；`docker-compose.yml` 改为明文 8080、默认只发布到宿主机 127.0.0.1。
> 下面的可行性数据仍是该实现的依据。

---

## 0. 结论摘要

**可行。** 三项核心能力都在实测中通过：HTTP、WebSocket（`/api/remote.mux` 101）、
settings/credentials 等 8 个敏感端点（200 `ok:true`），以及 DSH 自带的 Host/Origin 跨站栅栏（403 生效）。

但有 **4 个必须先接受的结论**：

| # | 结论 | 影响 |
|---|---|---|
| 1 | 删掉 `DSH_AUTH_*` 和 Caddy `basic_auth` **不等于**去掉认证：DSH 自身还有一道浏览器认证，靠镜像里的 `ONEPANEL_DSH_AUTH_PROXY=1` 补丁绕过。补丁**必须保留**（去掉后 `GET /` 就是 401，容器连就绪探测都过不了）。 | 容器内从此**没有任何认证**。谁摸到反代端口、发一个公开域名的 `Host` 头，就是 owner 全权（能改设置、读凭据、执行 Agent 命令）。安全边界 100% 转移到网络层。 |
| 2 | Caddy 里那段"settings 端点改写 Host 到 127.0.0.1、删 Origin"的逻辑**是冗余的**，Node 反代不要照抄。实测把 `Host`+`Origin` 原样透传，`/api/settings/describe` 直接 200。照抄反而容易踩坑：改 Host 但忘删 Origin → 8 个端点全 403。 | 少写一段易错逻辑；但 **Host 必须原样透传**（Node `http.request` 默认会把 Host 改成 `127.0.0.1:3080`，那就是全站 `/api` 403）。 |
| 3 | Caddy 真正**不可替代**的只有两样：TLS（本次不要）和 basic_auth（本次不要）。其余都是薄层：跨站 403 由 DSH 原生覆盖（还多一层防 DNS rebinding 的 Host 白名单），压缩由 DSH 自己 gzip，只有 `X-Content-Type-Options` / `Referrer-Policy` 两个安全头需要反代补上。 | 替代成本主要集中在：正确实现流式与 WS 透传 + 重写构建期测试。 |
| 4 | 如果目标只是"不要登录、不要 TLS"，最省的方案**不是**写 Node 代理，而是把 Caddy 改成明文 HTTP（约 30 行改动）。这条路径已被实测：用**镜像里那把 Caddy v2.11.4 二进制**跑"明文 + 无 basic_auth"，settings 改写、跨站 403、未知 Host 空 200、zstd/gzip、h2c、WebSocket 101、优雅退出全部保留。写 Node 代理的额外收益是：少一个进程、小约 17 MB（压缩层）、去掉 Caddy 依赖；代价是自研代理的正确性风险。 | 两条路都可行，见第 7 节对比。**取决于你要的到底是"无认证/无 TLS"还是"去掉 Caddy"。** |

**成本量级**：原型（已有、可跑）约 130 行；生产化 + 重写构建期测试约 **1.5–3 人日**；
镜像减小 **17.3 MB**（Caddy 压缩层）/ 解压后 48.5 MB；请求延迟增加 **0.0–0.22 ms**（实测，keep-alive 下 500 请求均值）；
进程内存 +约 20 MB。运行期风险从"配置正确性"变成"自研代理正确性"，但可用测试矩阵兜住。

---

## 1. 需求拆解与前提

| 需求 | 现状 | 改动本质 |
|---|---|---|
| 移除登录验证 | Caddy `basic_auth argon2id` + 入口脚本校验/哈希三件套 | 删 Caddy 认证 + 删入口校验；**但必须保留 DSH 的 auth 旁路补丁** |
| 移除 TLS | Caddy `tls internal` 自签 + 内部 CA + 8443 | 容器内改为明文 HTTP 端口；证书/CA/信任步骤全部消失 |
| Caddy → Node 转发 | Caddy 反代 + `/api` 跨站栅栏 + settings 特判 | 一个 Node `http.Server`：Host 透传、流式、WS upgrade 透传、补安全头 |
| 外部反代 | 当前无 | 新版必须：保留 Host（`$http_host`）、透传 Origin、支持 WS、不缓冲 SSE、body 上限 ≥300 MiB |

前提假设（需要你确认）：外部反代与容器在**同一主机/同一 docker 网络**，容器端口不会暴露到不可信网络。
若外部反代在另一台机器上，明文回源会把流量（含 Agent 会话内容）暴露在网络上，不建议。

---

## 2. Caddy 在容器里到底承担什么（逐项裁决）

| Caddy 行为 | 存在的意义 | DSH 原生等价 | 去掉的后果 | Node 反代要不要做 |
|---|---|---|---|---|
| `tls internal` + 8443 | TLS 终结、自签 CA | 无 | **有意放弃**（外部反代负责） | 不做，监听明文 HTTP |
| `basic_auth argon2id` | 唯一身份认证 | 无（DSH 是 launch-token→cookie，浏览器拿不到 token） | **有意放弃** | 不做；但**保留** `ONEPANEL_DSH_AUTH_PROXY` 补丁 |
| `@unsafe_api` 403 | `/api` 跨站拦截 | ✅ 等价且更强：`isTrustedApiRequest`（Host 白名单 + Origin==Host + `Sec-Fetch-Site`） | 无功能损失；状态码仍 403、body `forbidden` | **不要自己判**，把 Host/Origin/Sec-Fetch-Site 原样送 DSH |
| `@settings_api` Host→127.0.0.1、删 Origin/Auth | 让 settings 走通（历史遗留） | ✅ 不需要（实测 200） | 无损失 | **不做**；Host+Origin 原样透传，只删 `Authorization` |
| `encode zstd gzip` | 压缩 | ✅ 部分：DSH 自带 gzip（level 1，>1KB，排除 SSE） | 只丢 zstd；gzip 仍在 | 透传即可，**不要二次压缩** |
| `X-Content-Type-Options` / `Referrer-Policy` / `-Server` | 安全响应头 | ❌ 仅 `/api/file` 自带 | **会丢失** | **要补前两个**；`Server` 头 Node 本来不发 |
| 站点 Host 匹配（未知 Host 空 200） | 只服务指定域名 | ⚠️ 部分：DSH 对静态资源/`/plugins/events` 不校验 Host | 轻微：任意 Host 能取到前端资源（但 `/api` 403） | 建议加 Host 白名单 |
| HTTP/2、HTTP/3、自动证书 | 浏览器侧协议 | 无 | 外部反代可提供 | 不需要 |
| 访问日志 | — | 当前 Caddyfile **没有** `log` 指令（本来就没有访问日志） | 无变化 | 建议顺手加结构化日志 |

---

## 3. 实测：真实 DSH + Node 代理

### 3.1 测试环境

| 项 | 值 |
|---|---|
| DSH | `@deepseek-ai/dsh@0.2.1-rc.5`（与镜像 tag 同版本），`dsh web --no-open --host 127.0.0.1 --port 4555 --trusted-host 127.0.0.1:4555 example.test` |
| 认证旁路 | 用 Node 模块加载钩子复刻镜像补丁：`isAuthenticated()` 在 `ONEPANEL_DSH_AUTH_PROXY=1` 时恒 `true`（`patch-dsh-authenticated-settings.mjs:34-35` 的同一处改动） |
| Node 代理 | `prototype/node-proxy.mjs`，130 行，监听 `0.0.0.0:8080 → 127.0.0.1:4555`，**无 TLS、无认证**，保留 Host/Origin，转发 upgrade |
| 外部主机名 | `example.test`（通过 `--trusted-host` 声明，模拟公网域名） |

### 3.2 结果

| # | 测试 | 结果 | 结论 |
|---|---|---|---|
| 1 | `GET /`（Host: example.test） | 200，37,971 B，27 ms | 静态资源正常 |
| 2 | `POST /api/settings/describe`，Host+Origin 透传 | **200 `ok:true`**，返回真实命名空间数据（`writable:true`、`hasDocument:true`、`session-log-deepseek`、`agent-default-model`…） | **settings 端点无需 Host 重写** |
| 3 | 同上但 `Host: evil.test` | 403 `forbidden` | DSH 原生防 DNS rebinding 生效 |
| 4 | 同上但 `Origin: http://evil.test` | 403 `forbidden` | 同源校验生效 |
| 5 | 同上但 `Sec-Fetch-Site: cross-site` | 403 | 跨站 fetch 拦截生效 |
| 6 | `GET /api/remote.mux` WS 握手（Host+Origin 透传） | **101 Switching Protocols** | **WebSocket 必须、且可以透传** |
| 7 | WS 握手但 Host 不可信 / Origin 跨站 | 403 / 403 | WS 路径也有栅栏，不是裸通道 |
| 8 | 流式（后端 3 chunk × 400 ms） | TTFB 0.434 s，总 1.232 s | 代理**不缓冲**，LLM 流式输出正常 |
| 9 | 8 MB 请求体 | 字节完全一致（8,388,608） | 大 body 透传正常 |
| 10 | 50 并发 GET | 50 × 200 | 并发正常 |
| 11 | 延迟（keep-alive，500 请求 × 3 轮） | 直连 1.21–1.39 ms/req；代理 1.22–1.61 ms/req；**开销 0.00–0.22 ms** | 性能代价可忽略 |
| 12 | 代理进程 RSS | 65–82 MB（Node 基线约 60 MB） | 增量约 20 MB |
| 13 | **不打补丁**的 DSH | `GET /` → 401；settings → 401 | **补丁是载荷**，删 Caddy 也得保留 |
| 14 | DSH `--host 0.0.0.0` | 被拒：`is an unspecified (wildcard) address, which is not supported: ... would expose remote code execution to the network` | 必须靠代理（或绑具体容器 IP，见 7-C） |
| 15 | 压缩响应头 | DSH 自己返回 `Vary: Accept-Encoding` + `Content-Encoding: gzip` | Caddy `encode` 非必需 |

> 复现：`prototype/node-proxy.mjs` + `notes/caddy-parity.md` 第 7 节 30 条测试矩阵。
> 未验证项：真实容器内构建/运行、真实浏览器全流程、>10 分钟长稳、300 MiB 超大 body（只测到 8 MB）。

### 3.3 对照实验：方案 B（保留 Caddy、只改明文、去认证）也实测过

为了确认"是不是非写 Node 代理不可"，用**从镜像层解包出来的同一把 Caddy v2.11.4 二进制**跑了
"Caddyfile 改 `http://:8080`、删 `tls internal`、删 `basic_auth`"的配置，实测保留：

| 能力 | 结果 |
|---|---|
| 普通页面/静态资源 | 200 |
| settings/credentials 改写路由 | 生效（`Host→127.0.0.1:3080`、删 Origin/Authorization） |
| 跨站 `/api` 拦截 | 403 保留 |
| 未知 Host | 空 200 保留（Caddy 站点匹配） |
| 压缩 | zstd + gzip 保留 |
| HTTP/2 | TLS 下 h2/h3 丢失（预期）；**明文 h2c 实测可用**（`--http2-prior-knowledge` → 200/HTTP2） |
| WebSocket | 101 保留 |
| SIGTERM 优雅退出 | 保留 |

结论：**方案 B 用配置改动就拿到了 A 想要的全部运行时行为**（只少 TLS/basic_auth，正是需求），
代价只是镜像里仍留着 Caddy（17.3 MB 压缩 / 48.5 MB 解压）和一个 Caddy 进程。
详细记录见 `notes/alternatives.md` §2.6。

### 3.4 对照实验：方案 C（完全不要代理）

| 试验 | 结果 |
|---|---|
| DSH `--host 0.0.0.0` | 拒绝（原文见上） |
| DSH `--host localhost` | 拒绝：`host "localhost" is not a concrete IPv4 or IPv6 address literal` |
| DSH `--host <容器 eth0 IP>` | 启动成功，日志警告：`listening on ... over plain HTTP; restrict this port to a trusted proxy or network` |
| 容器 IP 变化后仍绑旧 IP | 启动失败 `EADDRNOTAVAIL` → 重启循环 |
| 不给 `--trusted-host`，Host 写成绑定 IP | **200**（绑定 IP 本身被 DSH 围栏信任） |

结论：C 技术上能跑，但容器 IP 在 compose 重建后会变、且"Host=绑定 IP"天然可信 + 补丁关闭了认证，
等于把无认证控制面直接暴露在容器网络上。**不推荐**。

---

## 4. 结论一：settings 的 Host 改写可以删

Caddy 里那段特殊路由看起来像"必须"：

```
@settings_api path /api/settings/... /api/credentials/... /api/llm/discoverModels
route @settings_api { reverse_proxy 127.0.0.1:3080 { header_up Host 127.0.0.1:3080; header_up -Origin; header_up -Authorization } }
```

它实际绕过的只是 DSH 的**第一道闸门**（Host/Origin 栅栏，`isTrustedApiRequest`），不是认证。
实测证据：把 Host+Origin 原样透传，settings 返回 **200 `ok:true`**；而"照抄 Caddy、把 Host 改成回环但保留 Origin"会
直接 403（`Origin.host != Host` 不同源）。

**正确做法**：Node 反代把 `Host`、`Origin`、`Sec-Fetch-Site`、`Cookie` 原样转发，只删 `Authorization` / `Proxy-Authorization`。
前提是启动参数继续带 `--trusted-host "$HTTPS_ACCESS_HOST"`（入口脚本现在就是这么做的）。
**头号坑**：Node 的 `http.request` 默认会把 `Host` 改成目标地址；不显式 `headers.host = req.headers.host`，
每一个 `/api` 请求都会 403。

> 为什么不能"连 Origin 一起删"：删掉 Origin 后 DSH 失去同源判别，只剩 `Sec-Fetch-Site`。
> 在**外部反代用 Cookie 做登录**的部署里，这是实打实的 CSRF 缺口（same-site 子域攻击）。
> Caddy 之所以敢删，是因为它先用 `@unsafe_api` 的 Origin 检查挡过一遍；Node 反代没有这层就不该删。

---

## 5. 结论二：认证边界必须显式声明

`ONEPANEL_DSH_AUTH_PROXY=1` + 补丁 = "凡是过了 Host/Origin 栅栏的请求都当 owner"。
**栅栏不是认证**：只看请求头。

- 任何能连到反代端口的人，发 `Host: <公开域名>`（公开信息）或 `Host: 127.0.0.1:3080`（回环恒可信），
  就拿到 owner 全权 —— 等价于容器内 RCE（Agent 可以执行命令、读写 `/data/dsh` 里的凭据）。
- Caddy 时代这个洞被 `basic_auth` 挡在 8443；去掉之后，**容器端口边界上没有任何凭据**。

硬性要求（写进部署文档）：

1. 反代端口**只能**被外部反代访问：`expose` + docker `internal: true` 网络，或宿主机只发布 `127.0.0.1:8080:8080`，或防火墙限定源 IP。
2. 外部反代保留 Host（nginx 用 `$http_host` 而不是 `$host`，否则丢端口导致 Origin/Host 不一致 → 403）。
3. 外部反代必须透传 `Origin`、`Sec-Fetch-Site`、`Cookie`；必须支持 WebSocket 升级。
4. 可选加固：外部反代注入共享密钥头（如 `X-DSH-Proxy-Secret`），Node 反代校验通过才转发 —— 纵深防御，不能替代网络隔离。

---

## 6. Node 反代必须实现的职责清单

| 必要性 | 事项 | 说明 |
|---|---|---|
| **必须** | 保留原始 `Host`（含端口） | 否则 `/api` 全 403 |
| **必须** | 透传 `Origin` / `Sec-Fetch-Site` / `Cookie` | CSRF 防线 |
| **必须** | 转发 `upgrade`：`/api/remote.mux` 裸 socket 双向 pipe（含握手后的 `head`） | 不做则 UI"能打开但永不刷新"；这是唯一承载 Agent 输出/会话事件/终端的通道 |
| **必须** | 响应逐块转发，不缓冲；请求体 pipe | `/plugins/events`（SSE）、`/api/session.export`（ZIP）、`uploadFileBinary`、所有 `/api` |
| **必须** | 移除 hop-by-hop 头；WS 场景反过来保留 `Connection`/`Upgrade` | |
| **必须** | 删 `Authorization` / `Proxy-Authorization` | 外部反代的凭据不该进 DSH |
| **必须** | 补 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin` | Caddy 丢失的安全头 |
| **必须** | 上游错误 → 502，超时 → 504；客户端断开 → 销毁上游 | 别把 502 变成空 200 |
| **建议** | Host 白名单（等于 `HTTPS_ACCESS_HOST`） | 补 Caddy 的站点匹配；DSH 对静态资源不限 Host |
| **建议** | `server.requestTimeout = 0`、`headersTimeout ≥ 60s`、`keepAliveTimeout ≈ 65s`、上游 `keepAlive: true` | Node 默认 `requestTimeout=300s` 会掐长上传；`keepAliveTimeout=5s` 与 nginx 默认 75s 冲突会产生偶发 502 |
| **建议** | WS/SSE socket `setTimeout(0)` | 不能被空闲超时切断 |
| **建议** | 不压缩（或排除 SSE / 已编码响应） | DSH 已 gzip |
| **建议** | 结构化访问日志（method/path/status/耗时，不含 Authorization/Cookie/body） | 现在 Caddy 也没开日志，属于改善 |
| **建议** | 优雅退出：SIGTERM → 停止 accept + 销毁长连接 | 入口脚本用 `wait -n`，任一子进程退出会带走容器 |

请求体上限：DSH 对 `/api` 缓冲式请求限 **300 MiB**（超出 413）；反代不要设更小上限，
外部反代的 `client_max_body_size` 也必须 ≥ 300 MiB，否则大文件上传先被外部反代 413。

---

## 7. 代价评估

### 7.1 代码改动面（相对当前镜像源码 `runtime/deepseek-harness/`）

| 文件 | 现状 | 改动 | 净变化（估） |
|---|---|---|---|
| `Caddyfile` | 45 行 | 删除 | −45 |
| `Dockerfile` | 82 行 | 删 `FROM caddy` 阶段、caddy 二进制 COPY、caddy 用户/组、`/data/caddy`、Caddyfile COPY、构建期 Caddy 测试；`EXPOSE 8443`→`8080`；加 `COPY node-proxy.mjs` | −10 / +3 |
| `docker-entrypoint.sh` | 108 行 | 删 `is_access_host`+self-test、用户名/密码校验、`caddy hash-password`、caddy 目录、`caddy run`、CA 提示；加启动 Node 反代并纳入 `pids`/`wait -n` | −45 / +10（→ 约 55 行） |
| `node-proxy.mjs` | 无 | 新增（原型 130 行；生产含日志/白名单/优雅退出约 200–250 行） | +200~250 |
| `test-runtime.mjs` | 130 行 | 保留 PDF 两个用例（1–53 行）；用代理测试替换 Caddy 用例（54–130 行，77 行） | −77 / +120 |
| `patch-dsh-authenticated-settings.mjs` | 70 行 | **不改**（补丁仍必须打） | 0 |
| `dsh` wrapper | 11 行 | 不改 | 0 |
| compose / `.env` / README | — | 删 `DSH_AUTH_*`、TLS/CA/8443 章节与 `/data/caddy` 卷；端口 8443→8080；补"外部反代要求" | 文档重写 |
| 环境变量 | 3 必填 | **`HTTPS_ACCESS_HOST` 保留**（作为 `--trusted-host`），删 `DSH_AUTH_USERNAME`、`DSH_AUTH_PASSWORD`；可改名 `ACCESS_HOST` | 3 → 1 |

### 7.2 各维度代价

| 维度 | 代价 | 量级/说明 |
|---|---|---|
| 开发 | 原型已完成并实测通过；生产化重写测试 | **1.5–3 人日**（含测试矩阵 30 条） |
| 镜像体积 | 少一个 Caddy 静态二进制（压缩层 −17.3 MB / 解压 −48.5 MB） | `usr/bin/caddy` = **48,521,378 B（46.3 MiB）**，镜像层压缩后 **17.3 MB（16.5 MiB）** |
| 进程/内存 | 少 Caddy、多一个 Node 进程 | 反代 RSS ≈ 20 MB 增量 |
| 请求延迟 | 多一跳 | **0.00–0.22 ms/req**（实测） |
| 吞吐 | Node 单线程 vs Go | 单用户/小团队无感；高并发下 Node 是瓶颈（本场景可忽略） |
| 功能损失 | zstd、HTTP/2/3（容器跳）、Caddy 站点 Host 匹配、Caddy 的 CSRF 二次检查、Caddy 生态（限流/重试等可插件） | 跨站由 DSH 原生覆盖；安全头需自己补 |
| 安全 | 容器内**无认证**；栅栏≠认证 | 必须网络隔离；建议共享密钥头 |
| 运维 | 无证书/CA 管理；但失去 Caddy 的成熟度 | 需自建访问日志、监控、升级回归测试 |
| 维护 | 自研代理是长期资产 | DSH 升级不大可能改 HTTP 语义；但每次升级要跑回归 |
| 迁移 | 旧部署的 `/data/caddy` 作废；`/data/dsh`、`/workspace` 不变 | 会话/设置/凭据全部保留；浏览器书签从 8443 改新端口 |

---

## 8. 三种方案对比与建议

| 维度 | **A. Node 反代**（用户提案） | **B. Caddy 明文 HTTP（去 TLS/去认证）** | **C. 完全不要代理** |
|---|---|---|---|
| 改动 | 删 Caddyfile，新增 ~200 行代理，重写构建期测试 | 改 Caddyfile 3 处（站点头 `http://:8080`、删 `tls internal`、删 `basic_auth`）+ 入口删校验/哈希/3 个 env；测试小改 | 入口直接起 `dsh web`，绑容器 IP |
| 改动量 | 大（~300 行净变化） | **小（~30 行）** | 中（但需运行时探测 IP） |
| 镜像 | −17.3 MB（压缩层），少一个进程 | 不变（仍带 48.5 MB Caddy） | −17.3 MB，少一个进程 |
| 安全性 | 需自行补安全头、Host 白名单；CSRF 靠 DSH 栅栏 | 与当前一致（少了 TLS 与认证，但保留安全头与 settings 逻辑） | 最差：无安全头、无 Host 匹配，DSH 直接暴露在容器网络 |
| 可行性 | **已实测通过**（真 DSH + 130 行代理） | **已实测通过**（镜像内 Caddy 2.11.4 跑明文/无认证） | **条件可行**：`--host <容器 IP>` 能启动，但 `localhost` 被拒、IP 漂移会 `EADDRNOTAVAIL`，不推荐 |
| 性能 | +0–0.22 ms；无 h2c | 最优（Go、h2c、zstd/gzip 保留） | 最优（无代理），但只有 HTTP/1.1 |
| 风险 | 自研代理正确性（流式/WS/超时），最高 | 低（只删配置，行为由构建期测试兜底） | 高（IP 漂移 + 无认证暴露 + Host=绑定 IP 天然可信） |
| 维护 | 自己维护代理 | 跟着 Caddy 升级 | 跟随 DSH |
| 适合 | 想去掉 Caddy 依赖、接受自研代理 | **只想"无认证、无 TLS"** | 不推荐 |

### 建议

1. **如果目标仅仅是"外部已做认证和 TLS，容器内不要登录、不要证书"** → 选 **B**。
   改动最小、风险最低，settings/CSRF/安全头全部保持原样；代价只是镜像里仍带 Caddy、仍有一个 Caddy 进程。
   具体改法：Caddyfile 站点地址改 `http://:8080`，删 `tls internal` 与 `basic_auth` 块；入口脚本删
   `is_access_host` 之外的认证校验、`caddy hash-password`、`CADDY_ACCESS_HOST`/`DSH_AUTH_*` 注入；
   compose 端口 8443→8080，删 `/data/caddy` 卷与证书章节。约 30 行。

2. **如果目标是"去掉 Caddy 这个依赖/进程/体积"** → 选 **A**，但按第 6 节清单实现并跑第 7 节测试矩阵。
   已证明可行，主要成本是测试重写与长稳验证；务必加 Host 白名单、安全响应头、访问日志。

3. **C 不可行**：DSH 明确拒绝 `0.0.0.0`（原文：*"binding every interface would expose remote code execution to the network"*），
   而绑容器 IP 会在 compose 重建后漂移，需要入口脚本动态探测，反而更脆。

---

## 9. 若要实施（方案 A 或 B）的落地清单

**共同部分**

- [ ] `HTTPS_ACCESS_HOST` 保留为必填（`--trusted-host`）；改名则同步 compose/文档/校验。
- [ ] 保留 `ONEPANEL_DSH_AUTH_PROXY=1` 与 `patch-dsh-authenticated-settings.mjs`（**否则 401，容器起不来**）。
- [ ] 删 `DSH_AUTH_USERNAME` / `DSH_AUTH_PASSWORD` / `argon2` 哈希 / Caddy 密码校验错误提示。
- [ ] `/data/dsh`、`/workspace` 卷不变；`/data/caddy` 卷删除；旧部署可直接复用数据目录。
- [ ] 端口 8443 → 8080（或保留 8443 只改协议，便于外部反代配置不变）。
- [ ] 健康检查改探新端口（或继续探 3080，语义不变）。
- [ ] 部署文档写死外部反代要求：保留 Host、透传 Origin、WS、不缓冲、body ≥300 MiB、容器端口隔离。

**方案 A 额外**

- [ ] `node-proxy.mjs` 生产化：Host 白名单、安全头、访问日志、502/504、`requestTimeout`/`keepAliveTimeout`、优雅退出。
- [ ] 重写 `test-runtime.mjs` 的 Caddy 用例为代理用例（35 条矩阵：settings/credentials 200、Host/Origin/cross-site 403、WS 101、SSE 不缓冲、大 body、502、SIGTERM）。
- [ ] 长稳验证：SSE + WS + 连续 RPC 并发 10 分钟以上；300 MiB 上传；客户端中途断开。
- [ ] `EXPOSE` 与 compose 端口、README、`.env.example` 同步。

**方案 B 额外**（已用镜像内 Caddy 2.11.4 实测可行）

- [ ] Caddyfile：站点 `http://:8080`；删 `tls internal`、`basic_auth`；保留 `@unsafe_api`/`@settings_api`（无害且有用）。
- [ ] 入口脚本：删 `caddy hash-password`、删 `DSH_AUTH_*`/`CADDY_ACCESS_HOST` 注入；保留 caddy 进程管理与就绪探测。
- [ ] 构建期测试：`test-runtime.mjs` 的 77 行 Caddy 用例改为明文 HTTP（Origin 仍用 `https://` 模拟外部 TLS），保留 settings 改写与 403 断言，删 401 basic_auth 断言——否则构建期测试（Dockerfile:67）会失败。
- [ ] 文档删证书/CA 章节；外部反代回源 scheme 从 `https` 改 `http`。
- [ ] 建议给 Caddy 默认路由加 `header_up -Cookie`：DSH 打补丁后用不到外部登录 Cookie，回源时没必要带进容器。

---

## 10. 风险登记

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| 无认证端口被直连 | 端口发布到 0.0.0.0 或容器网络可达 | **owner 全权（RCE 级）** | 只发布到 `127.0.0.1` / `internal` 网络 / 防火墙白名单；可选共享密钥头 |
| Host 被改写 | 反代默认 `Host: 127.0.0.1:3080`；外部反代用 `$host` 丢端口 | 全站 `/api` 403（白屏/设置打不开） | 显式 `headers.host = req.headers.host`；文档要求 `$http_host` |
| Origin 被删 | 照抄 Caddy settings 逻辑 | same-site CSRF 缺口 | 原样透传 Origin |
| WS 未透传 | 代理只处理 request 事件 | UI 打开但不刷新、任务无输出 | 实现 upgrade 透传 + 测试 101 |
| 响应被缓冲 | 代理用 `await response.arrayBuffer()` / 中间件聚合 | 流式失效，长任务超时 | 逐块 pipe；测试 TTFB |
| 超时/502 | Node `keepAliveTimeout=5s` 与 nginx 75s 冲突；`requestTimeout=300s` 掐上传 | 偶发 502 / 大文件上传失败 | `keepAliveTimeout≈65s`、`requestTimeout=0`、上游 keepAlive |
| body 上限 | 外部反代默认 1 MB | 上传/长 prompt 413 | `client_max_body_size` ≥300 MiB，代理不设更小值 |
| 子路径部署 | 外部反代把 DSH 挂在 `/dsh/` | WS 地址/静态资源错乱（`baseURI` 推导） | 尽量根路径挂载；子路径需专门验证 |
| 构建期测试失效 | 沿用 Caddy 断言 | CI 假绿/假红 | 按矩阵重写测试 |
| 外部登录 Cookie 进容器 | 外部反代不回源剥离 Cookie | 会话凭据出现在容器网络/日志里 | 外部反代认证后剥离 `Cookie`；B 可加 `header_up -Cookie` |
| 长稳问题 | WS/SSE 长时间运行 | 断流、内存增长 | 10 分钟混合负载验证，必要时加 socket 计数 |

---

## 11. 未验证事项

1. 真实容器构建与运行（本环境无 Docker）；镜像内 `EXPOSE`/HEALTHCHECK 改动效果。
2. 真实浏览器完整流程（登录由外部反代模拟，未接真实 1Panel/nginx）。
3. 300 MiB 超大请求体（只测到 8 MB）。
4. 10 分钟以上 SSE+WS+并发 RPC 长稳。
5. 子路径（`/dsh/`）挂载行为。
6. 外部反代实测配置（保留 Host、WS、body 限制）——属部署验证。
7. 方案 B 已用镜像内 Caddy 2.11.4 二进制验证过明文/无认证配置，但**未在真实镜像里构建运行**，也未接真实外部反代。

---

## 附录 A：原型与复现

- 原型代码：`prototype/node-proxy.mjs`（130 行，已实测；**不是生产代码**，缺 Host 白名单/日志/优雅退出）。
  同目录还有复刻补丁的加载钩子、假后端、WS/栅栏测试脚本，使用说明见 `prototype/README.md`。
  交付前已用该目录重跑一遍：`GET /` 200、settings `ok:true`、WS 101、非法 Host/跨站 403。
- 详细对照与 30 条测试矩阵：`notes/caddy-parity.md`。
- 三方案逐项对比（含方案 B 的 Caddy 实测记录、C 的 IP 绑定试验）：`notes/alternatives.md`。
- 复现步骤（本环境已验证）：

```bash
# 1) 起真实 dsh（用加载钩子复刻镜像的 isAuthenticated 补丁）
DSH_HOME=$PWD/.run/dsh HOME=$PWD/.run/dsh/home ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals --import ./prototype/register.mjs \
  /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --no-open --host 127.0.0.1 --port 4555 --trusted-host 127.0.0.1:4555 example.test

# 2) 起代理
LISTEN_PORT=8080 BACKEND_PORT=4555 node prototype/node-proxy.mjs

# 3) 验证 settings（Host+Origin 透传，无需改写）
curl -sS -X POST -H 'Content-Type: application/json' \
  -H 'Host: example.test' -H 'Origin: http://example.test' \
  -d '{"type":"client-request","rpcId":"1","method":"settings/describe","payload":{"args":{}}}' \
  http://127.0.0.1:8080/api/settings/describe | head -c 200

# 4) 验证 WS 101 与栅栏
node prototype/ws-test.mjs 8080 example.test http://example.test
```

## 附录 B：环境变量变化

| 变量 | 现在 | 方案 A/B 之后 |
|---|---|---|
| `HTTPS_ACCESS_HOST` | 必填，Caddy 证书 SAN + `--trusted-host` | **必填**，仅作 `--trusted-host`（建议改名 `ACCESS_HOST`） |
| `DSH_AUTH_USERNAME` | 必填 | **删除** |
| `DSH_AUTH_PASSWORD` | 必填 | **删除** |
| `CADDY_ACCESS_HOST` / `DSH_AUTH_PASSWORD_HASH` | 入口派生 | 删除 |
| `ONEPANEL_DSH_AUTH_PROXY` | 入口写死 1 | **保留**（载荷） |
| `DSH_HOME` / `DSH_TELEMETRY_DISABLED` / `HOME` | 镜像内置 | 不变 |
| `DSH_PERMISSION_MODE` / `DSH_TOOLS_MODE` / `DEEPSEEK_API_KEY` / 代理变量 | 可选 | 不变 |
| 新增 `PROXY_PORT`（可选） | — | 反代监听端口，默认 8080 |
