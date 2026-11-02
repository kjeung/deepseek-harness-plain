# Caddy → Node 反代：DSH 行为对照与必须复刻清单

> 对象：镜像源码 `/workspace/workspace/deployment/runtime/deepseek-harness/`（Caddyfile / Dockerfile / docker-entrypoint.sh / dsh / patch-dsh-authenticated-settings.mjs / test-runtime.mjs）＋ 本机安装的 **@deepseek-ai/dsh 0.2.1-rc.5**（`/usr/local/lib/node_modules/@deepseek-ai/dsh`）。
>
> 方法：只读源码 + 在 node 24.22.2 里 **直接 import 真实 DSH 模块并执行其准入函数**（不启动 dsh、不监听任何端口；Lead 正在 3080/8080 做实测）。凡未在本环境跑过的运行时行为均标「未验证」。
>
> 文中 `file:line` 均指 `node_modules/@deepseek-ai/<pkg>/lib/index.js`（除非另注路径）。Caddy 运行时语义（指令排序、占位符）未能本地复跑（本容器无 caddy），依据 Caddy 2.x 文档 + 构建期已执行过的 `test-runtime.mjs` 断言（Dockerfile:67）标注。

---

## 0. 一页结论

| 问题 | 裁决 |
|---|---|
| Caddy 能否被一个小 Node 反代替代？ | **可以**。需要认真对待的只有 3 类：(a) TLS/basic_auth（本次有意移除，交给外部反代）、(b) `/api` 跨站 Host/Origin 拒绝、(c) settings/credentials 端点的 Host 重写。其余是压缩、安全响应头、日志等薄层——其中**安全响应头必须由反代补上**，其余可丢。 |
| (b) 跨站拒绝 DSH 自带吗？ | **自带，总体等价且多一层**：`isTrustedApiRequest`（client-connection:240-250）同时做 Host 白名单（防 DNS rebinding）、`Sec-Fetch-Site: cross-site` 拒绝、Origin==Host 同源比较；栅栏失败 `admit()` 返回 **403**（:742-750）。DSH 比 Caddy 多一层防 rebinding 的 Host 校验；唯一更宽的地方是允许 `http://` Origin（浏览器不会对 https 页面发，见第 2 节）。 |
| (c) settings 的 Host 重写必须复刻吗？ | **不必，而且不要复刻**。在 `--trusted-host` 正确、Host+Origin 原样透传时，`/api/settings/*`、`/api/credentials/*`、`/api/llm/discoverModels` 与普通 `/api` 走完全相同的两道闸门，已用 rc.5 真实 `admit()` 执行验证为放行（端到端实测见第 9 节）。复刻"Host→127.0.0.1:3080 但保留 Origin"会 **403 forbidden**；只有连 Origin 一起删才通过，但那会削弱同站 CSRF 判别（第 3 节）。 |
| `ONEPANEL_DSH_AUTH_PROXY=1` + `isAuthenticated` 补丁还要不要？ | **仍然必须保留**。它不是"给 settings 开后门"，而是整个 Web UI 的登录替代：没有它，`GET /` → 401，入口脚本的就绪探测和镜像 HEALTHCHECK 都会失败；`/api` 全 401。浏览器无法自己拿到 `?token=`（token 只打在容器 stdout 的 `dsh web:` 日志里，且每次进程随机）。Caddy 的 basic_auth 去掉后，容器内**没有任何认证**，只剩 Host/Origin 栅栏（它不是认证），必须靠网络隔离（第 4 节）。 |
| WebSocket upgrade 路径 | 默认装配只有 **`/api/remote.mux`**（api-gateway:133、784-821，`dsh web` 恒挂载）；`/inspector/devtools/cdp`（experimental-inspector:2461-2462）仅当额外加装 experimental-inspector bundle 时出现。所有 Agent 输出/会话事件/终端/任务流都走这一条 WS；反代必须原样透传 Host+Origin，否则 UI "能点但永远不刷新"。 |
| 哪些流不能被缓冲 | `/plugins/events`（SSE，client-hmr:5/141-143，**恒挂载**）、`/api/remote.mux`（WS）、`/api/session.export`（ZIP 流，session-log-export:488/517-527）、`/api/session/uploadFileBinary`（流式请求体，client-file-upload:72/170-173）、以及所有 `/api` 响应（bridge 逐块写出，client-connection:100-113）。rc.5 的 `/api` 上**没有** SSE/NDJSON（流式 Remote 方法只能走 WS，api-gateway:919/945）。 |
| 最大请求体 | DSH 对缓冲式 `/api` 限 **300 MiB**（client-connection:30、1018），超出返回 413；Node 反代自身不得设更小上限，也不得整体缓冲。 |
| 头号实现坑 | Node 的 `http.request` 默认把 `Host` 改成目标地址（`127.0.0.1:3080`）。必须显式 `headers.host = req.headers.host` 透传浏览器原始 Host；否则**每一个 `/api` 请求都 403 forbidden**（第 3.2 节实测）。 |

---

## 1. 证据基线

| 事实 | 证据 |
|---|---|
| DSH 版本 0.2.1-rc.5（与镜像 tag 一致） | `/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json` `version` |
| `/api` 唯一准入函数 | client-connection:777-780 `isTrusted()` → `isTrustedApiRequest`；:742-750 `admit()` |
| `/api` 路由在准入前不读 body | client-connection:1045-1056（先 `admit`，拒绝即 401/403 收尾） |
| 设置/凭据端点自身**没有**额外 Host/loopback 校验 | `dsh-api-settings-controller/lib/index.js` 全文无 `connection`/`isTrusted`/`loopback`/`headers` 引用；`dsh-credentials-local`、`dsh-settings`、`dsh-api-gateway` 同样无 loopback 门槛 |
| 补丁改的是哪一行 | patch-dsh-authenticated-settings.mjs:34-35（原 `isAuthenticated` 体 → 前置 `if (process.env.ONEPANEL_DSH_AUTH_PROXY === "1") return true;`） |
| 镜像构建期确实打了补丁并跑过 Caddy 行为测试 | Dockerfile:18、:67 |
| Caddy 行为基线 | Caddyfile 全文；test-runtime.mjs:54-129 是构建期对 Caddy 的断言（Host 重写、删 Origin/Auth、403 且不转发） |

