# 去认证 / 去 TLS 三种部署方案评估

> 方案 A（Node 反代替换 Caddy）、B（保留 Caddy 但只提供明文 HTTP、去掉 basic_auth）、C（无代理，DSH 直接绑定容器 IP）。
>
> 评估对象：发布镜像 `1panel/deepseek-harness:0.2.1-rc.5` 对应的运行时代码
> `/workspace/workspace/deployment/runtime/deepseek-harness/`（只读，未修改）。
> 实测环境：DSH **0.2.1-rc.5**、Node **v24.22.2**、从发布镜像层中提取的 Caddy **v2.11.4**；本容器**没有 docker**，镜像未运行。
> 文中「实测」= 本机命令可复现；「未验证」= 本环境无法证实（无 docker / 未跑完整镜像链路 / 未做性能压测）。

---

## 0. 结论速览

| 方案 | 一句话结论 | 推荐度 |
|---|---|---|
| **B：Caddy 保留、改明文、去 basic_auth** | 改动最小（Caddyfile 约 -5/+1 行、entrypoint 约 -20 行、构建期测试重写 77 行），Caddy 的 settings 改写、`@unsafe_api` 403、压缩、WebSocket、优雅退出、健康检查语义全部保留；只丢掉 TLS 与 basic_auth（正是需求）。 | **推荐** |
| **C：无代理，DSH 直绑容器 IP** | 技术上可行（`--host 172.18.0.6` 实测可启动），但安全最差：DSH 直接监听网络，且「Host = 绑定 IP」本身被 DSH 信任，补丁又关闭了 DSH 自身认证 → **任何能连到端口的人都能无认证操作**；还要改 HEALTHCHECK、处理容器 IP 不稳定。仅适合「外部代理同机、端口只发布到 127.0.0.1 且有防火墙」的场景。 | 条件可用，不推荐 |
| **A：用 Node 重写反代替换 Caddy** | 为了实现「无认证、无 TLS」这一简单目标，重写 120–250 行安全敏感代理，并重写构建期测试；必须自己复刻 WebSocket、流式、hop-by-hop、Host/Origin、settings 改写、压缩、优雅退出。收益低、长期维护成本最高。 | 不推荐 |

**三个跨方案的关键结论（先看这三条）：**

1. **「去掉 Caddy 的 basic_auth」不等于「容器内没有认证」。** DSH 自己还有一层浏览器认证（进程级 `?token=` 换 30 天签名 Cookie，DSH 源码 `dsh-client-connection/lib/index.js:410-430、458-494`）。镜像通过构建期补丁 `ONEPANEL_DSH_AUTH_PROXY=1` 把 `isAuthenticated()` 改成恒真（`patch-dsh-authenticated-settings.mjs:8、32-37`，entrypoint:68 注入环境变量），这才是真正关闭容器内认证的开关。
   **A/B/C 都必须保留这个补丁**，否则浏览器会收到 `401`（未打补丁的 rc.5 实测：`GET /` 无 Cookie → 401；访问日志里的 `?token=` URL 才能换到 Cookie）。另一种做法是让用户每次启动后手工访问带 `?token=` 的 URL，但该 URL 的主机是容器内地址、且每次重启换新 token，在外部反代场景不可运维。**不要**为了「少一个补丁」而删掉它。
2. **A/B/C 的容器内认证都只剩「无认证」**，外部反代是唯一认证点。它必须覆盖 **所有路径（含 `/api/remote.mux` WebSocket 与静态资源）**，并且保证容器端口不能被绕过外部代理直接访问。否则任何方案都等于把「能执行命令、能改凭据」的 Agent 暴露给能访问该端口的人。
3. 在本环境里 **B 是唯一能做到「改动小 + 保留 Caddy 既有安全行为」的方案**；A 和 C 都删掉 Caddy，但 A 用同样风险的代码替换它、C 则直接把 DSH 暴露出去。除非有「镜像必须去掉 Caddy 二进制（体积/CVE 扫描）」这类硬性要求，否则没有理由选 A/C。

> 数字口径：镜像层压缩后总大小 305,364,136 B（约 305.4 MB / 291.2 MiB，未计 config 层）；Caddy 层压缩后 17,294,751 B（约 17.3 MB），`/usr/bin/caddy` 未压缩 48,521,378 B（约 48.5 MB）。均从 Docker Hub Registry API 直取实测，见 §2.4。

---

## 1. 现状基线：镜像里到底有几层安全

当前镜像（`Dockerfile:1-82`、`docker-entrypoint.sh:1-108`、`Caddyfile:1-45`）的链路：

```text
浏览器 ── HTTPS:8443（Caddy tls internal 自签 + basic_auth argon2id）──▶ Caddy
       ── HTTP 127.0.0.1:3080（Host 原样/或改写，删 Authorization）──▶ dsh web（已打 ONEPANEL_DSH_AUTH_PROXY=1 补丁）
```

| 层 | 位置 | 作用 | A | B | C |
|---|---|---|---|---|---|
| Caddy TLS（`tls internal`） | `Caddyfile:9` | 容器内 HTTPS、自签 CA；外部反代需信任 `/data/caddy/pki/authorities/local/root.crt` | 删除 | 删除 | 删除 |
| Caddy basic_auth（argon2id） | `Caddyfile:12-14`；entrypoint:46、96-99 | **容器内唯一用户认证**，返回 401/`WWW-Authenticate` | 删除 | 删除 | 删除 |
| Caddy `@unsafe_api` 403 | `Caddyfile:22-30` | `/api`、`/api/*`：Origin 非空且 ≠ `https://`+Host:port，或 `Sec-Fetch-Site: cross-site` → 403 `Forbidden` | **需自行复刻**（否则仅靠 DSH 围栏，见下） | 保留 | 丢失（靠 DSH 围栏等价物） |
| Caddy `@settings_api` 改写 | `Caddyfile:26、32-38` | settings/credentials 类接口：Host 改成 `127.0.0.1:3080`、删 Origin 与 Authorization | **建议复刻**（实测可只保留 Host+Origin 也通，见 §2.6） | 保留 | 不需要（实测可保留 Host+Origin） |
| Caddy 安全头/压缩 | `Caddyfile:10、16-20` | `encode zstd gzip`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、`-Server` | 需自行复刻（压缩可依赖 DSH gzip） | 保留 | 丢失（可由外部反代补） |
| DSH Host/Origin 围栏 | `dsh-client-connection/lib/index.js:240-265` | 每个 `/api` 请求：Host 必须是 127/8、`localhost`、监听绑定 IP 或 `--trusted-host`；`Sec-Fetch-Site: cross-site` 拒绝；有 Origin 时必须与 Host 同 authority，否则 403 `forbidden` | 保留 | 保留 | 保留 |
| DSH 浏览器认证 + 补丁 | `dsh-client-connection/lib/index.js:458-494、546-548`；`patch-dsh-authenticated-settings.mjs:32-37` | 未打补丁：token→Cookie 认证；打补丁且 `ONEPANEL_DSH_AUTH_PROXY=1`：`isAuthenticated()` 恒真，即**容器内没有任何认证** | **必须保留补丁** | **必须保留补丁** | **必须保留补丁** |

两个容易误解的点：

- **DSH 的 Host/Origin 围栏不是认证。** 它只防 DNS rebinding 与浏览器跨站请求；不发送 Origin 的非浏览器客户端可以直接通过。打补丁后，只要 Host 命中「绑定 IP / `--trusted-host`」，请求就放行（实测见 §2.6）。
- **DSH 的 `/`（SPA/静态资源）不走 `isTrustedApiRequest`。** 打补丁后，即使 Host 是 `attacker.invalid`，`GET /` 也返回 200（实测）；只有 `/api` 路由会被 Host/Origin 围栏拦。真正的安全边界在 `/api` + 外部反代。

### 1.1 entrypoint 现有职责的归属（A/B/C）

当前 `docker-entrypoint.sh`（108 行）的每一项职责在新方案中的去留——这就是「哪些必须活下来、哪些会消失」的清单：

