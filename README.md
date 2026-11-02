# DeepSeek Harness 部署指南（明文 HTTP 版，docker compose）

> 本目录是 1Panel 官方镜像 `1panel/deepseek-harness` 的**改造版**：移除了 Caddy、TLS 与登录认证，
> 改用一个 Node 转发进程，专供「外部反向代理已负责登录认证 + TLS」的部署。
> 改动源码在 `runtime/deepseek-harness/`，可行性论证与实测见 `reports/node-proxy-feasibility.md`。

## 0. 结论与架构

只需要一个容器。容器内**没有登录、没有证书、没有 Caddy**：

```
浏览器 ──HTTPS──▶ 你的外部反向代理（认证 + 证书）
                     │  Host: dsh.example.com 原样透传、Origin 透传、WS 升级
                     ▼
              容器 0.0.0.0:8080  Node 转发（无认证，只做 Host 白名单 + 转发）
                     ▼
              容器 127.0.0.1:3080  dsh web（DSH 自身认证已被补丁旁路）
```

**安全边界完全在容器外**：任何能连到 8080 的人，只要发 `Host: <你的域名>` 就是 owner 全权
（能改设置、读凭据、执行 Agent 命令）。因此：

- compose 默认只把 8080 发布到**宿主机 127.0.0.1**，不要改成 `0.0.0.0`；
- 外部反代与容器分离部署时，用独立 docker 网络 + `expose`，不要发布端口；
- 可选开启 `PROXY_SHARED_SECRET`，让外部反代带一个共享密钥头（纵深防御，不是认证）。

## 1. 前置条件

- Docker Engine 24+ 与 Compose V2
- 一个外部反向代理，**必须**满足：
  - 保留原始 `Host`（含端口）：nginx 用 `$http_host`，不要用 `$host`
  - 透传 `Origin`、`Sec-Fetch-Site`、`Cookie`（DSH 用 Origin 做 CSRF 判定）
  - 支持 WebSocket 升级（`/api/remote.mux`）
  - 不缓冲响应（SSE `/plugins/events`、导出 ZIP、流式输出）
  - 请求体上限 ≥ 300 MiB（DSH 的上限；nginx 默认 1 MiB 会先 413）
- 一个浏览器实际访问的 IPv4 或域名（`DSH_ACCESS_HOST`），不要带协议/端口
- 容器需要能出网访问模型 API

## 2. 快速开始

> ⚠️ **注意**：`runtime/` 是上游 `1Panel-dev/runtime` 的克隆，而本改造（去 Caddy / 明文 HTTP）
> 只存在于本目录的 `patches/` 与本地分支 `plain-http` 中。**直接 clone 上游得到的是 Caddy/HTTPS 原版**。

下面三种方式任选其一取得「改造后的源码」：

```bash
# 方式 0（最省事）：直接克隆已内置改造的仓库（runtime/ 快照已在其中）
git clone https://github.com/kjeung/deepseek-harness-plain.git dsh-plain
cd dsh-plain

# 方式 A：上游源码 + 补丁
git clone --branch dev --filter=blob:none --sparse \
  https://github.com/1Panel-dev/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness .github
git -C runtime checkout 83f5b17                          # 补丁基线
git -C runtime am "$PWD/patches/0001-feat-deepseek-harness-replace-Caddy-with-plain-HTTP-.patch"

# 方式 B：从 bundle 取改造分支（离线可用，需先有 83f5b17）
git -C runtime fetch "$PWD/patches/plain-http.bundle" plain-http:plain-http
git -C runtime checkout plain-http

# 方式 C：使用已构建镜像（无需源码）
#   设置 DSH_IMAGE=registry/…/deepseek-harness-plain:0.2.1-rc.5，
#   并删掉 compose 里的 build: 与 pull_policy: 段
```

补丁的基线、校验方式、推到自有 fork 等细节见 [patches/README.md](patches/README.md)；
上游更新后如何同步见 [SYNC-UPSTREAM.md](SYNC-UPSTREAM.md)（一行命令：`scripts/sync-upstream.sh`）。