---

## 2. Caddyfile 逐指令对照矩阵

| Caddy 行为（行号） | 存在目的 | DSH 原生等价？ | 结论 | Node 反代要做什么 |
|---|---|---|---|---|
| `admin off` (Caddyfile:2) | 关闭 Caddy 管理 API | DSH 无管理 API | 无影响 | 不暴露任何管理/调试端点 |
| `auto_https disable_redirects` (:3) | 禁止自动 HTTPS 与 80→443 跳转 | 无 | 无影响 | 纯 HTTP，别做 https 跳转/308 |
| `default_sni {$CADDY_ACCESS_HOST}` (:4) | 无 SNI/按 IP 访问时仍出证书 | 无 | 随 TLS 一起消失 | 无（容器内明文） |
| `skip_install_trust` (:5) | 不把内部 CA 装进系统信任库 | 无 | 消失 | 无 |
| `tls internal` (:9) | 自签内部 CA、终结 TLS | 无（DSH 有 `--tls-cert/--tls-key`，但本次不用） | **有意放弃** | 终止 TLS 的责任整体移交给外部反代；容器内 `http://` |
| `encode zstd gzip` (:10) | 响应压缩 | **部分**：DSH 自带 gzip（web-app/cordis.patch.yml:186-188 → `compression: gzip, level 1, threshold 1024`；实现 host-webserver:196-221，**显式跳过 `text/event-stream`** :203） | zstd 丢失，gzip 仍在 | 原样透传 `Accept-Encoding`；**不要自己再压缩**（否则双重压缩/SSE 被缓）。DSH 内部把协商压成 `gzip`/`identity`（host-webserver:213-219），zstd 永远不会从 DSH 出来 |
| `basic_auth argon2id` (:12-14) | 唯一身份认证 | **无可用等价**：DSH 自身是 launch-token→cookie 认证，代理后面的浏览器拿不到 token | **有意放弃** | 交给外部反代；同时**必须保留** `ONEPANEL_DSH_AUTH_PROXY` 补丁（第 4 节） |
| `header X-Content-Type-Options nosniff / Referrer-Policy same-origin / -Server` (:16-20) | 安全响应头 | **部分**：仅 `/api/file` 返回 `X-Content-Type-Options: nosniff` + CSP sandbox（dsh-api-session-controller:2426-2429）；静态资源/索引页**没有**（frontend-static:73 只写 content-type）。Node/DSH 都不发 `Server` 头 | **会丢失** | Node 反代对所有响应加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`；不要添加 `Server` 头 |
| `@unsafe_api` + `route → respond "Forbidden" 403` (:22-30) | `/api` 及其子路径的跨站拦截：Origin 必须等于 `https://`+Host，或 `Sec-Fetch-Site: cross-site` 直接拒 | **等价**：`isTrustedApiRequest`（client-connection:240-250）+ `admit()` 403（:742-750）。差异见下 | 委托 DSH 即可 | **不要**自行改 Host/Origin/Sec-Fetch-Site；把这三者原样送给 DSH。差异点：(1) DSH 的状态码 403、body `forbidden`（client-connection:864-865），Caddy body `Forbidden`；(2) DSH 额外拒绝"Host 不在白名单又不是回环/bind 地址"（防 rebinding，:245），Caddy 只是站点 Host 不匹配→空 200；(3) Caddy 的 Origin 比较写死 `https://`，DSH 允许 `http://` Origin（isSameAuthorityOrigin:258-269）——浏览器不会对 https 页面发 http Origin，无实际缺口 |
| `@settings_api`（:26）+ `route`（:32-38）：Host→`127.0.0.1:3080`、删 Origin、删 Authorization | 让 8 个设置/凭据端点"看起来来自回环" | **不需要**（见第 3 节） | **不要复刻** | 原样透传 Host+Origin，只删 Authorization |
| 默认 `reverse_proxy 127.0.0.1:3080 { header_up -Authorization }`（:40-44） | 反代全部流量 + 去掉 Caddy basic auth 凭据 | DSH **完全不读** `Authorization`（宿主侧全包 grep 无引用） | 功能无损，纯卫生 | 继续删除 `Authorization`（以及 `Proxy-Authorization`）；**保留 Host/Cookie** |
| 站点地址 `https://{$CADDY_ACCESS_HOST}:8443`（:8）隐式 Host 匹配 | 只服务该 Host；其他 Host 返回空 200，不反代 | **部分无**：静态资源/索引页/`/plugins/events` 不做 Host 校验（frontend-static:49-96 只对索引页查 `isAuthenticated`，补丁后恒 true，资源完全不查；client-hmr:141-143 无准入）；但 `/connect`、`/open-in-app/*` 各自调用 `requestRejection`/`isTrusted`，仍有 Host 栅栏 | 轻微行为变化 | 由外部反代的 server_name 负责；若容器端口可能被旁路直连，建议 Node 反代加 Host 白名单（但仍不能替代认证，见 4.3） |
| TLS / HTTP/2 / HTTP/3 | 浏览器侧协议能力 | 容器内只有 HTTP/1.1 | 由外部反代提供 h2/h3 | 外部反代→容器用 HTTP/1.1 即可 |