| 职责（当前行号） | A（Node 反代） | B（Caddy 明文） | C（无代理直绑 IP） |
|---|---|---|---|
| 3 行 1Panel 横幅（:23-25） | 保留/可删 | 保留 | 保留 |
| `HTTPS_ACCESS_HOST` 校验（:4-12、:31-34） | 保留（仍要给 DSH `--trusted-host`） | 保留（Caddy 站点地址 + DSH trusted-host） | 保留（用于 `--trusted-host`；若改名为 `DSH_ACCESS_HOST` 需同步 `:14-21` 的 self-test） |
| 用户名/密码校验 + argon2 哈希（:36-46） | **删除** | **删除** | **删除** |
| `unset` 敏感 env（:47） | 保留（删除密码/用户名校验后至少 unset access host 之外的残留） | 同上 | 同上 |
| `/data/dsh`、`/workspace` 属主/权限修正（:49-50） | 保留 | 保留 | 保留 |
| `/data/caddy` 属主修正（:51） | 删除 | 保留（Caddy 仍写 autosave/PKI 目录） | 删除 |
| tini + trap + `wait -n` 双进程监督（:53-62、:106-108） | 保留 | 保留 | **改为单进程 `exec`**（tini 仍是 PID 1，信号直达 DSH） |
| DSH 启动参数 `--host 127.0.0.1 --port 3080 --trusted-host 127.0.0.1:3080 "$access_host"`（:64-73） | 保留（DSH 仍 loopback） | 保留 | **改为运行时发现容器 IPv4 + `--port 8443` + `--trusted-host "$access_host"`** |
| 60 次 curl 的就绪等待（:75-91） | 保留（DSH ready 后再起代理） | 保留 | 删除（单进程；外部反代需容忍启动期 502） |
| Caddy 启动与 auth env（:93-104） | **换成 Node 代理启动** | 保留启动，删 auth env | **删除** |
| 打印访问地址 / CA 路径（:103-104） | 改为打印代理地址 | 改为打印 `http://<host>:8443` | 改为打印 `http://<容器IP>:8443` |

→ 共同点：**uid/gid 修正（root 启动后 gosu 降权）、tini/SIGTERM、DSH 就绪等待、`--trusted-host` 必须保留**；**用户名/密码校验 + argon2、Caddy 进程监督**随方案不同而删除或替换。B 唯一保留全部 entrypoint 结构（只删 auth 相关）；A 替换最后一段；C 把脚本大部分删掉。

---

## 2. 实测证据（本机可复现，命令已清理进程/临时目录）

### 2.1 DSH 版本与 `--host` 约束（选项 C 的核心）

```bash
node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --help
# --host <host>: one concrete IPv4 or IPv6 literal of a local interface; wildcard addresses are rejected
# --trusted-host <authority...>: extra authority the /api browser-trust fence accepts (host or host:port; repeatable)
```

| 试验 | 结果（实测） |
|---|---|
| `--host 0.0.0.0` | exit 1，原文：`error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`（DSH 源码同文案：`dsh-web-app/lib/startup.js:48`、`dsh-host-webserver/lib/index.js:255`） |
| `--host localhost` | 启动失败：`webserver: host "localhost" is not a concrete IPv4 or IPv6 address literal`（`dsh-host-webserver/lib/index.js:142`）→ **C 只能写 IP 字面量，不能写主机名/DNS 名** |
| `--host 172.18.0.6 --port 6801`（本容器 eth0 IPv4） | 成功。启动日志：`dsh web: listening on 172.18.0.6 over plain HTTP; restrict this port to a trusted proxy or network`（`dsh-web-app/lib/index.js:143`），并打印 `http://172.18.0.6:6801/?token=...` |
| `--host 172.18.0.99`（本机不存在的 IP） | 启动失败：`dsh: startup failed: 2 required plugins did not activate … Error: listen EADDRNOTAVAIL: address not available 172.18.0.99:6803` → **容器 IP 变化后若仍绑旧 IP，容器会启动失败并进入重启循环** |

### 2.2 选项 C 的 `--trusted-host`：必须是外部访问域名（可带端口）

在 `172.18.0.6:6810` 用 `--trusted-host dsh.example.com`（**不带端口**）启动后（打了补丁）：

| 请求 Host | `POST /api/settings/describe` |
|---|---|
| `dsh.example.com` | 200 |
| `dsh.example.com:8443` | 200 |
| `dsh.example.com:9999` | 200 |

→ **无端口条目匹配任意端口**（源码 `dsh-client-connection/lib/index.js:196-213` 的 `isTrustedAuthority`）；因此外部反代无论转发 `Host: domain` 还是 `Host: domain:port`，`--trusted-host domain` 都能覆盖。若写成 `--trusted-host domain:8443`，则只匹配该端口（源码同段，未逐一实测）。当前 entrypoint 传的正是 `"$access_host"`（无端口），是稳妥写法。

不给 `--trusted-host` 时（端口 6808，打了补丁、只绑 172.18.0.6）：

| Host | `POST /api/settings/describe` |
|---|---|
| `dsh.example.com` | **403 forbidden** |
| `attacker.invalid` | **403 forbidden** |
| `172.18.0.6:6808`（即绑定 IP） | **200（成功返回设置数据）** |

最后一行是选项 C 的关键安全问题：**绑定 IP 本身就被 DSH 围栏信任**（源码 `isBindAddressAuthority`，`dsh-client-connection/lib/index.js:225-233`），所以「能连到容器 IP」的客户端只要把 Host 写成该 IP 就能过围栏；打补丁后围栏后面没有认证，等于直接拿到完整控制面（设置、凭据都可写，见 §2.5）。

### 2.3 选项 C 是否仍需要 `ONEPANEL_DSH_AUTH_PROXY=1`：需要

| 实例 | 请求 | 结果 |
|---|---|---|
| 未打补丁（原始 0.2.1-rc.5） | `GET /`、Host 外部域名、无 Cookie | **401**（body 68B：`dsh web authentication required; reopen the URL printed by dsh web.`） |
| 未打补丁 | 先 `GET /?token=<启动URL里的token>` | **303**，`Set-Cookie: dsh-auth-…; Max-Age=2592000; HttpOnly; SameSite=Strict`；带该 Cookie 再 `GET /` → **200**（37,971B HTML） |
| 未打补丁 | 带 Cookie 后 `POST /api/settings/describe` | 穿过围栏并到达 RPC（返回业务错误，不是 401） |
| 打了等价补丁（运行时 loader，见 §2.7） | `GET /` 无 Cookie | **200** |
| 打了等价补丁 | `POST /api/settings/describe` 无 Cookie、Host 外部域名 + 同源 Origin | **200，`{"ok":true,...}` 完整设置数据** |

→ **C（以及 A/B）若要「浏览器透明访问、无需每次拿 token」，补丁必须保留。** 这不是「优化」，而是前提：未打补丁时 entrypoint 的就绪探测 `curl -fsS http://127.0.0.1:3080/` 也会因 401 失败（实测 `GET /` 无 Cookie = 401），按 `docker-entrypoint.sh:75-91` 的逻辑，60s 后会打印 `DeepSeek Harness did not become ready within 60 seconds.` 并退出；镜像 `HEALTHCHECK` 同理（`curl -fsS` 对 401 非零）会永远 unhealthy。

### 2.4 镜像体积：Caddy 占多少

从 Docker Hub Registry API 取 amd64 manifest（匿名 token）实测：

| 项 | 数值 | 说明 |
|---|---|---|
| 镜像层压缩后总和 | **305,364,136 B ≈ 305.4 MB（291.2 MiB）** | 16 个层相加；未计 config blob（12,699B） |
| Caddy 层（`COPY /usr/bin/caddy`，manifest layer 序号 6，从 0 计） | **17,294,751 B ≈ 17.3 MB（16.5 MiB）** | layer digest `sha256:6bbc1139…c03a`；解包后仅 `usr/bin/caddy` |
| `/usr/bin/caddy` 未压缩 | **48,521,378 B ≈ 48.5 MB（46.3 MiB）** | 从该层解包实测 |
| Caddy 版本 | **v2.11.4**（`caddy version`：`v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=`） | 与 Dockerfile:1 `FROM caddy:2.11.4` 一致 |

→ A/C 去掉 Caddy 后，镜像层下载体积约减少 **17.3 MB（约 5.7%）**；解压后磁盘占用约减少 **48.5 MB**。B 体积不变。

### 2.5 补丁后的权限面：设置与凭据接口无认证可达

在 `172.18.0.6:6807`（等价补丁、无 Cookie）：

| 请求 | 结果（实测） |
|---|---|
| `GET /`，Host `dsh.example.com` | 200 |
| `GET /`，Host `attacker.invalid` | 200（SPA 静态资源不受 `/api` 围栏保护） |
| `POST /api/settings/describe`，Host `dsh.example.com` + `Origin: https://dsh.example.com` | 200，返回完整设置、`writable:true` |
| `POST /api/settings/describe`，Host `dsh.example.com`，无 Origin | 200 |
| `POST /api/credentials/set`（payload 不完整） | 到达业务层，返回 `gateway/arguments-invalid`（**不是 401/403**）→ 任何过围栏的客户端都能写凭据 |
| 同源但 `Origin: https://dsh.example.com:8443`、Host `dsh.example.com`（端口不一致） | **403**（DSH 要求 Origin 与 Host 逐字同 authority，含端口） |
| `Origin: https://evil.invalid` | 403 `forbidden` |
| `Sec-Fetch-Site: cross-site` | 403 `forbidden` |
| `Host: attacker.invalid` + `Origin: https://attacker.invalid` | 403 `forbidden` |