镜像源码的 fork：**https://github.com/kjeung/runtime**（默认分支 `plain-http`，保留完整上游历史）。
它带一个**每日定时工作流**：上游 `dev` 前进时自动 merge 到 `sync/upstream-<sha>` 并向 `plain-http` 开 PR，
冲突则开 issue（细节见 SYNC-UPSTREAM.md §6）。部署仓库：**https://github.com/kjeung/deepseek-harness-plain**。

```bash
cp .env.example .env
vi .env                 # 只需改 DSH_ACCESS_HOST
docker compose up -d --build
docker compose logs -f
```

> `runtime/` 在 `.gitignore` 里（避免把上游克隆塞进版本库）；它是构建上下文，
> 必须按上面的方式准备好改造后的源码，不要直接拿上游 clone 就 build。

日志出现下面两行即就绪：

```
DeepSeek Harness is available at http://dsh.example.com:8080 inside the container (plain HTTP).
This container performs no TLS and no authentication: restrict port 8080 to the trusted reverse proxy.
```

然后在外部反代里加一条站点，回源 `http://127.0.0.1:8080`：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;          # 关键：保留原始 Host（含端口）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # WebSocket（/api/remote.mux）
    proxy_set_header Connection "upgrade";
    proxy_buffering off;                       # 不要缓冲流式响应
    proxy_read_timeout 3600s;
    client_max_body_size 300m;                 # DSH /api 上限 300 MiB
    # 可选：只把反代自身的认证 Cookie 发到浏览器，回源时剥掉，减少泄漏面
    # proxy_set_header Cookie "";
}
```

> 若启用了 `PROXY_SHARED_SECRET`，再补一行 `proxy_set_header X-DSH-Proxy-Secret "<同一个值>";`。

## 3. 环境变量

### 3.1 必填（1 个）

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `DSH_ACCESS_HOST` | `dsh.example.com` / `203.0.113.10` | 无，必填 | 浏览器实际访问的 **IPv4 或主机名**。禁止 `https://`、端口、路径；不支持 IPv6、下划线、结尾点、前导零 IP；中文域名用 punycode。它同时是 dsh 的 `--trusted-host`（`/api` 的 Host 白名单）与转发进程的 Host 允许列表。**与实际访问地址不一致 → `/api` 返回 403 `forbidden`，页面白屏。** |

旧版本用的 `HTTPS_ACCESS_HOST` 仍被接受：compose 会把它一并传给容器，入口脚本优先读
`DSH_ACCESS_HOST`、回退到 `HTTPS_ACCESS_HOST` 并打印弃用提示。两者都填时以 `DSH_ACCESS_HOST` 为准。

### 3.2 镜像内置（一般不改）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_HOME` | `/data/dsh` | DSH 数据根（profiles、settings、凭据、会话、日志）。必须持久化。 |
| `DSH_TELEMETRY_DISABLED` | `1` | 任意非空值都表示关闭遥测；写 `0` 也关闭。 |
| `HOME` | `/data/dsh/home` | 入口脚本设置，落在 `/data/dsh` 卷内。 |
| `ONEPANEL_DSH_AUTH_PROXY` | `1` | 入口脚本写死。它配合镜像补丁让 DSH 跳过自身浏览器认证。**删掉它 → `GET /` 401，容器起不来。** |
| `PROXY_LISTEN_HOST` / `PROXY_LISTEN_PORT` / `PROXY_ALLOWED_HOSTS` | `0.0.0.0` / `8080` / 由 `DSH_ACCESS_HOST` 派生 | 入口脚本传给转发进程，一般不用管。 |

### 3.3 可选：转发进程

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `PROXY_SHARED_SECRET` | 随机 32 字节 | 空=不校验 | 设置后，转发进程要求请求带 `X-DSH-Proxy-Secret` 且值相同，否则 403；该头不会被转发给 DSH。适合外部反代能注入固定头时做纵深防御。 |
| `PROXY_ACCESS_LOG` | `1` / `0` | `1` | JSON 行访问日志（时间、来源、方法、路径、状态、耗时、字节数）。只记 pathname，不含 query，避免 token 泄漏。 |