补充（Caddy 运行时语义，按文档；本容器无 caddy，**未验证**）：`header` 在指令序里先于 `reverse_proxy`，故安全头同样作用于反代响应；多个 `route` 块按书写顺序互斥匹配，`@unsafe_api` 先于 `@settings_api`，所以 settings 端点先过跨站检查再被重写——这一点也被构建期 test-runtime.mjs:110-129 的断言间接固定（合法 Origin 才 200）。

---

## 3. 设置/凭据端点的 Host 重写：到底绕过了哪个检查

### 3.1 DSH 的准入链只有两道闸门

`GET /api/...`、`/api/remote.mux`、`/open-in-app/*`、`/connect` 都收敛到同一处：

1. **Host/Origin 栅栏** `isTrustedApiRequest`（client-connection:240-250）
   - Host 必须可解析（:242-244）；
   - Host 必须是：回环（127/8、localhost、::1，:127-131）、`--trusted-host` 声明值、或监听器 bind 地址（:245）；
   - `Sec-Fetch-Site: cross-site` → 拒（:246）；
   - 有 Origin 时必须 `Origin.host == Host`（按 Origin 的 scheme 归一默认端口，:247-249、:258-269）。
2. **认证** `admit()`（:742-750）：`!isTrusted → 403`；`isAuthenticated(request, secure)`（:546-548，**被补丁改成恒 true**）→ 共享 `browserPeer`；否则 `authenticateApi`（cookie 里的 operator id）→ 查不到就 401。

`settings/credentials/llm.discoverModels` 端点本身**没有第三道检查**：gateway 只按 endpoint 名分发（api-gateway:773 拦截、:876 `claimsEndpoint`、:961 `dispatchRpc`），settings-controller 直接调 `ctx.settings`。所以 Caddy 的 Host 重写只能是在绕**第 1 道**（Host 栅栏），不可能绕第 2 道（它删不掉认证；第 3.2 节实测无补丁时依旧 401）。另外 cookie 的 audience 就是 Host（`requestAudience` client-connection:307-316，cookie 名 = `dsh-auth-`+sha256(authority) :335-337，校验 :559-570），把 Host 改成 127.0.0.1:3080 会让原本的 cookie 彻底查不到——这也反证重写目标不是 cookie/secure-cookie 通道（监听器是明文 HTTP，`Secure` 本来就不会加，:347-350）。

### 3.2 用真实模块做的离线实验（不是重写逻辑，是执行 rc.5 的 `admit()`）

在 node 里 `import` 真实模块后构造 `HostConnectionService` 原型对象，喂 rc.5 的 `isTrusted`/`admit`（`trustedHosts=['127.0.0.1:3080','dsh.example.com']`，载体 host=127.0.0.1、protocol=http:，模拟入口脚本的 `--host/--trusted-host`）：

| # | 请求头（Host / Origin / 其他） | 补丁开（ONEPANEL=1） | 原版 rc.5（无补丁） | 含义 |
|---|---|---|---|---|
| 1 | `dsh.example.com` / `https://dsh.example.com` | **PEER 放行** | 401 | **Node 反代的目标行为**：Host+Origin 原样透传即可 |
| 2 | `dsh.example.com:8443` / `https://dsh.example.com:8443` | **PEER** | 401 | 文档里的 8443 直连形态同样放行 |
| 3 | `dsh.example.com:443` / `https://dsh.example.com` | **PEER** | 401 | 外部反代在 443 时 `:443` 会被 URL 归一掉 |
| 4 | `dsh.example.com:8443` / `https://dsh.example.com` | 403 | 403 | 端口不一致 = 403（反代若剥端口就出事） |
| 5 | `dsh.example.com` / `https://dsh.example.com:8443` | 403 | 403 | 端口不一致 = 403 |
| 6 | `127.0.0.1:3080`（无 Origin） | **PEER** | 401 | 这正是 Caddy 重写后的形态：栅栏过，但**认证没过** → 无补丁仍 401 |
| 7 | `127.0.0.1:3080` / `https://dsh.example.com` | 403 | 403 | **"复刻 Host 重写但忘删 Origin" = 全部 /api 403** |
| 8 | `dsh.example.com` / `https://evil.example` | 403 | 403 | 跨站 |
| 9 | `dsh.example.com` / `null` | 403 | 403 | Origin 不可解析 |
| 10 | `dsh.example.com` / 同源 + `Sec-Fetch-Site: cross-site` | 403 | 403 | 跨站 fetch |
| 11 | `attacker.invalid` / `https://attacker.invalid` | 403 | 403 | Host 不在白名单（防 rebinding） |
| 12 | 无 Host | 403 | 403 | — |
| 13 | `dsh.example.com` / `https://dsh.example.com`，但 `trustedHosts` 只有 `127.0.0.1:3080`（模拟漏传 `--trusted-host`） | 403 | 403 | 缺少 trusted-host 时整个应用不可用；重写只能救 settings 那一小撮，救不了会话/聊天 API → 重写不可能是"trusted-host 的替代" |

结论：**重写唯一改变的是第 1 道栅栏**（把 Host 变成恒可信的回环 + 用删 Origin 跳过同源比较）；它**不改变**第 2 道（第 6 行：无补丁仍 401）。今天镜像里它之所以"看起来有效"，是因为补丁已经把第 2 道整体短路了。也就是说，重写是**冗余的纵深防御**（大概率是补丁之前/早期版本的遗留：那时 settings 端点走不通，作者先想到让请求"来自回环"），而不是 settings 能保存的必要条件。