结论：**打补丁后容器内没有认证，只有「Host/Origin 围栏」**。围栏能挡浏览器跨站/DNS rebinding，但挡不住直接 HTTP 客户端（可省略 Origin、可伪造 Host）。因此外部反代必须做真正的认证，并且容器端口必须不可被绕过。

### 2.6 选项 B：用镜像里的 Caddy 2.11.4 跑「明文、无 basic_auth」实测

把镜像层里的 `caddy` 二进制作进临时目录，使用最小改动的 Caddyfile B（仅把 `https://` 改 `http://`，删 `tls internal`、`basic_auth`、`default_sni`、`skip_install_trust`，其余 settings/unsafe/headers/encode 全保留），后端用回显 headers 的 Node stub（替换 3080）：

| 测试 | 结果（实测） |
|---|---|
| 无 `Authorization` 头、普通请求 | **200**（说明 basic_auth 已去掉；后端收到 `Host: dsh.example.com:6805`、`X-Forwarded-*`、`Via: 1.1 Caddy`） |
| `POST /api/settings/describe`，同源 Origin，带 `Authorization: Basic abc` | **200**；后端收到 `Host: 127.0.0.1:6806`、**无 Origin、无 Authorization** → `@settings_api` 改写保留 |
| `POST /api/settings/update`，`Origin: https://evil.invalid` | **403 Forbidden**，请求未达后端 |
| `POST /api/credentials/set`，`Origin` 同源但 `Sec-Fetch-Site: cross-site` | **403**，未达后端 |
| Host `attacker.invalid:6805` | **200、空 body** → 站点 Host 不匹配时的「空 200」行为保留 |
| 安全头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、无 `Server`、有 `Via: 1.1 Caddy` |
| 压缩（后端返回 4,363B JSON） | `Accept-Encoding: zstd, gzip` → `Content-Encoding: zstd`，196B；`gzip` → 209B；无压缩 → 4,363B |
| WebSocket（`/api/remote.mux`，后端 `upgrade` 回 101） | **101 Switching Protocols**；后端看到 `upgrade /api/remote.mux host=dsh.example.com:6805` |
| HTTP/2 | 普通 curl：`http_version=1.1`；`--http2-prior-knowledge`：**200，`http_version=2`（h2c）**。Caddy 启动日志：`HTTP/2 skipped because it requires TLS`、`HTTP/3 skipped because it requires TLS` |
| 优雅退出 | `SIGTERM` 后日志：`servers shutting down with eternal grace period` → `shutdown complete`，exit 0 |
| 访问日志 | 配置无 `log` 指令；多次请求后 `http.log.access` 计数 **0** → **当前镜像实际没有访问日志**（只有 Caddy 生命周期/错误 JSON 日志到 stderr） |

→ **选项 B 的功能保留度非常高**：只丢了 TLS/basic_auth（需求）、TLS 下的 h2/h3；h2c、zstd/gzip、WebSocket、空 200 Host 行为、settings 改写、`@unsafe_api` 403、优雅退出全部实测保留。

### 2.7 补丁的等价性说明（重要，避免夸大）

本机没有 docker，无法运行发布镜像，更无法修改只读安装目录里的 DSH。为验证「补丁开/关」的行为差异，使用了一个**运行时 `--import` loader**，对 `dsh-client-connection/lib/index.js` 注入与镜像补丁**同一行**的代码：

```js
if (process.env.ONEPANEL_DSH_AUTH_PROXY === "1") return true;
```

这与 `patch-dsh-authenticated-settings.mjs:32-37` 的构建期补丁语义相同。**镜像内补丁是否真的打上**（构建期执行、脚本自带校验）属「未验证」，只能依据 Dockerfile:14-18 与脚本 40-42 的构建失败保护推断；本文所有「补丁后」行为都用上述等价 loader 实测。

### 2.8 DSH 自身的压缩行为（影响 A/C 的「压缩功能损失」判断）

- `dsh-web-app/cordis.patch.yml:186-188` 给 web profile 的 webserver 设了 `compression: gzip`、`compressionLevel: 1`、`compressionThresholdBytes: 1024`；webserver 默认值是 `none`（`dsh-host-webserver/lib/index.js:109`），但 web profile 覆盖为 gzip。
- 实测：`GET /`（前端 HTML，未打补丁+Cookie 实例实测 37,971B）加 `Accept-Encoding: gzip` → `200`、`Content-Encoding: gzip`、`Transfer-Encoding: chunked`；打补丁实例同一文件同样返回 `Content-Encoding: gzip`。
- 因此 **A/C 即使不实现压缩，DSH 响应仍有 gzip**；失去的是 Caddy 的 zstd（且在下游是真实 DSH 时，Caddy 会把 `Accept-Encoding` 降为 gzip 再转发给 DSH，DSH 先 gzip，Caddy 通常不会再 zstd 重编码——这一点在真实 DSH 链路上**未实测**，只用 stub 后端实测了 Caddy 自身的 zstd 能力）。

---

## 3. 方案 A：用 Node 反代替换 Caddy（用户的提案）

### 3.1 精确改动范围（相对当前仓库）

| 文件 | 改动 | 行数规模（约） |
|---|---|---|
| `Dockerfile` | 删 `FROM caddy:2.11.4 AS caddy`（:1）、`COPY --from=caddy /usr/bin/caddy`（:43）、caddy 用户（:48-50）与 `/data/caddy` 目录（:53；:51-52 是 dsh/workspace 目录，必须保留）、`COPY Caddyfile`（:59）；新增 `COPY proxy.mjs`；`EXPOSE`/`HEALTHCHECK` 可保持不变（DSH 仍在 127.0.0.1:3080） | -10/+1 行 |
| `docker-entrypoint.sh` | 删 `DSH_AUTH_USERNAME/PASSWORD` 读取与校验（:28-29、:36-44）、`caddy hash-password` 与对应 unset（:46-47）；删 `/data/caddy` 的 `install -d`（:51）；把 Caddy 启动段（:93-104）改为启动 Node 代理；保留 DSH 启动、60s 就绪等待、`wait -n` 双进程监督、trap/gosu | -20/+5 行 |
| `Caddyfile` | **删除整个文件（45 行）** | -45 行 |
| 新增 `proxy.mjs` | HTTP 反代：请求/响应流式转发、hop-by-hop 头处理、`Host`/`Origin` 保留、`@unsafe_api` 复刻、安全头、压缩策略（settings 路径**不要**复刻 Host 改写/删 Origin，理由见 §3.2）、WebSocket upgrade（`/api/remote.mux`，以及 devtools `/inspector/devtools/cdp` 若启用）、错误处理、SIGTERM 优雅退出 | **新增约 120–250 行**（估计） |
| `test-runtime.mjs` | 第 54-130 行（77 行）是 Caddy 专属测试（`caddy hash-password`、https、basic_auth 401、settings 改写、403、空 200）。A 下 Caddy 不存在，必须整段重写为 Node 代理测试 + 至少一个 WebSocket 升级测试 | 77 行 → 约 120–200 行（估计） |
| `dsh` wrapper | **不变**（11 行，只负责 `gosu node` + `DSH_HOME/HOME`） | 0 |
| `patch-dsh-authenticated-settings.mjs` | **不变（必须保留 auth 补丁 + PDF 兼容补丁）** | 0 |
| `docker-compose.yml` / `.env.example` / `README.md` | 预期要改（不属本任务写入范围）：`DSH_AUTH_USERNAME/PASSWORD` 不再需要、`CADDY_DATA_DIR` 不再需要、端口注释改为明文 HTTP、外部反代回源 scheme 改 http | 见各自负责人 |

### 3.2 丢失的功能（相对当前镜像）