### 3.4 应用层可选（dsh 自己读取）

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `DSH_PERMISSION_MODE` | `workspace-write` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access`；只有 danger 时审批为 `never`。 |
| `DSH_TOOLS_MODE` | `native` | `native` | 或 `ptc`。 |
| `DEEPSEEK_API_KEY` | `sk-…` | 空 | 不想进 UI 填 Key 时用；**UI 保存的优先级更高**（写入 `/data/dsh/.credentials.yaml`）。 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | 同左 | 接私有网关时改。 |
| `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` | `http://10.0.0.2:3128` | 空=直连 | 容器出网需代理时；不支持 SOCKS。 |

> `DSH_*` 属于 bootstrap 变量，只能来自容器进程环境，写进 `$DSH_HOME/.env` 无效。
> 注意：compose 只转发 `environment:` 里显式列出的变量。`PROXY_SHARED_SECRET`、`PROXY_ACCESS_LOG`
> 已默认转发；上表里的 `DSH_PERMISSION_MODE`、`DEEPSEEK_API_KEY` 等在 compose 中是注释行，
> 在 `.env` 里设置后还需取消 compose 中对应注释，否则不会进入容器。

### 3.5 部署侧变量（只影响 compose，不进容器）

| 变量 | 示例值 | 默认值 | 说明 |
|---|---|---|---|
| `DSH_HTTP_PORT` | `8081` | `8080` | 宿主机回环监听端口，映射到容器 8080。 |
| `DSH_IMAGE` | `registry/…/deepseek-harness-plain:0.2.1-rc.5` | `deepseek-harness:plain` | 使用已构建镜像时设置，并删掉 compose 的 `build:` + `pull_policy:` 段。**不要指向 Caddy 版 `1panel/deepseek-harness:<版本>`。** |
| `DSH_VERSION` | `0.2.1-rc.5` | `0.2.1-rc.5` | 构建参数，决定镜像内 dsh 版本。 |
| `DSH_DATA_DIR` / `WORKSPACE_DIR` | `./data/dsh` / `./workspace` | 同左 | 持久化目录。 |

## 4. 数据、备份与恢复

| 容器路径 | 内容 | 必须持久化 |
|---|---|---|
| `/data/dsh` | `profiles/`、`settings.yaml`、`.credentials.yaml`（API Key）、会话记录、`logs/`、`attachments/`、`HOME` | ✅ |
| `/workspace` | Agent 工作区（`workspaceRoot`），项目代码 | ✅（业务数据） |

`/data/caddy` 已不再使用（旧部署可以删除）。备份：

```bash
docker compose stop
tar czf dsh-backup-$(date +%F).tar.gz data/ workspace/
docker compose start
```

恢复后修正属主：

```bash
chown -R 1000:1000 data/dsh workspace
docker compose up -d
```

入口脚本每次启动会以 root 把这两个挂载点**顶层**目录 chown 成 1000:1000 并设 0700/0750；
只改顶层，不递归。NFS/SMB/只读卷无法 chown，会启动失败。

## 5. 运维

```bash
docker compose ps                 # (healthy) 才算就绪
docker compose logs -f            # 入口脚本 + dsh + 转发进程（JSON 访问日志）
docker compose exec deepseek-harness dsh --version
curl -fsS http://127.0.0.1:8080/healthz   # {"ok":true,"backend":200}
```

- **健康检查**：容器内 `curl http://127.0.0.1:8080/healthz`，它同时探测转发进程与后端 dsh。
  该端点只接受**来自回环**的请求（或带 `X-DSH-Proxy-Secret` 的请求），外部扫描拿不到后端状态。
  入口脚本先等 dsh 就绪（最多 60 s）再起转发，所以 compose 把 `start_period` 放宽到 180 s。
- **进程模型**：`tini` 是 PID 1，dsh 与转发进程任一退出整个容器即退出 → `restart: unless-stopped` 必需。
- **优雅退出**：SIGTERM → 转发进程立即停止接收新连接并断开 WebSocket，随后最多等 5 s 让普通响应/流收尾，然后退出 0；
  `stop_grace_period: 30s` 足够。长时间运行的 Agent 任务会被中断（与旧镜像一致，重启前请确认没有关键任务）。