> 端到端（真 dsh 进程 + 真实 HTTP）已由 Lead 实测**验证**：`POST /api/settings/describe` 在 Host+Origin 原样透传下返回 **200**、`ok:true` 与真实数据（见第 7 节 #4-#6、第 9 节 1）。

### 3.3 若不做重写 / 做错，可观察到的失败模式

| 实现方式 | 结果 | 证据 |
|---|---|---|
| **原样透传 Host+Origin**（推荐） | `/api` 全部 200/正常 JSON；settings/credentials/discoverModels 200 | 实验 #1-#3；`admit()` 代码路径 |
| 复刻 Caddy：Host 改 `127.0.0.1:3080`，Origin 也删 | 200（靠补丁），但会失去同站 CSRF 判别（见 3.4） | 实验 #6 |
| 复刻 Host 重写、保留 Origin | **403**，body 恰为 `forbidden`，所有 8 个端点都挂（连同 CSP/静态都不受影响，仅 `/api`） | 实验 #7；client-connection:1051-1052 |
| Node 默认行为（Host 自动变成 `127.0.0.1:3080`）、Origin 保留 | **403 forbidden**（同上）——最常见的坑 | 实验 #7 + Node `http.request` 默认 Host 语义 |
| 反代剥掉 Host 端口（如 nginx `$host` 而非 `$http_host`）而浏览器 URL 带端口 | 403（Origin 端口与 Host 不一致） | 实验 #4/#5 |
| 删掉补丁、其他都正确 | `GET /` → **401** `dsh web authentication required; reopen the URL printed by dsh web.`；`/api/*` → **401** `unauthorized`；settings 不可用 | client-connection:571-577、1051-1052；实验 #1 无补丁列 |
| WS 升级同上 | 原始 HTTP 响应 `HTTP/1.1 403 Forbidden` / `401 Unauthorized`，body `forbidden`/`unauthorized`，然后连接关闭 | api-gateway:680-696、787-792 |

### 3.4 为什么"连 Origin 一起删"仍有风险（不要照抄）

Caddy 之所以敢删 Origin，是因为**它先**用 `@unsafe_api` 按"Origin 必须等于 `https://`+Host"拒了跨站，然后才重写。Node 反代如果只抄"改 Host + 删 Origin"而没有等价的跨站前置检查：

- 跨站 `<form>`/`fetch` 的浏览器请求仍带 `Sec-Fetch-Site: cross-site`，DSH 会拒（client-connection:246）——这一层还在；
- 但 `same-site`（同一注册域的不同子域）攻击面会打开：浏览器发 `Sec-Fetch-Site: same-site`，Origin 被反代删掉后 DSH 看不到不同源，直接放行。保留 Origin 时 DSH 会用 `Origin.host == Host` 拒掉（:247-249）。
- 这一点在"外部反代用 cookie 做登录"的部署里是实打实的 CSRF 面：浏览器会自动带上外部反代的会话 Cookie 到 `https://<public-host>/api/...`，Origin 栅栏是 DSH 侧唯一的跨站判别。**因此 Origin 必须原样透传。**

**裁决：Node 反代不需要、也不应该复刻 `@settings_api` 重写。** 正确做法是：把 `Host`、`Origin`、`Sec-Fetch-Site`、`Cookie` 原样转发给 127.0.0.1:3080，只删 `Authorization`/`Proxy-Authorization`。前提是运行参数保持 `--trusted-host "$HTTPS_ACCESS_HOST"`（当前入口脚本已如此，docker-entrypoint.sh:71）。

---

## 4. `ONEPANEL_DSH_AUTH_PROXY=1` + `isAuthenticated` 补丁：去掉 Caddy basic_auth 后还要吗？

### 4.1 补丁做了什么

patch-dsh-authenticated-settings.mjs:34-35 把 `BrowserAuth.isAuthenticated()` 改成：

```js
isAuthenticated(request, secure = false) {
  if (process.env.ONEPANEL_DSH_AUTH_PROXY === "1") return true;
  return this.authenticate(request, secure)?.version === COOKIE_PAYLOAD_VERSION;
}
```

影响面（rc.5 只有这几处调用 `isAuthenticated`）：`admit()`（/api、WS，:746）、`authorizeIndex()`（索引页，:494）、`authorizeIndex` 的 token 分支（:482）。即：**所有浏览器请求直接变成 owner Peer，DSH 自带的 cookie/token 体系完全旁路**。

### 4.2 裁决：**必须保留**

三条独立证据：

1. **没有它，入口脚本自己就起不来**：docker-entrypoint.sh:76-91 用 `curl -fsS http://127.0.0.1:3080/` 等就绪，60 秒超时后 `exit 1`。无补丁时 `GET /` 走 `authorizeIndex` → `isAuthenticated` false → `writeUnauthorized` 401（client-connection:494-496、571-577），`curl -f` 失败 → 容器永远起不来（除非同时改就绪判据）。
2. **没有它，HEALTHCHECK 永远 unhealthy**：Dockerfile:77-78 同样 `curl -fsS http://127.0.0.1:3080/`，401 → 失败。
3. **浏览器拿不到 token**：DSH 的 cookie 只能由 `GET /?token=<launchToken>` 换取（:458-481），token 是每进程随机（:294-300），只打印在容器 stdout 的 `dsh web: http://127.0.0.1:3080/?token=...` 里（dsh-web-app/lib/index.js:162）。外部反代不知道也转不发这个 token；用户手抄 token URL 每次重启都会失效，且 token 会进浏览器历史/日志，不可运维。