| 能力 | A 之后 |
|---|---|
| TLS / 自签 CA / `/data/caddy` | 按需求删除 |
| basic_auth（容器内唯一认证） | 按需求删除（此后外部反代是唯一认证） |
| Caddy `@unsafe_api` 403 | **需要重写**，否则只剩 DSH 自身的等价围栏（能力上接近，但少了 Caddy 这层统一拦截；静态资源本来就不受 DSH 围栏保护） |
| settings/credentials 的 Host 改写 + Origin/Authorization 删除 | **不必复刻，建议不要复刻**。本机实测（rc.5 + 等价补丁）表明：**保留外部 Host + 同源 Origin 也能让 `settings/describe` 正常返回**；Caddy 的改写只是「把 Host 变成恒可信的回环 + 用删 Origin 跳过同源比较」，在补丁短路认证后属冗余纵深防御。A 若复刻「改 Host + 删 Origin」，反而让这些接口绕过 DSH 的 Origin 同源检查；必须同时保留 `@unsafe_api` 的前置跨站 403 才不削弱安全。 |
| `encode zstd gzip` | 只能靠 DSH 的 gzip（实测有效）；zstd 丢失，需要自己实现（Node 24 `zlib` 的 zstd 支持为实验性；未在此验证），且要防「上游已 gzip 又二次压缩」 |
| 安全响应头 | 需要自己加（DSH 全局不加 `X-Content-Type-Options`/`Referrer-Policy`；只有 account-platform 自己的登录页有 CSP） |
| WebSocket 升级 | **必须自己实现**：DSH 至少注册两类 upgrade 路由：`/api/remote.mux`（`dsh-api-gateway/lib/index.js:133、785、820`）与开发用 devtools `/inspector/devtools/cdp`（`dsh-experimental-inspector/lib/index.js:2369、2462`）。B 里这是 Caddy 自动完成的（实测 101） |
| 优雅退出 | 必须自己实现（DSH 自己有 SIGTERM 处理：`lib/profile-boot-C14i-8IN.js:280-285` + webserver close/closeAllConnections `dsh-host-webserver/lib/index.js:470-500`；代理层若直接退出会切断进行中的流/WS） |
| HTTP/2 | Node `http` 只有 HTTP/1.1；失去 Caddy 明文下的 h2c。浏览器侧由外部反代负责，实际影响很小 |
| 访问日志 | 无损失：当前 Caddyfile 没有 `log` 指令，**本来就没有访问日志**（实测 0 条 access log）；A 想加就自定义 |
| 镜像体积 | 减少 Caddy 层约 17.3 MB 压缩 / 48.5 MB 解压；新增 proxy.mjs 几十 KB |
| 健康检查 | 可保持 `curl 127.0.0.1:3080`（DSH 存活）；但该检查本来就不覆盖 Caddy，A 下同样不覆盖新代理；代理挂掉由 `wait -n` 让容器退出、依赖 `restart: unless-stopped` |

### 3.3 安全影响（在「容器内无认证」前提下）

- **端口暴露**：DSH 仍只绑 127.0.0.1:3080（好）；Node 代理监听 8443 明文，容器端口一旦被发布到宿主机/网络，任何人都能绕过外部反代直连代理。由于代理自身没有认证，**它和 Caddy 明文版（B）一样，安全性完全取决于「谁能连到 8443」**。必须只发布到 `127.0.0.1` / 仅外部反代所在网络 / 防火墙白名单。
- **CSRF/Origin 围栏**：DSH 自身的 Host/Origin 围栏仍在，但代理是新增的「可破坏它」的一层：
  - 若代理像 Caddy 的 settings 路由那样**全局**删掉 `Origin`，DSH 的 CSRF 围栏对所有 `/api` 失效（非浏览器客户端本来就能省略 Origin；危险的是浏览器跨站 POST 会因代理删 Origin 而通过）。外部反代的认证 Cookie 若是 `SameSite=Lax`，跨站 POST 不携带 Cookie，尚有保护；若是 `SameSite=None`/无，则存在 CSRF 风险。
  - 若代理把所有请求的 Host 改写成 `127.0.0.1:3080`，DSH 围栏会把所有请求当 loopback 放行（打补丁后无认证），等于代理成为唯一安全边界；此时任何能访问代理的客户端都可操作，且 Host 白名单完全失效。
- **trusted-host**：仍需把外部访问域名传给 DSH（entrypoint 现有 `"$access_host"`），否则浏览器 `/api` 会 403。代理必须原样转发 Host（含端口）与 Origin（同端口）；**不建议复刻 Caddy 的 settings 改写**（理由见 §3.2）。
- **新的代码风险**：HTTP request smuggling、header 重复处理、hop-by-hop 头遗漏、WebSocket 升级绕过、长连接/超时、请求体大小限制、SSE 缓冲等，都要由自己实现并审计；Caddy 是成熟实现，有专门的 HTTP 解析与安全修复历史。这是 A 最大的、无法用「测试通过」完全消除的风险。
- **明文回源**：外部反代→容器明文；外部认证 Cookie / `Authorization` 会随请求进入容器网络。DSH 打了补丁后用不到这些头，**外部反代应在认证后剥离 `Cookie`/`Authorization` 再回源**（B 的 Caddy 已经剥离 `Authorization`；Cookie 需要额外处理），降低泄漏面。
- **结果**：在实现正确的前提下，A 的隔离性不比 B 差（DSH 仍 loopback），但「实现正确」需要额外审计与回归测试；安全评分应低于 B。

### 3.4 运维影响

| 项 | 影响 |
|---|---|
| 健康检查 | Dockerfile 健康检查可不动（仍打 3080）；但注意它**不验证代理/8443**（与现状相同：现状也不验证 Caddy）。代理崩溃时靠 `wait -n` 让容器退出 |
| 日志/日志格式 | 现状无访问日志；A 需自定义格式（建议至少记录 method/path/status/耗时/上游），并注意不要打印 `Authorization`/`Cookie`/token URL |
| HTTP/2 | 明文 HTTP/1.1；h2c 丢失（B 仍保留 h2c） |
| 压缩 | DSH gzip 仍在（实测）；zstd 丢失或需实验性实现；要避免二次压缩 |
| WebSocket | 必须实现并测试；否则 UI 的远程流（`/api/remote.mux`）不可用，属于「看起来能打开页面但功能坏」的高风险故障 |
| 优雅退出 | 必须实现；否则 `docker compose stop` 会切断进行中的 Agent 流/WS |
| 镜像体积 | -17.3 MB 压缩层（约 -5.7%），解压后 -48.5 MB |
| 启动/进程模型 | 与现状相同（dsh 先起、等待 3080、再起代理、`wait -n`） |

### 3.5 实现风险

**高。** 估计 2–5 人日（含 WebSocket/流式/安全测试与评审；此为人日估计，未验证），主要风险点：

1. `/api/remote.mux` WebSocket 不工作 → UI 核心功能不可用；
2. Origin/Host 处理错误 → 要么全站 403（白屏/功能报错），要么 CSRF 围栏被绕过；
3. 流式/SSE 被缓冲 → 长任务体验坏或超时；
4. hop-by-hop/重复头处理不当 → 请求走私或上游异常；
5. 构建期测试整段重写，若无 WS/围栏回归用例，后续升级 DSH 时很难发现问题；
6. 从 Caddy 换成自研代理后，未来 DSH 新增的 upgrade 路由/路径需要同步维护（Caddy 是透明转发的，不需要跟着改）。

A 的优点只有：去掉 Caddy 二进制（体积/CVE 扫描）和去掉一个 Go 运行时依赖；这两点若确实是硬需求，也应优先考虑 C（直接不跑代理）而不是自研反代。

---

## 4. 方案 B：保留 Caddy，只提供明文 HTTP、去掉 basic_auth

### 4.1 精确改动范围

| 文件 | 改动 | 行数规模 |
|---|---|---|
| `Caddyfile` | 全局块删 `default_sni`（:4）、`skip_install_trust`（:5）；站点地址 `https://` → `http://`（:8）；删 `tls internal`（:9）；删 `basic_auth argon2id` 块（:12-14）。保留 `admin off`、`auto_https disable_redirects`、`encode zstd gzip`、安全头、`@unsafe_api`、`@settings_api` 改写、默认反代 | **约 -5/+1 行**（45 → 约 40 行） |
| `docker-entrypoint.sh` | 删 `DSH_AUTH_USERNAME`/`DSH_AUTH_PASSWORD` 读取与校验（:28-29、:36-44）、`caddy hash-password`（:46）、对应 unset（:47）；保留 `HTTPS_ACCESS_HOST` 校验（:27、:31-34）——它仍是 Caddy 站点地址与 DSH `--trusted-host` 的来源；Caddy 启动时删掉 `DSH_AUTH_USERNAME`/`DSH_AUTH_PASSWORD_HASH` 环境（:97-98）；`/data/caddy` 可保留（Caddy 仍会写 autosave；实测无 TLS 也会写 `caddy-config/caddy/autosave.json` 并做 TLS storage 清理） | **约 -20/+2 行** |
| `Dockerfile` | 基本不变（仍需要 caddy 二进制）；可更新注释/`EXPOSE` 说明；健康检查不变（`curl 127.0.0.1:3080`） | 0（可选注释） |
| `test-runtime.mjs` | 第 54-130 行（77 行）Caddy 测试需改写：请求从 `https` 改 `http`、删 basic_auth 的 401 断言、Origin 仍用 `https://...`（因为 Caddy `@unsafe_api` 表达式按外部 TLS 的 Origin 写成 `https://`+hostport）、保留 settings 改写/403/空 200 断言。注意 `caddy hash-password` 不再需要 | 77 行改约 60–80 行（估计） |
| `dsh` wrapper | 不变 | 0 |
| `patch-dsh-authenticated-settings.mjs` | **不变（必须保留 auth 补丁）** | 0 |
| `docker-compose.yml` / `.env.example` / `README.md` | 预期要改（不由本任务写）：`DSH_AUTH_USERNAME/PASSWORD` 不再必填；`CADDY_DATA_DIR` 可保留（无害）或删；`HTTPS_PORT` 注释从「HTTPS」改「明文 HTTP」；外部反代回源从 `https` 改 `http` | 见各自负责人 |