- **升级（含 dsh 版本升级，务必看风险）**：只改小版本（同一 dsh）时 `docker compose build && docker compose up -d` 即可，升级前备份。
  升级 **dsh 版本**不是改个数字：镜像构建期补丁用精确字符串匹配 `isAuthenticated()`，DSH 源码一变构建就会失败；
  DSH 的 WebSocket 路径、`/api` 栅栏、gzip、300 MiB 上限也可能变化。完整清单见
  [SYNC-UPSTREAM.md §5](SYNC-UPSTREAM.md#5-dsh-版本升级最需要注意的一步)，要点：
  1. 同步上游并重新应用/修正 `patch-dsh-authenticated-settings.mjs` 的匹配字符串；
  2. 三处版本号保持一致：`docker-compose.yml` 的 `DSH_VERSION`、`.env.example`、`runtime/.github/workflows/` 默认值；
  3. 构建后跑端到端（`/healthz`、settings、WebSocket、SSE），再发布。

## 6. 排障

| 现象 | 原因与处理 |
|---|---|
| 页面白屏、`/api` 403 `forbidden` | `DSH_ACCESS_HOST` 与浏览器地址不一致（含端口差异）；或外部反代改写了 Host（用了 `$host` 丢端口）。 |
| `401 unauthorized`、容器起不来、日志 `did not become ready` | 镜像补丁丢失或被去掉（`ONEPANEL_DSH_AUTH_PROXY`/`isAuthenticated` 补丁）。必须保留。 |
| 502 | 后端 dsh 未起/已崩；转发进程会在日志里记 502。 |
| UI 能打开但永远不刷新、任务无输出 | 外部反代没有转发 WebSocket 升级（缺 `Upgrade`/`Connection` 头）。 |
| 镜像构建失败：`unexpected browser proxy authentication source shape` / `unexpected PDF worker source shape` | dsh 版本变了，构建期补丁的精确字符串不再匹配。按 [SYNC-UPSTREAM.md §5](SYNC-UPSTREAM.md#5-dsh-版本升级最需要注意的一步) 更新 `patch-dsh-authenticated-settings.mjs`，再跑端到端验证。 |
| 流式输出变成一次性出现 | 外部反代或中间层缓冲了响应（`proxy_buffering off`、别加 gzip 中间件）。 |
| 上传文件 413 | 外部反代 `client_max_body_size` 太小（需 ≥300 MiB）。 |
| 请求返回 400 `Host must not end with a dot` | 上游反代发来了 FQDN 尾点 Host（`dsh.example.com.`）。DSH 会 403 这种 Host，所以这里提前 400；请让反代用 `$http_host`（不带结尾点）。 |
| 偶发 502（空闲后首次请求） | 多层 keep-alive 都可能：外部反代↔容器，或容器内转发进程↔dsh。转发进程已把上游连接池空闲超时设成 4 s（低于 dsh 的 ~5 s）以避免复用被后端关掉的连接；若仍出现，先看访问日志的 `status`/`ms` 定位是哪一跳。 |
| 端口被占用 | 改 `DSH_HTTP_PORT`。 |
| 数据目录在 NFS/SMB 上启动失败 | 入口脚本要 chown/改权限，此类文件系统不支持；改用本地盘或 named volume。 |
| Agent 报沙箱不可用 | 容器内 bwrap 需要非特权 user namespace；DSH 会回退 landlock，两者都不可用时受限命令失败。仅在自建环境考虑 `seccomp=unconfined`，需自行验证。 |

## 7. 安全建议（重要）

1. 容器内**没有任何认证**：不要发布 8080 到不可信网络，也不要让它出现在公网 LB 的后端列表里。
2. 外部反代是唯一认证点；请确保它对**所有路径**生效，包括 `/api/remote.mux` 的 WebSocket。
3. 外部反代自身的 CSRF 防护请保留：DSH 的 Origin 栅栏依赖反代透传 `Origin`，它是第二道防线。
4. 建议外部反代认证后剥离自己的会话 Cookie 再回源（DSH 用不到），减少凭据进入容器网络。
5. 可开启 `PROXY_SHARED_SECRET`；它挡不住能直连端口的人，但能拦住误配置的旁路。
6. 不要把宿主机根目录、`/var/run/docker.sock`、`~/.ssh` 挂进 `/workspace`；Agent 在该目录内默认可写可执行。
7. DSH 仍是开发者预览版，升级前备份；`/workspace` 不要放敏感数据。

## 8. 与旧镜像（Caddy 版）的差异

| 项 | 旧镜像 | 现在 |
|---|---|---|
| 认证 | Caddy `basic_auth` + 入口校验 | 无（外部反代负责） |
| TLS | Caddy `tls internal`，8443 | 无，容器内 HTTP 8080 |
| 反向代理 | Caddy | `node-proxy.mjs`（约 490 行，只用 Node 内置模块，无第三方依赖） |
| 证书/CA | `/data/caddy` 卷 + 导入 root.crt | 不再需要（旧卷可删） |
| 环境变量 | `HTTPS_ACCESS_HOST` + `DSH_AUTH_USERNAME` + `DSH_AUTH_PASSWORD` | 仅 `DSH_ACCESS_HOST`（compose 同时转发旧的 `HTTPS_ACCESS_HOST`） |
| 健康检查 | `curl 127.0.0.1:3080/` | `curl 127.0.0.1:8080/healthz`（同时验证后端） |
| 访问日志 | 无 | JSON 行（可关）：时间、来源（**反代地址**，不是真实客户端 IP）、方法、pathname（不含 query）、状态、耗时、字节，WebSocket 升级也记一条 |
| 安全响应头 | Caddy 注入 `nosniff` / `Referrer-Policy` | 转发进程注入同样两个头 |
| 跨站 `/api` 403 | Caddy `@unsafe_api` | DSH 原生 Host/Origin 栅栏（等价且多一层 Host 白名单） |
| settings 端点 | Caddy 改写 Host/删 Origin | 原样透传（实测无需改写） |

> 升级到本版本后，`/data/dsh` 与 `/workspace` 原样复用，会话、设置、API Key 都保留。

**发布标签**：本变体与 Caddy 版行为不同，**不要**推到 `1panel/deepseek-harness:<版本>` 或 `:latest`。
仓库工作流已改为默认发布到独立仓库 `1panel/deepseek-harness-plain`（`:<dshVersion>` + `:plain` 别名，
一次构建、多 tag 同 digest）；自有仓库请用 `imageName` 输入覆盖。

## 9. 已知限制

- **真实客户端 IP 不可得**：容器内没有认证也没有受信代理链，`X-Forwarded-For` 等头会被**剥离**（防伪造），
  访问日志的 `remote` 是外部反代地址。需要真实 IP 请在外层反代记录。
- **半关闭客户端（只发 FIN）**：Node `http.Server` 平台行为，客户端可能收不到响应；nginx/traefik 默认不会半关闭上游。
- **后端无响应头时**：转发进程 120 s 后返回 504；后端开始发响应后不再设超时（LLM/SSE 可以长时间流式输出）。
- **后端 `Server` / `X-Powered-By` 头**会被剥离；错误响应统一为 `bad gateway` / `gateway timeout` /
  `forbidden` 等通用文本，详细原因只写容器日志，避免泄露内部地址。
- **重复 Host、尾点 Host** 直接 400（DSH 对尾点是 403，这里提前给出明确错误）。

## 附录：文件清单与验证

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 单容器编排（构建/镜像二选一、健康检查、日志轮转、优雅退出） |
| `.env.example` | 全部环境变量示例与注释 |
| `runtime/deepseek-harness/` | 改造后的镜像源码（Dockerfile、entrypoint、node-proxy.mjs、构建期测试）；本地分支 `plain-http` |
| `patches/` | 改造补丁与 bundle（基线见 `patches/BASE`）+ 应用说明 |
| `scripts/sync-upstream.sh` | 一键同步上游：rebase → 测试 → 导出补丁 → 刷新部署仓库 |
| `reports/node-proxy-feasibility.md` | 可行性报告与实测数据 |
| `notes/implementation-fixes.md` | 独立评审发现的问题与修复/接受记录 |
| `notes/` | 镜像核查、环境变量审计、Caddy 对照、方案对比 |

镜像内改动已通过构建期测试（`node --test test-runtime.mjs`）：Host/Origin 透传、Authorization 剥除、
安全头注入、Host 白名单 403、流式不缓冲、WebSocket 101、502、共享密钥、健康检查、4 MB 上传。