补充：
- 外部反代**不发 `Authorization`** 完全不影响结论——rc.5 宿主侧代码根本不读 `Authorization`（全包 grep 无引用），DSH 的认证只有 launch-token/cookie。
- `Cookie` 也不需要：补丁后 `isAuthenticated` 不再看 cookie；cookie 名还绑定 Host（:335-337），Host 重写场景下本来也查不到。反代照常透传 Cookie 即可（无害）。
- 若坚持"去掉补丁保住 DSH 认证"：唯一办法是让外部反代把 `?token=` 注入首次导航（读容器日志刮 token + 改 URL），同时把 readiness/healthcheck 改成带 token；token 每次重启轮换、进入日志/URL/反代配置——**明确不推荐**，且 healthcheck 仍要重写。效果上等于把"进程级 token"变成"另一个 basic_auth"，不如保留补丁简单。

### 4.3 保留补丁的安全后果（必须写进部署文档）

补丁 = "凡是过了 Host/Origin 栅栏的请求都当 owner"。而栅栏只看请求头，**不是认证**：

- 任何能直接连到 Node 反代端口的人，只要发 `Host: <HTTPS_ACCESS_HOST>`（公开域名，不是秘密）或 `Host: 127.0.0.1:3080`（回环恒可信，实验 #6），就拿到 **owner 级全权**（能改设置、读写凭据、执行 Agent/命令）。Caddy 时代这个洞被 basic_auth 挡在 8443 门口；去掉 Caddy 后容器端口边界上**没有任何凭据**。
- 因此硬性要求：Node 反代端口**只能**被外部反代访问——同一 docker 网络内 `expose`/`internal: true`，或宿主机只发布到 `127.0.0.1`，或用防火墙限定源 IP；绝不要把该端口发布到不可信网络。DSH 自己也警告"plain HTTP 必须限制给可信反代或网络"（dsh-web-app/lib/index.js:143）。
- 可选加固：外部反代注入一个共享密钥头（如 `X-DSH-Proxy-Secret`），Node 反代校验后才转发；或 Node 反代校验来源 IP。两者都比"裸端口"强，但都只是把认证挪到边缘。
- **CSRF**：补丁本身不制造 CSRF（DSH 侧没有 ambient credential 可被借用）。真正的 CSRF 目标是**外部反代的登录 Cookie**：恶意站点 `POST https://<public-host>/api/settings/update`，浏览器自动带上外部反代会话 → 外部反代放行 → DSH 看到 `Host=<public-host>`（可信）+ `Origin=https://evil.example` → 403。**这条防线成立的前提就是 Origin/Sec-Fetch-Site 原样透传**（3.4 节）。外部反代自身的 CSRF 防护应保留，属纵深。
- 结论：Caddy 的删除意味着"认证"从容器内移到容器外，容器内只剩"浏览器混淆代理"防护；这符合用户"外部反代已做 auth+TLS"的前提，但必须显式把网络边界写进部署要求。

---

## 5. WebSocket / 流式 / 长连接清单

### 5.1 HTTP Upgrade（`registerUpgrade`）全量枚举

全仓 grep `registerUpgrade` 只有 2 个**运行期**调用点（另 1 处是类型/文档产物）：

| 路径 | 注册点 | 何时存在 | 说明 |
|---|---|---|---|
| **`/api/remote.mux`** | api-gateway:133（常量）、:784-821（注册）；`dsh-web-app/cordis.patch.yml:232-241` 注释亦明示"request and upgrade passes the loopback/bind/trustedHosts policy" | **恒存在**（`dsh web` 装配里 api-gateway 必有；等 `appReady` 后注册） | 唯一承载所有 Typert Remote **流式**方法/事件的 WS mux：Agent 输出、会话事件、终端、任务日志、审批交互等。stream Remote 方法不能走 HTTP（api-gateway:919、945）。准入同样走 `admitConnection`→`admit()`：401/403 时返回原始 HTTP 响应后关连接（:680-696、:787-792）。浏览器端 URL 由 `document.baseURI` 推出 `wss://<页面host>/api/remote.mux`（client.browser.js:759-764），所以外部反代必须支持 WS；镜像按"根路径挂载"设计（索引页注入 `<base href="./">`，frontend-static:85），若外部反代要挂子路径需自行验证 baseURI/WS/静态前缀（「未验证」） |
| **`/inspector/devtools/cdp`** | experimental-inspector:2369（`DEVTOOLS_PATH`）、:2461-2462 | **仅当**额外装配 `@deepseek-ai/dsh-experimental-inspector-profile` bundle（该 bundle 单独发布，web 默认装配不含） | 把 DevTools 协议转发给容器内 Node inspector；准入用 `ctx.connection.requestRejection`（:2464），失败时向裸 socket 写 401/403。镜像默认 `dsh web` 不会注册它 |
| （无）`/plugins/events` | client-hmr:141-143 是普通 GET 路由（SSE），**不是** upgrade | 恒存在 | 见 5.2 |

**代理要求（WS）**：`upgrade` 事件里用裸 socket 双向 pipe；转发 `Sec-WebSocket-Key/Version/Protocol/Extensions`、`Upgrade`、`Connection`、以及握手包后残留的 `head` 字节；**不要**改写 Host/Origin（改写 → DSH 403/401）；不要给升级后的 socket 设空闲超时；`101` 响应与后续帧必须原样透传；客户端断开/上游断开要互相 destroy，避免半开。反代对未知 upgrade 路径可交给 DSH（DSH 对未注册路径直接 `socket.destroy()`，host-webserver:451-454）。

### 5.2 HTTP 流式（不能被缓存/缓冲）