**一个无需重建镜像的过渡做法（值得知道）**：由于 entrypoint 只从 `/etc/caddy/Caddyfile` 读配置，可把改好的 Caddyfile 用 volume 挂到 `/etc/caddy/Caddyfile`，同时在 `.env` 里保留合法的 `DSH_AUTH_USERNAME/PASSWORD`（只为通过 entrypoint 校验），Caddy 会忽略 `basic_auth` 相关环境。这样 **不改镜像也能先验证 B**；但长期仍建议把改动落回仓库并重建镜像，否则 entrypoint 的密码哈希是白做的、且文档与实际不一致。

### 4.2 丢失的功能

| 能力 | B 之后 |
|---|---|
| TLS / 自签 CA / `/data/caddy/pki` | 按需求删除（不再需要证书信任；`default_sni`、`skip_install_trust` 一并失去意义） |
| basic_auth（容器内唯一认证） | 按需求删除；**外部反代成为唯一认证** |
| HTTP/3（QUIC）与 TLS ALPN 的 HTTP/2 | 丢失（明文监听日志明确：`HTTP/2 skipped because it requires TLS`、`HTTP/3 skipped`） |
| **其余全部保留**：`@unsafe_api` 403、settings/credentials 的 Host 改写+Origin/Authorization 删除、空 200 Host 行为、`X-Content-Type-Options`/`Referrer-Policy`/`-Server`、`encode zstd gzip`、WebSocket 升级、graceful shutdown、`admin off`、`wait -n` 双进程监督、健康检查语义 | **实测保留**（§2.6） |
| 访问日志 | 本来就没有（当前 Caddyfile 无 `log` 指令；实测 0 条 access log）。B 想加可加 `log`，但会引入磁盘/脱敏问题，默认维持「无」 |
| 镜像体积 | 不变（Caddy 层仍在，17.3 MB 压缩 / 48.5 MB 解压） |

### 4.3 安全影响（在「容器内无认证」前提下）

- **端口暴露**：Caddy 仍监听 8443（明文）在所有接口，容器内没有认证。**任何能连到 8443 的客户端都能直接使用 UI/API**（打补丁后无 401）。这与当前「Caddy 有 basic_auth」相比是本质变化：安全边界从「Caddy 认证」移到「外部反代 + 网络隔离」。必须把容器端口限制为外部反代可达：`127.0.0.1:${HTTPS_PORT}:8443`、专用 docker network、或防火墙白名单。
- **CSRF/Origin 围栏**：**Caddy 的 `@unsafe_api` 403 保留**（实测 cross-site/Origin 不匹配 403，请求不达 DSH），DSH 自身围栏也保留，形成双层。注意 Caddy 的表达式按 `https://` + Host:port 比较 Origin，**假设外部是 TLS 终止的**；如果绕过外部反代、直接用浏览器以 `http://容器:8443` 访问，`Origin: http://…` 会命中 403（fail-closed，算好事，但排障时要理解）。非浏览器客户端仍可省略 Origin；围栏不是认证。
- **trusted-host**：不变（仍把外部 `HTTPS_ACCESS_HOST` 传给 DSH）；外部反代必须**原样转发 Host 与 Origin（含端口）**。若外部反代把 Host 改成容器地址，DSH 围栏可能仍放行（loopback），但 Caddy 站点匹配/Origin 比较会出问题；必须保持外部 Host。
- **settings/credentials**：Caddy 继续把 Host 改成 `127.0.0.1:3080`、删 Origin/Authorization（实测后端收到 `Host: 127.0.0.1:6806`、无 Origin、无 Authorization），配合 DSH 补丁可用。该改写本身是冗余的（rc.5 保留 Host+Origin 也通），但 B **原样保留**了这段已被构建期测试覆盖的逻辑：`@unsafe_api` 先拦跨站，settings 再走改写；B 的低风险正来自「不改既有防护逻辑」，而不是这条改写本身更强。
- **明文回源**：外部反代→Caddy 明文，外部认证 Cookie/Authorization 会进入容器网络；Caddy 默认路由已删 `Authorization`，但 **Cookie 默认不删**。建议外部反代认证后剥离 `Cookie`（DSH 打补丁后用不到），或在 Caddy 默认路由加 `header_up -Cookie`（需确认不影响其他功能；DSH 自身认证已被补丁关闭，故安全）。
- **结论**：B 的容器内攻击面与现状几乎相同（只是 8443 不再有 TLS/认证），防护逻辑没有新增代码；只要外部反代与网络隔离正确，B 是三者中最可控的。

### 4.4 运维影响

| 项 | 影响 |
|---|---|
| 健康检查 | 不变：`curl 127.0.0.1:3080`（compose 里 start_period 120s）；该检查只反映 DSH 存活，不反映 8443/反代（与现状相同，现状也不验证 Caddy） |
| 日志/日志格式 | 不变：无访问日志；Caddy 仍输出生命周期/错误 JSON 日志；外部反代应负责访问日志 |
| HTTP/2 | TLS 下的 h2/h3 丢失；**明文 h2c 实测可用**（`--http2-prior-knowledge` → 200/HTTP2），但多数外部反代默认以 HTTP/1.1 回源，实际影响接近 0 |
| 压缩 | zstd+gzip 保留（实测）；注意下游是真实 DSH 时 DSH 会先 gzip，Caddy 的 zstd 对 DSH 响应可能用不上（未在真实链路实测） |
| WebSocket | **保留**（实测 `/api/remote.mux` 101，Host 透传） |
| 优雅退出 | **保留**（实测 SIGTERM 后 graceful；entrypoint 的 trap 与 `wait -n` 不变） |
| 镜像体积 | 不变 |
| 启动/进程模型 | 不变（dsh 先起、等 3080、再起 Caddy、`wait -n`） |
| 配置/文档 | `.env` 三个必填项变两个（host 仍必填；用户名/密码不再需要）；外部反代回源 scheme 必须改 http，且需设置足够长的读超时/允许 Upgrade/关闭响应缓冲 |

### 4.5 实现风险

**低。** 估计 0.5–1 人日（含改 Caddyfile/entrypoint/测试与一次端到端验证；估计未验证）。风险点：

1. 构建期 `node --test /tmp/test-dsh-runtime.mjs`（Dockerfile:67）仍按 HTTPS/basic_auth 断言；不同步改会导致**构建失败**（这是好事，逼你改测试）；
2. 外部反代必须用 http 回源、保留 Host/Origin、允许 WebSocket、长超时、不缓冲 SSE；这些是配置问题，不是镜像问题；
3. 明文 8443 绝不能暴露给不可信网络（否则等于无认证开放）；
4. 可选：站点地址若保持 `http://{$CADDY_ACCESS_HOST}:8443`，Host 不带端口的匹配行为与现状同样「理论可行、未实测」（当前 README 也这么说）；要更省心可改成 catch-all `http://:8443`（DSH 的 trusted-host 围栏仍会保护 `/api`），但「未知 Host 空 200」行为会消失。两种都可，推荐先沿用 host-specific 以保持最小差异。

---

## 5. 方案 C：无代理，`dsh web` 直接绑定容器 IP

### 5.1 精确改动范围

| 文件 | 改动 | 行数规模 |
|---|---|---|
| `Dockerfile` | 删 `FROM caddy:2.11.4 AS caddy`（:1）、`COPY --from=caddy /usr/bin/caddy`（:43）、caddy 用户（:48-50）与 `/data/caddy` 目录（:53；:51-52 是 dsh/workspace 目录，必须保留）、`COPY Caddyfile`（:59）；**必须改 `HEALTHCHECK`**（:77-78）：现在打的是 `127.0.0.1:3080`，C 下 DSH 不在 loopback:3080；需要改成「运行时算出绑定 IP + 端口」的健康检查（例如先由 entrypoint/健康检查命令用 `hostname -I` 或 `os.networkInterfaces()` 选出 IPv4，再 `curl -fsS http://<选中IP>:8443/`），或由 entrypoint 把选中 IP 写入一个健康检查可读的位置。`EXPOSE 8443` 可保留 | 约 -10/+2 行 |
| `docker-entrypoint.sh` | 删用户名/密码读取、校验与哈希（:28-29、:36-47）；删 `/data/caddy` 目录（:51）；DSH 启动参数从 `--host 127.0.0.1 --port 3080` 改为「运行时发现容器 IPv4 + `--port 8443` + `--trusted-host "$access_host"`」（:64-73）；删 60s 就绪等待与 Caddy 启动段（:75-104）；最后一个进程改为 `exec`/等待 DSH（:106-108），保留 tini、gosu、`install -d`、access_host 校验 | **约 -55/+20 行**（含 IP 发现逻辑） |
| `Caddyfile` | **删除（45 行）** | -45 |
| `Dockerfile` COPY 段 | 删 `COPY Caddyfile`；`COPY test-runtime.mjs` 保留（内容要改） | -1 |
| `test-runtime.mjs` | 第 54-130 行（77 行）Caddy 测试删除；建议新增「直连 DSH」的围栏/认证测试（启动临时 DSH + 发请求），否则构建期只剩 PDF 测试（1-52 行），Host/Origin 围栏无人守护 | 77 行 → 0 或替换约 50–80 行 |
| 新增 `proxy` | **无** | 0 |
| `dsh` wrapper | **不变**（容器内 CLI 仍可用；`docker exec … dsh` 行为不变） | 0 |
| `patch-dsh-authenticated-settings.mjs` | **不变（必须保留 auth 补丁）** | 0 |
| `docker-compose.yml` / `.env.example` / `README.md` | 预期要改（不由本任务写）：端口映射仍可 `8443:8443`（Docker DNAT 到容器 IP），但建议 `127.0.0.1:${HTTPS_PORT}:8443`；若 entrypoint 用 `hostname -I` 发现 IP，compose 默认网络即可（不必静态 IP），但外部反代若直连容器 IP 则必须用「服务名/容器名」或静态 `ipv4_address`；三个认证 env 不再有意义 | 见各自负责人 |

### 5.2 可行性结论（实测）

- **能启动**：`dsh web --host 172.18.0.6 --port 6801` 成功（172.18.0.6 为本容器 eth0 IPv4，`hostname -I` 得到）。
- **不能用 0.0.0.0**：DSH 明确拒绝（原文见 §2.1）。因此 C 的唯一选择是「运行时发现一个具体容器 IP」或「compose 里配静态 `ipv4_address`」。
- **不能写主机名**：`--host localhost` 直接失败（原文见 §2.1）→ 不能写 DNS 名/服务名，只能 IP 字面量。
- **仍需要 `--trusted-host <外部域名>`**：外部反代转发 `Host: dsh.example.com` 时，没有该 trusted-host，`/api` 一律 403（实测）。有它时（不带端口）任意端口都匹配（实测）。
- **仍需要补丁**：不打补丁 → 401；打补丁 → 200（实测）。C 没有「Caddy basic_auth」，也没有其他容器内认证。
- **容器 IP 稳定性**：docker-compose 默认 bridge/自定义网络会给容器动态分配 IP；`docker compose down && up`、网络重建、扩容副本都可能换 IP。绑旧 IP 的后果实测为 `EADDRNOTAVAIL` 启动失败。可行做法：
  1. entrypoint 每次启动时用 Node `os.networkInterfaces()`/`hostname -I` 发现当前 IPv4 再绑定——重建后能自愈，但**多网络（compose 网络 + 外部反代网络）时顺序无保证**，要显式选网卡/地址；IPv6-only、Windows 容器、multiple network 场景更麻烦；
  2. compose 里给 `ipv4_address` 静态地址——稳定，但把容器固定到特定网络/子网，换网络或扩容副本会冲突；
  3. 外部反代不要写死容器 IP，改用容器名/服务名 DNS（Docker 内部 DNS）或宿主发布端口。
  三者需要配合，任何一个环节写死旧 IP 都会在重建后断链/启动失败。**任务要求的「绑定容器 IP 通常不稳定」成立**；且这是 C 相比 B 额外引入的运维脆弱点。

### 5.3 丢失的功能（相对当前镜像）

| 能力 | C 之后 |
|---|---|
| TLS / 自签 CA / `/data/caddy` | 删除 |
| basic_auth（容器内唯一认证） | 删除（外部反代成为唯一认证） |
| Caddy `@unsafe_api` 403 | 丢失；DSH 自身 Host/Origin 围栏等价保留（实测 cross-site/Origin 不匹配 403），但**不再有 Caddy 统一拦截层**；静态资源本来就不受围栏保护 |
| settings/credentials 改写 | 不需要：本机实测（rc.5+等价补丁）保留外部 Host+同源 Origin 也能正常返回 settings；C 必须保证 Host/Origin 一致（含端口） |
| 压缩 zstd | 丢失；DSH gzip 保留（实测） |
| 安全响应头 | 丢失（DSH 全局不设 `X-Content-Type-Options`/`Referrer-Policy`）；需外部反代补 |
| HTTP/2 | 明文 HTTP/1.1（DSH 用 Node `http`）；h2c 也没有 |
| WebSocket | **保留**（DSH 自己注册 upgrade 路由并直接监听，外部反代需转发 Upgrade） |
| 优雅退出 | **保留**：DSH 自己有 SIGTERM 处理（`profile-boot-C14i-8IN.js:280-285`，webserver 会 `close` + `closeAllConnections`）；`exec` 方式下信号直达 DSH |
| 访问日志 | 无（本来就没有）；外部反代负责 |
| 镜像体积 | 减少 Caddy 层约 17.3 MB 压缩 / 48.5 MB 解压 |
| 健康检查 | **必须重写**；且要处理「容器 IP 在健康检查执行时如何得到」的问题（见 §5.1） |
| 启动/进程模型 | 更简单：单进程、`exec`、无 60s 等待、无 `wait -n`；tini 仍负责转发信号/收尸 |

### 5.4 安全影响（在「容器内无认证」前提下）——三者中最差

- **端口暴露 + 无认证 + 绑定 IP 被信任**：打补丁后 DSH 没有认证；而 DSH 的 Host 围栏**天然信任自己的绑定 IP**（实测：无 `--trusted-host` 时 `Host: 172.18.0.6:6808` 仍能 200 返回完整 settings）。这意味着：
  - 任何能连到 `容器IP:8443` 的客户端，不需要知道外部域名、不需要任何 token/密码，只要把 Host 写成容器 IP 就能获得完整控制面（改设置、写凭据、执行 Agent）。
  - `--trusted-host 外部域名` 只对「以外部域名访问的浏览器」有意义，对直连 IP 的网络客户端**不构成任何屏障**。
  - DSH 自己在非 loopback 明文监听时会打印警告：`dsh web: listening on 172.18.0.6 over plain HTTP; restrict this port to a trusted proxy or network`（`dsh-web-app/lib/index.js:143`）——这就是对 C 的准确描述。
- **因此 C 的安全完全依赖网络层**：
  - 最好：外部反代与 DSH 同机，容器端口只发布到 `127.0.0.1`（或同一 Docker 网络的只有反代容器），宿主机防火墙只允许反代进程；不发布到公网/局域网。
  - 若外部反代在另一台主机：必须发布容器端口到网络，此时**必须**用防火墙把来源限制为反代 IP（或 mTLS/其他传输层认证——但那又会把 TLS 加回来，与需求冲突）。没有网络 ACL 的 C 等于把无认证 RCE 面板暴露出去。
- **CSRF/Origin 围栏**：DSH 围栏仍能挡浏览器跨站/DNS rebinding；但如上，直接 HTTP 客户端可省略 Origin/伪造 Host，所以它防不了非浏览器攻击者。外部反代的会话 Cookie 应设 `SameSite`、且认证必须覆盖 WebSocket 与所有路径。
- **明文回源**：与 A/B 相同；建议外部反代剥离 `Cookie`/`Authorization` 再回源。
- **附带问题**：`dsh web` 启动时仍会把带 `?token=` 的 URL 打进容器日志（即便补丁后 token 无意义）；容器日志访问权限要收紧。

### 5.5 运维影响