| 路径 | 类型 | 证据 | 代理要求 |
|---|---|---|---|
| `/plugins/events` | **SSE**（`text/event-stream`，先发 `: connected`，随后 graph/rebuilt 帧） | client-hmr:5、125-137、141-143；**web 装配恒挂载**（dsh-web-app/cordis.patch.yml:218-219）。注意它**不走 `/api`**，因此既没有 Host 栅栏也没有认证（只暴露客户端模块图） | 不缓冲、逐 chunk flush；不要压缩 SSE（DSH 自己已排除该类型，host-webserver:203）；不要给它设响应超时 |
| `/api/remote.mux` | WebSocket（见 5.1） | — | 同上 |
| `/api/session.export` | `application/zip` 流（GET/HEAD） | session-log-export:488、516-527、560 | 流式透传，禁止整体缓冲；query（`sessionId`/`includeDescendants`）原样保留 |
| `/api/session/uploadFileBinary` | 流式**请求体**（`requestBody: "streaming"`，`application/octet-stream`，POST） | client-file-upload:12-60、72、170-175 | 请求体边读边写，不得整体读入内存；content-type/query 原样；客户端中断要销毁上游请求 |
| 所有 `/api/*`（RPC/JSON） | `bridge` 逐块读 `Response.body` 写回（**不是**一次性 buffer） | client-connection:40-114，尤其 :100-113；请求体默认 buffered 上限 300 MiB（:30、:1018），超限 413（:57-70） | 响应逐块转发；请求体用 pipe；反代自身不要加更小的 body 上限，也不要设 300 s 级 requestTimeout |
| `/api/file` | GET/HEAD 文件字节（DSH 内部 readBytes 后一次性返回，受图片 limit 约束） | dsh-api-session-controller:2426-2429、2482-2490 | 透传即可；其 `nosniff`+CSP 头由 DSH 自带 |
| `/`、静态资源、`/open-in-app/*`、`/connect` | 普通 HTTP | frontend-static:49-96；open-in-app:1126-1132、1265-1270；client-connection:1060-1064 | 透传；`/open-in-app/*` 和 `/connect` 的 401/403 由 DSH 判定 |

**rc.5 的 `/api` 上没有 SSE/NDJSON**：流式 Remote 方法被强制走 WS carrier（api-gateway:919/945），HTTP 侧是 unary JSON envelope。反代只要"不缓冲"即可，无需识别 NDJSON。

### 5.3 压缩、超时、缓冲的代理侧含义

- **压缩**：DSH 已 gzip（threshold 1024、排除 SSE）；反代**不要**再压。若非要压，必须排除 `text/event-stream`、已带 `Content-Encoding` 的响应（否则双重编码），且逐帧 flush。zstd 丢失可接受。
- **超时**：Node 默认 server 值（本机实测 `node -e`）：`requestTimeout=300000`、`headersTimeout=60000`、`keepAliveTimeout=5000`。建议：`requestTimeout=0`（允许 300 MiB 慢上传/长请求）、`headersTimeout` 保持 ≥60 s、`keepAliveTimeout` 提到 ~65 s（必须小于 headersTimeout），并保证外部反代的 keepalive 不短于它；上游 Agent 开 `keepAlive: true`。WS/SSE 两侧 socket 都 `setTimeout(0)`。
- **hop-by-hop**：普通 HTTP 转发时去掉 `connection, keep-alive, proxy-authorization, proxy-connection, te, trailer, transfer-encoding, upgrade`（由 Node 重新生成）；`upgrade` 场景反过来必须保留 `connection`/`upgrade`。响应侧同样去 hop-by-hop，保留 `content-type/length/encoding/cache-control/content-security-policy` 等端到端头。
- **Host**：显式 `headers.host = req.headers.host`，一字不改（含端口）。
- **URL**：转发 `req.url` 原样（origin-form）；若客户端发 absolute-form，先归一成 path+search。不要 decode/规范化路径（DSH 用 `new URL(req.url,'http://x').pathname` 精确匹配，host-webserver:381、495-504）。
- **请求体**：`req.pipe(upstream)`；收到 `client abort`/`error` 时 `upstream.destroy()`。
- **优雅退出**：SIGTERM → `server.close()`（停止 accept）+ 销毁所有 WS/SSE/keep-alive socket（Node 的 `closeAllConnections()`/自跟踪集合）→ 退出 0。入口脚本用 `wait -n`（docker-entrypoint.sh:107），任一子进程异常退出会带走容器，反代要避免把正常重连（如 WS 断开）当致命错误。
- **日志**：Caddyfile 没有 `log` 指令，所以没有逐请求访问日志；反代可打 method/path/status/耗时，**不要**打 `Authorization`/`Cookie`/请求体。
- **错误映射**：DSH 未起/连接被拒 → 返回 502（Caddy `reverse_proxy` 同样 502）；上游超时 → 504。不要把 502 变成 200 空响应。

---

## 6. Node 反代最小骨架（示意，非交付文件）

```js
import http from 'node:http'
import net from 'node:net'

const UP = { host: '127.0.0.1', port: 3080 }
const HOP = new Set(['connection','keep-alive','proxy-authorization','proxy-connection','te','trailer','transfer-encoding','upgrade'])
const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: req.headers.host }   // ★ 必须保留原始 Host
  delete headers.authorization; delete headers['proxy-authorization']
  for (const k of HOP) delete headers[k]
  const up = http.request({ ...UP, method: req.method, path: req.url, headers, agent }, (ur) => {
    const h = { ...ur.headers }
    for (const k of HOP) delete h[k]
    h['x-content-type-options'] = 'nosniff'
    h['referrer-policy'] = 'same-origin'
    res.writeHead(ur.statusCode ?? 502, h)
    ur.pipe(res)                                   // 逐块，不缓冲
  })
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  req.on('aborted', () => up.destroy())
  req.pipe(up)
})
server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 65_000
server.on('upgrade', (req, socket, head) => {
  const headers = { ...req.headers, host: req.headers.host }  // 保留 upgrade/connection/sec-websocket-*
  const up = net.connect(UP.port, UP.host, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n') + '\r\n\r\n')
    if (head.length) up.write(head)
    socket.setTimeout(0); up.pipe(socket); socket.pipe(up)
  })
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy())
})
server.listen(PORT, '0.0.0.0')   // 暴露面由网络边界控制，见 4.3
```