| 项 | 影响 |
|---|---|
| 健康检查 | **必须改**：镜像默认 `curl 127.0.0.1:3080` 在 C 下永远失败 → 容器一直 unhealthy。改成动态 IP 后仍有「多网卡选错 IP」「IPv6 容器」等脆弱性；`start_period` 需要覆盖 DSH 冷启动 |
| 日志/日志格式 | 无访问日志（与现状相同）；DSH 的启动/错误日志仍输出；外部反代负责 access log |
| HTTP/2 | HTTP/1.1（Node http）；无 h2c |
| 压缩 | DSH gzip（实测）；zstd 无 |
| WebSocket | 可用（DSH 原生）；外部反代要允许 Upgrade、长连接超时 |
| 优雅退出 | 比现状更简单：`exec` 后 SIGTERM 直达 DSH；`stop_grace_period` 可保留 30s；DSH 会关闭连接（源码引用见上） |
| 镜像体积 | -17.3 MB 压缩层（约 -5.7%），解压后 -48.5 MB |
| 启动/进程模型 | 单进程，少一个 Caddy；但多了「IP 发现」这一启动依赖；外部反代可能在 DSH ready 前收到 502（无就绪门控） |
| 网络/编排 | 容器 IP 默认不稳定；静态 IP/多网络/IPv6 都需要额外设计与测试；K8s 下 pod IP 也会变（但通常 stable within pod lifetime，重建即变） |

### 5.6 实现风险

**中高。** 估计 1–2 人日（含 entrypoint IP 发现、健康检查、端到端验证；估计未验证）。主要风险：

1. **安全**：只要端口暴露面有一点点错（发布到 0.0.0.0、防火墙漏一条、反代被绕过），就是无认证 RCE 面板；且这个错误不会在「功能测试」中暴露。
2. **IP 发现/绑定**：多网卡顺序、`hostname -I` 输出格式、IPv6、compose 静态 IP 与扩容冲突；绑旧 IP → `EADDRNOTAVAIL` 重启循环（实测错误）。
3. **健康检查**：需要同时解决「IP 从哪来」和「检查哪个地址」，否则容器永远 unhealthy；容器 unhealthy 本身不会自动重启（取决于编排策略），但监控会误报。
4. **外部反代配置**：必须转发 Host/Origin 原样（含端口）且允许 WS；Host 不一致 → `/api` 403（白屏/报错）。
5. 丢失 Caddy 的成熟 HTTP 边界处理（虽然 DSH 的 Node http 也成熟，但少了一层可观测/可配置的边缘）。

---

## 6. 决策表

评分口径：1–5 分，**5 最好**。权重：实现风险 30%、安全 30%、改动/工作量 20%、性能 10%、维护 10%。（权重与分数是工程判断，非测量结果。）

| 方案 | 改动/工作量（20%） | 实现风险（30%） | 安全（30%） | 性能（10%） | 维护（10%） | 加权总分 |
|---|---:|---:|---:|---:|---:|---:|
| **A：Node 反代** | 2（120–250 行新代码 + 77 行测试重写） | 1（WS/流式/围栏/走私，全部自研） | 3（DSH 仍 loopback，但新代码可能破坏围栏/WS） | 4（与 B 同为额外一跳；无压测） | 2（自研边缘要长期跟进 DSH/Caddy 行为） | **2.2** |
| **B：Caddy 明文** | 5（Caddyfile 约 -5/+1、entrypoint 约 -20、测试 77 行改写） | 4（只动配置；构建期测试会强制同步） | 4（Caddy 成熟的 403/settings 改写全保留；只靠外部认证 + 网络隔离） | 4（一跳；zstd/gzip、h2c 保留；无压测） | 5（不新增组件，Caddy 继续维护） | **4.3** |
| **C：无代理直绑 IP** | 3（entrypoint 改写 + IP 发现 + 健康检查） | 2（IP 不稳定/健康检查/发布面） | 1（直接暴露、绑定 IP 被信任、无认证） | 5（少一跳；无压测） | 3（代码更少，但网络/IP 运维复杂） | **2.3** |

补充的定性排序：

- **安全**：B > A > C（B/A 都有 loopback DSH + 代理层；A 的新代码是额外风险；C 直接暴露）。
- **工作量**：B < C < A。
- **长期维护**：B 最省心；C 的启动/IP/健康检查会持续消耗运维；A 要跟随 DSH 的 upgrade 路由与安全修复。
- **性能**：C 少一跳（理论最好，未测量）；A/B 相同（多一跳，实测链路功能正常，吞吐/延迟「未验证」）。

**推荐：B。** 如果「镜像里必须去掉 Caddy 二进制」是硬性约束，**退而求其次选 C（必须配合严格网络隔离、端口只发布到 127.0.0.1/反代网络、并接受 IP/健康检查的复杂度）**；A 只在「团队愿意长期维护自研反代并做安全评审」时才考虑，不推荐为了这次需求单独引入。

---

## 7. 对「外部已做认证 + TLS」部署的最终建议与硬性前置条件

### 7.1 推荐路线（B）

1. 改 `Caddyfile`：`http://{$CADDY_ACCESS_HOST}:8443`，删 `tls internal`、`basic_auth`、`default_sni`、`skip_install_trust`，其余全部保留（settings/unsafe/headers/encode）。
2. 改 `docker-entrypoint.sh`：去掉用户名/密码校验与哈希（保留 host 校验），Caddy 启动不再传 auth env；`/data/caddy` 可保留（autosave 仍会写）。
3. 改 `test-runtime.mjs` 的 Caddy 测试为明文 HTTP（Origin 仍用 `https://` 模拟外部 TLS），保留 settings 改写、403、空 200 断言；否则 `Dockerfile:67` 的构建期测试会失败。
4. 外部反代：回源 `http://<容器>:8443`；**原样转发 `Host` 与 `Origin`（两者必须同 authority，含端口）**；认证覆盖所有路径；允许 WebSocket Upgrade；关闭响应缓冲；读超时足够长（Agent 任务可能很久）；剥离不需要的 `Cookie`/`Authorization`；补上/保留安全响应头（B 的 Caddy 已加 nosniff/Referrer-Policy）。
5. 网络：容器 8443 只允许外部反代访问（`127.0.0.1` 发布、专用 docker network、或防火墙白名单），**绝不要发布到 0.0.0.0/公网**。
6. 保留 `ONEPANEL_DSH_AUTH_PROXY=1` 补丁与 entrypoint 注入；保留 `--trusted-host "$access_host"`。不要以为去掉 basic_auth 就「没有认证层了」——正好相反，补丁把 DSH 自身认证也关了，外部反代是唯一认证点。

### 7.2 如果外部反代的认证不是「全路径强制」

必须补上：外部反代对 `/api/remote.mux` 的 WebSocket 升级、静态资源、以及所有 `/api/*` 都要经过登录校验；不能只保护 `GET /`。B 的 `@unsafe_api` 只能挡跨站浏览器请求，不能当作认证。任何能直连容器 8443 的客户端都会（在 B 下）直接进入无认证的 UI/API。

### 7.3 若选择 C 的额外硬性条件

- 端口只发布到 `127.0.0.1` 或仅反代容器可达的网络；有防火墙规则限制来源；
- 外部反代用容器名/服务名 DNS 或宿主发布端口，**不要写死容器 IP**；entrypoint 用运行时 IP 发现且只选一个明确的 IPv4；
- 改 HEALTHCHECK 并验证容器能 healthy；
- 接受「Host=绑定 IP 也能过 DSH 围栏」这一事实（已在 §2.2 实测），不要把 trusted-host 当安全边界；
- 外部反代认证后剥离 `Cookie`/`Authorization` 再回源。

### 7.4 若选择 A 的额外要求

- 用协议级测试覆盖：`/api/remote.mux` WebSocket、settings/credentials 的 Host/Origin 行为、跨站 403、SSE/流式、长连接、hop-by-hop、`Content-Encoding` 不二次压缩、SIGTERM 优雅退出；
- 代理默认**保留** Host/Origin，不要全局改 Host/删 Origin；settings 路径也不建议复刻 Caddy 的改写（保留 Host+Origin 即可，见 §3.2）；
- 明确压缩策略：要么不做压缩（依赖 DSH gzip 实测有效），要么只在响应无 `Content-Encoding` 时压缩；
- 有 WebSocket 断开/重连与代理超时的可观测性；
- 需要安全评审（请求走私、header 注入、路径规范化）。

---

## 8. 未验证清单（明确不夸大）