（`agent = new http.Agent({ keepAlive: true })`；`PORT` 建议 8080，避免与 DSH 的 3080 冲突。）

---

## 7. 请求 → 期望结果测试矩阵（实现方必须通过）

前置：`dsh web --host 127.0.0.1 --port 3080 --trusted-host 127.0.0.1:3080 "$HTTPS_ACCESS_HOST"`，`ONEPANEL_DSH_AUTH_PROXY=1`，Node 反代端口 `<P>`，外部访问主机名 `H`。

| # | 请求（对反代 `http://127.0.0.1:P`，头为浏览器视角） | 期望 | 依据 |
|---|---|---|---|
| 1 | `GET /`，`Host: H` | 200 HTML；含 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`；无 `Server` | frontend-static + Caddy 头复刻 |
| 2 | `GET /assets/<real>`，`Host: H` | 200，正确 content-type；同上安全头 | frontend-static:73 |
| 3 | `HEAD /`，`Host: H` | 200，无 body | frontend-static |
| 4 | `POST /api/settings/describe`，`Host: H`，`Origin: https://H`，`Content-Type: application/json`，body 合法 envelope | **200**，`ok:true`（**已验证**：Lead e2e，真实 dsh 0.2.1-rc.5 + Node 反代，Host+Origin 逐字透传，返回真实数据 `writable:true`、`hasDocument:true`、namespaces 含 `session-log-deepseek`/`agent-default-model`） | 实验 #1；settings-controller；Lead e2e |
| 5 | 同上，`/api/settings/update`、`/api/settings/replace`、`/api/settings/mutate` | 200（**已验证**：同一准入链，Lead e2e 200 `ok:true`；三个写方法共用同一 RPC 分发路径） | 同上 |
| 6 | 同上，`/api/credentials/describe`、`/api/credentials/set`、`/api/credentials/unset`、`/api/llm/discoverModels` | 200（**已验证**：同一准入链，Lead e2e 200 `ok:true`；同一 RPC interceptor） | 同上 |
| 7 | #4 但把 `Host` 换成未声明的主机（如 `attacker.invalid`）并配同源 `Origin: https://attacker.invalid` | **403** | 实验 #11；防 rebinding |
| 8 | #4 但 `Origin: https://evil.example` | 403 `forbidden` | 实验 #8 |
| 9 | #4 但 `Origin: null` | 403 | 实验 #9 |
| 10 | #4 但加 `Sec-Fetch-Site: cross-site` | 403 | 实验 #10 |
| 11 | 不发 `Origin` 与 `Cookie`，`Host: H` | **200**（证明补丁在生效、容器内无认证） | 实验 #1/#6 |
| 12 | `Host: 127.0.0.1:3080`，无 Origin | **200**（⚠ 若该端口可被外部直连，这就是无认证全权入口；测试应断言**网络层**不可达，或反代拒绝该 Host） | 实验 #6 |
| 13 | `GET /api/settings/describe`（该 RPC 只接受 POST） | 先过 `admit`（可能 401/403），随后 404 `not found` | client-connection:890-894 |
| 14 | `POST /api/settings/describe`，`Content-Type: text/plain` | 415 `content type must be application/json` | client-connection:894 |
| 15 | `POST /api`（未知 endpoint），`Host: H`，同源 Origin | 404 `not found` | client-connection:826-838 |
| 16 | `GET /api/file?path=/data/dsh/<file>`，`Host: H`，同源 Origin | 200 字节 + DSH 自带 `nosniff`/CSP | session-controller:2426-2429 |
| 17 | `GET /api/session.export?sessionId=<id>` | 200 `application/zip`，首字节在 TTFB 内出现（不缓冲） | session-log-export:488/560 |
| 18 | `POST /api/session/uploadFileBinary?sessionId=<id>`，`application/octet-stream`，>10 MB chunked | 200 JSON；反代 RSS 不随 body 线性增长 | client-file-upload:170-175 |
| 19 | `POST /api/settings/update` 请求体 301 MiB | 413（由 DSH 返回）；反代不得先返回 413/崩溃 | client-connection:30/57-70 |
| 20 | `GET /plugins/events`，`Host: H` | 200 `text/event-stream`，先到 `: connected`，后续帧持续到达（60 s 不断） | client-hmr:125-137 |
| 21 | WS 握手 `GET /api/remote.mux`，`Upgrade: websocket`，`Host: H`，`Origin: https://H` | **101 Switching Protocols**（**已验证**：Lead e2e）；握手后持续收发帧未单独验证 | api-gateway:784-821；Lead e2e |
| 22 | #21 但 `Origin: https://evil.example` | 原始 HTTP 403，body `forbidden`，连接关闭 | api-gateway:680-696 |
| 23 | #21 但反代把 Host 改成 `127.0.0.1:3080` 而保留 Origin | 403（同 3.2 实验 #7） | 同上 |
| 24 | `GET /connect?token=x` | 401 `unauthorized`（`/connect` 只认 launch token，补丁不覆盖） | client-connection:505-539、1060-1064 |
| 25 | `GET /open-in-app/apps`，`Host: H`，同源 Origin | 200 JSON；坏 Origin → 401/403 空 body | open-in-app:1265-1281 |
| 26 | 任一 `/api` 请求带 `Authorization: Basic ...` | DSH 视图里**没有**该头（用 mock 后端断言；真实 DSH 不读它） | 全包 grep 无引用 |
| 27 | DSH 进程停掉后请求任意路径 | 502（不是 200/挂起） | Caddy `reverse_proxy` 行为对等 |
| 28 | 同时开 1 个 SSE + 1 个 WS + 连续 RPC，持续 10 min | 无断流、无 502、无内存增长 | 长连接/超时设置 |
| 29 | 容器收 SIGTERM | 停止 accept，WS/SSE 被关闭，进程退出 0；不产生僵尸连接 | 入口脚本 `wait -n` |
| 30 | 健康检查 `GET /`（`Host: 127.0.0.1:3080`，容器内） | 200（保留现有 HEALTHCHECK 语义） | Dockerfile:77-78 + 补丁 |