1. **镜像未运行**（无 docker/containerd）：TLS 握手、真实 Caddy basic_auth、CA 生成、镜像内补丁是否真的打上、启动耗时/健康检查时机/内存占用，全部「未验证」。
2. 本文「补丁后」行为使用**运行时等价 loader**（注入同一行 `if (process.env.ONEPANEL_DSH_AUTH_PROXY === "1") return true;`）实测，不是发布镜像内的补丁；语义等价，但不等同于镜像字节级验证。
3. Caddy B 的实测使用**从镜像层提取的 2.11.4 二进制** + 改写后的 Caddyfile + Node stub 后端，不是完整镜像链路；真实 DSH 的 zstd 行为、WebSocket 与真实 `@settings_api` 组合「未验证」。
4. 所有性能数据（吞吐、延迟、内存、启动时间）均「未验证」；决策表里的分数是工程判断。
5. 容器 IP 在多网络/compose 重建/K8s 下的具体行为「未验证」；只实测了 `hostname -I` 得到 172.18.0.6 与 `EADDRNOTAVAIL` 绑定旧 IP 的报错。
6. 外部反代（nginx/其他）的 Host/Origin 转发、WebSocket、超时、缓冲行为取决于其配置，本环境未接入真实外部反代测试。
7. 发布流水线：本 checkout 中**没有** `.github/workflows/deepseek-harness-release.yml`（`runtime/.github/` 不存在），无法核实镜像实际构建参数；`Dockerfile:5` 的 `ARG DSH_VERSION=0.2.1-rc.2` 仍是默认值，若重建镜像必须显式 `--build-arg DSH_VERSION=0.2.1-rc.5`，否则会得到 rc.2（此点为源码事实，构建流程**未验证**）。
8. 访问日志「当前没有」依据：Caddyfile 无 `log` 指令 + B 实测 0 条 access log；真实镜像的运行日志未验证。

---

## 9. 证据附录（关键命令/位置）

### 9.1 DSH 源码/行为

| 证据 | 位置 |
|---|---|
| `--host` 拒绝通配 | `node_modules/@deepseek-ai/dsh-web-app/lib/startup.js:48`；`node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:255` |
| `--host` 只接受 IP 字面量 | `dsh-host-webserver/lib/index.js:142`（`notLiteralError`）、`:254` |
| DSH 非 loopback 明文监听警告 | `dsh-web-app/lib/index.js:143` |
| Host/Origin 围栏 | `dsh-client-connection/lib/index.js:240-265`（`isTrustedApiRequest`/`isSameAuthorityOrigin`）、`:225-233`（绑定 IP 自动信任）、`:196-213`（trustedHost 端口语义） |
| 浏览器 token/Cookie 认证 | `dsh-client-connection/lib/index.js:410-430、458-494、546-548`；实测 Cookie `Max-Age=2592000; HttpOnly; SameSite=Strict` |
| 补丁内容 | `runtime/deepseek-harness/patch-dsh-authenticated-settings.mjs:8、25-42`；entrypoint 注入 `ONEPANEL_DSH_AUTH_PROXY=1` 于 `docker-entrypoint.sh:68` |
| web profile 的 gzip | `dsh-web-app/cordis.patch.yml:186-188`；webserver 默认 `none` 于 `dsh-host-webserver/lib/index.js:109` |
| WebSocket 升级路由 | `dsh-api-gateway/lib/index.js:133、785、820`（`/api/remote.mux`）；`dsh-experimental-inspector/lib/index.js:2369、2462`（`/inspector/devtools/cdp`） |
| DSH 优雅退出 | `lib/profile-boot-C14i-8IN.js:280-285`；`dsh-host-webserver/lib/index.js:470-500`（`close` + `closeAllConnections` + 升级 socket 关闭） |

### 9.2 实测命令摘要（进程/临时目录已清理）

```bash
# 版本
node --expose-internals .../dsh/lib/bin.js web --help
# 通配/非法 host
... web --no-open --host 0.0.0.0 --port 6802      # exit 1，原文见 §2.1
... web --no-open --host localhost --port 6809     # 启动失败，原文见 §2.1
# 具体 IP 可行
DSH_HOME=... HOME=... ... web --no-open --host 172.18.0.6 --port 6801 --trusted-host dsh.example.com
curl -H 'Host: dsh.example.com' http://172.18.0.6:6801/            # 未打补丁：401
curl -c cookies.txt -H 'Host: dsh.example.com' 'http://172.18.0.6:6801/?token=...'  # 303 + Cookie
curl -b cookies.txt -H 'Host: dsh.example.com' http://172.18.0.6:6801/              # 200
# 等价补丁（--import loader 注入 ONEPANEL_DSH_AUTH_PROXY 分支）
... --import file://.../register.mjs ... web --no-open --host 172.18.0.6 --port 6807 --trusted-host dsh.example.com
curl -H 'Host: dsh.example.com' http://172.18.0.6:6807/            # 200
curl -X POST -H 'Host: dsh.example.com' -H 'Origin: https://dsh.example.com' \
     --data '{"type":"client-request","rpcId":"r2","method":"settings/describe","payload":{"args":{}}}' \
     http://172.18.0.6:6807/api/settings/describe                  # 200 + ok:true
# 无 trusted-host 时绑定 IP 被信任
... --host 172.18.0.6 --port 6808 ...   # 无 --trusted-host
curl -X POST -H 'Host: 172.18.0.6:6808' .../api/settings/describe  # 200
curl -X POST -H 'Host: dsh.example.com' .../api/settings/describe  # 403
# 绑定不存在的 IP
... --host 172.18.0.99 --port 6803       # EADDRNOTAVAIL
```

```bash
# 选项 B：从镜像层提取 Caddy 2.11.4，跑明文 Caddyfile B（http://$CADDY_ACCESS_HOST:6805，后端 127.0.0.1:6806）
caddy version                             # v2.11.4 h1:XKxk...
curl -H 'Host: dsh.example.com:6805' http://127.0.0.1:6805/preview          # 200，无 basic auth
curl -X POST -H 'Host: dsh.example.com:6805' -H 'Origin: https://dsh.example.com:6805' \
     http://127.0.0.1:6805/api/settings/describe                             # 200，后端收到 Host:127.0.0.1:6806、无 Origin/Authorization
curl -X POST -H 'Host: dsh.example.com:6805' -H 'Origin: https://evil.invalid' .../api/settings/update  # 403
curl -H 'Host: attacker.invalid:6805' .../api/settings/update                # 200 空 body
curl --http2-prior-knowledge -H 'Host: dsh.example.com:6805' ...             # http_version=2（h2c）
curl -H 'Connection: Upgrade' -H 'Upgrade: websocket' ... .../api/remote.mux # 101
```

### 9.3 镜像体积证据

```text
registry-1.docker.io/v2/1panel/deepseek-harness/manifests/0.2.1-rc.5
  → amd64 manifest sha256:9f212e64…c438
  → layers 合计 305,364,136 B（16 层）
  → history 中的 “COPY /usr/bin/caddy /usr/bin/caddy” 对应 manifest layer 序号 6 → sha256:6bbc1139…c03a，size 17,294,751 B
  → tar -tzvf 该层：-rwxr-xr-x 1001/1001 48,521,378 usr/bin/caddy
  → caddy version: v2.11.4
```

### 9.4 文件行号速查（当前 runtime 仓库）

| 文件 | 关键行 |
|---|---|
| `Dockerfile` | 1（caddy stage）、43（COPY caddy）、46-53（用户/目录）、59-62（COPY 配置与测试）、64-68（构建期测试）、75（EXPOSE 8443）、77-78（HEALTHCHECK 3080）、82（tini entrypoint） |
| `docker-entrypoint.sh` | 4-21（is_access_host/self-test）、27-47（access_host/auth 校验/hash/unset）、49-51（目录）、53-62（trap）、64-73（DSH 启动）、75-91（就绪等待）、93-104（Caddy 启动）、106-108（wait -n） |
| `Caddyfile` | 1-6（全局）、8-9（站点/tls）、10（encode）、12-14（basic_auth）、16-20（安全头）、22-30（@unsafe 403）、32-38（@settings 改写）、40-44（默认反代） |
| `test-runtime.mjs` | 1-52（PDF 兼容测试）、54-130（Caddy 行为测试，A/C 必须重写，B 必须改 http） |
| `patch-dsh-authenticated-settings.mjs` | 8（开关字符串）、25-42（auth 补丁，必须保留）、44-70（PDF polyfill，保留） |
| `dsh` | 1-11（wrapper，三方案均不变） |

---

## 10. 一句话交付

**推荐 B：只把 Caddy 改成明文 HTTP 并删除 basic_auth（约 -5/+1 行 Caddyfile、约 -20 行 entrypoint、77 行构建期测试改 http），保留 Caddy 的 settings 改写、`@unsafe_api` 403、zstd/gzip、WebSocket、优雅退出与健康检查语义；Docker 层不增不减。** 无论选哪个方案，`ONEPANEL_DSH_AUTH_PROXY=1` 补丁与 `--trusted-host <外部域名>` 都必须保留；A/B/C 都必须在网络层把容器端口限制为「只有外部反代可达」，并把外部反代的认证覆盖到 WebSocket 与所有路径——因为在这套设计里，容器内已经没有任何认证了。