正的端到端判定（#4-#6、#21）建议直接复用/改造现有 `test-runtime.mjs`：#110-118 的断言从 "Host 被改成 127.0.0.1、Origin 不存在" 改为 "Host 与 Origin **原样到达** mock 后端、Authorization 被删"；#121-129 的 403/不转发断言若改为委托 DSH，则"不得到达 DSH"不再成立（请求会到达 DSH 并在准入处 403），测试语义要相应调整。

---

## 8. 与现有镜像的差异面（只列"因去掉 Caddy 而必须改"的）

| 文件 | 需要改的点 | 保留的点 |
|---|---|---|
| `Caddyfile` | 删除 | 其行为已被第 2 节矩阵取代 |
| `Dockerfile` | 删 caddy 二进制 COPY(:43)、caddy 用户/组(:48-50)、`/data/caddy`(:53)、Caddyfile COPY(:59)、构建期 Caddy 测试(:67 的 caddy 用例)；`EXPOSE 8443`(:75) 改为反代端口(如 8080) | `tini`(:82)、`--help` 自检(:46-47)、`HEALTHCHECK`(:77-78)、`STOPSIGNAL`(:80)、uid/gid fixup、`/data/dsh`、pnpm |
| `docker-entrypoint.sh` | 删 `caddy hash-password`(:46)、用户名/密码校验(:36-44)、caddy 目录(:51)、`caddy run`(:93-100)、CA 提示(:104)；新增启动 Node 反代并加入 `pids`/`wait -n`(:107) | `is_access_host` 校验(:4-21,31-34)——`HTTPS_ACCESS_HOST` 仍是 `--trusted-host`；就绪探测(:75-91)；`ONEPANEL_DSH_AUTH_PROXY=1`(:68) 与 `--trusted-host`(:71)；`trap`/`gosu`(:53-64) |
| `patch-dsh-authenticated-settings.mjs` | **不改** | 补丁仍然必须打 |
| `test-runtime.mjs` | 用 Node 反代测试替换 Caddy 用例（第 7 节；mock 后端断言 Host/Origin 透传、Authorization 删除、403 语义、WS/SSE 不缓冲） | PDF/Iterator 两个用例 |
| `dsh` wrapper | 不改 | — |
| docker-compose / README / .env / 卷 | 删 `DSH_AUTH_*`、`8443`/TLS/CA 章节、`/data/caddy` 卷；加"外部反代必须保留 Host（`$http_host`）、透传 Origin、支持 WS、`client_max_body_size` ≥300 MiB、不缓冲 SSE、容器端口只对反代开放" | `/data/dsh`、`/workspace` |
| `HTTPS_ACCESS_HOST` | 仍必填（作为 `--trusted-host`；填错 → 403/白屏，与今天一致） | 校验规则不变 |

---

## 9. 未验证 / 待 Lead 实测确认清单

1. ~~**端到端**~~ → **已验证（Lead e2e）**：真 `dsh web` 0.2.1-rc.5（127.0.0.1:4555，`--trusted-host 127.0.0.1:4555 example.test`，补丁以 Node loader 复刻镜像的 `isAuthenticated` 编辑）+ 130 行 Node 反代（0.0.0.0:8080，透传 Host/Origin、转发 upgrade），无 Caddy/TLS/auth。观察结果：`POST /api/settings/describe`（Host `example.test`、Origin `http://example.test`）→ **200** `ok:true` 真实数据（`writable:true`、`hasDocument:true`）；Host `evil.test` → **403** `forbidden`；可信 Host + 交叉 Origin → **403**；`Sec-Fetch-Site: cross-site` → **403**；`GET /` → **200**（37,971 B）；无补丁实例同请求 → **401**（`GET /` 与 settings 均是），佐证补丁是承重的。
2. **Caddy 运行时细节**：指令排序（`header` 先于 `route`）、`{http.request.hostport}` 对 Host 端口为零的取值、`encode` 是否对已 gzip 响应跳过、未知 Host 的空 200——本容器无 caddy，未复跑；仅有 Caddy 2.x 文档语义 + 构建期 test-runtime.mjs 断言。
3. **zstd 实际收益**：DSH 已 gzip 的情况下 Caddy 只剩少量小响应/SSE 的压缩机会，带宽差多少未测。
4. **experimental-inspector 的 `/inspector/devtools/cdp`** 在镜像默认装配下不存在（仅凭 profile bundle 未安装推断）；如其被启用，反代需同样透传。
5. **Node 反代端口号的最终选择**（8080？）与 `EXPOSE`/compose 映射、健康检查是否改探反代，取决于实现方案（见 `notes/alternatives.md`）。
6. **外部反代（1Panel/nginx）自身**是否保留 Host、透传 Origin、支持 WS、body limit——属部署验证，不在本容器范围。
