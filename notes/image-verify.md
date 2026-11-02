# 1panel/deepseek-harness:0.2.1-rc.5 镜像核查

> 核查方式：本容器**没有** docker/containerd（`command -v docker` 为空，`/var/run/docker.sock` 不存在），镜像**未运行**。全部结论来自：Docker Hub Registry HTTP API（manifest/config/blob 直取）+ 本地源码 `/tmp/rt-inspect` + 本机 node 24.22.2 / bash 5.2 直接执行入口脚本的校验逻辑。
> 文中「已证明」= 有可复现证据；「未验证」= 无法在本环境证实。

## 0. 结论速览

| 项 | 结论 | 状态 |
|---|---|---|
| 镜像内 DSH 版本 | **0.2.1-rc.5**（layer 内 `@deepseek-ai/dsh/package.json`） | 已证明 |
| 三件套环境变量 | `HTTPS_ACCESS_HOST` / `DSH_AUTH_USERNAME` / `DSH_AUTH_PASSWORD` 必填，缺一即启动失败（exit 1） | 已证明 |
| 用户名 | `^[A-Za-z0-9._-]+$`，空值失败 | 已证明 |
| 密码 | 最短 **12**（C locale 按字节计），空值失败 | 已证明 |
| 镜像声明 VOLUME | **无**；`/data/dsh`、`/data/caddy` 必须显式挂载才会持久 | 已证明 |
| 运行用户 | 入口脚本以 root 启动并 `install -d` 改属主，之后 `gosu` 降权：node=1000:1000、caddy=1001:1001 | 已证明 |
| 对外端口 | 仅 **8443/TLS**；3080 只绑 127.0.0.1 | 已证明 |
| TLS | Caddy `tls internal` 自签 CA，浏览器/上层反代需信任 `/data/caddy/pki/authorities/local/root.crt` | 配置已证明，运行未实测 |
| 健康检查 | `curl http://127.0.0.1:3080/`，30s 间隔、start-period 30s、3 次重试 | 已证明 |

## 1. 镜像身份与元数据（已证明）

- tag `0.2.1-rc.5` → index digest `sha256:8badc9ccf7e4877bb23ac771ab75f4b8b3d005d78ed54905847cec0699d4c7ae`；amd64 manifest `sha256:9f212e64…c438`，arm64 manifest `sha256:685fd4c7…4fba`（与任务给定 digest 一致）。
- amd64 镜像 config `sha256:0a76303d…e009`，其运行时字段与 arm64 config（`sha256:6e0946df…3e60`）**完全一致**（created/history 不同导致 config digest 不同）：
  - `Env`: `PATH`、`NODE_VERSION=24.22.2`、`YARN_VERSION=1.22.22`、`DSH_HOME=/data/dsh`、`DSH_TELEMETRY_DISABLED=1`（**无 LANG/LC_\***、无 `HOME`、无 `HTTPS_ACCESS_HOST` 默认值）
  - `Entrypoint`: `["tini","--","/usr/local/bin/docker-entrypoint.sh"]`；`Cmd` 未设置
  - `WorkingDir=/workspace`；`ExposedPorts={"8443/tcp"}`；`Volumes`（无）；`User`（未设置 → root）
  - `Healthcheck`: `CMD-SHELL curl -fsS --max-time 5 http://127.0.0.1:3080/ >/dev/null || exit 1`，Interval 30s、Timeout 5s、StartPeriod 30s、Retries 3
  - `StopSignal=SIGTERM`
- 镜像内 `/workspace`、`/data/*` 属性（layer `sha256:68768faf…5509` 内直接读取）：
  `data/dsh` 0700 1000:1000；`data/dsh/home` 0700 1000:1000；`data/caddy` 0700 1001:1001；`data/caddy/config` 0700 1001:1001；`workspace/` 0750 1000:1000。
  `/etc/passwd`：`node:x:1000:1000::/home/node:/bin/bash`、`caddy:x:1001:1001::/var/lib/caddy:/usr/sbin/nologin`。
- 镜像内脚本与源码仓库**逐字节一致**（layer 直取 + `diff` 为空）：`/etc/caddy/Caddyfile`（677B layer）、`/usr/local/bin/dsh`（347B）、`/usr/local/bin/docker-entrypoint.sh`（1667B）、`/tmp/test-dsh-runtime.mjs`（2967B，构建后删除）。故下文 file:line 引用与镜像内容等价。

## 2. 镜像内 DSH 版本：0.2.1-rc.5（已证明）

- 目标文件在 layer `sha256:9bfff0bda19d60c771550ccb43f892461aa8d927e53334dd350d74600b3a48c5`（162,265,835 B，即 Dockerfile:44 的 `COPY --from=dsh-builder /usr/local/lib/node_modules`）。
- 该 blob 经 8 路 Range 并发下载到临时文件后 `sha256sum` = `9bfff0bd…a48c5`，与 manifest 中 digest **逐字节吻合**；用 `python3 tarfile`（`r|gz` 流式，扫到第 68,149 个成员即停）取出 `usr/local/lib/node_modules/@deepseek-ai/dsh/package.json`（7989 B），内容：`name=@deepseek-ai/dsh`、`version=0.2.1-rc.5`、`bin.dsh=lib/bin.js`、86 个 dependencies。
- 注意：Dockerfile:5 的 `ARG DSH_VERSION=0.2.1-rc.2` 只是默认值，`docker build` 未显式 `--build-arg DSH_VERSION=0.2.1-rc.5` 时**重建出来的是 rc.2**。本次 tag 的实际版本已由镜像内容证明为 rc.5（构建方如何传入 rc.5 属 **未验证**：sparse checkout 里 `.cnb.yml` 只含 node/php 镜像流水线）。

## 3. 入口脚本校验规则（本地已执行，规则来自 docker-entrypoint.sh:4-12、27-44）

执行顺序：先打印 3 行 1Panel 横幅（stdout，ANSI 颜色）→ 校验 host → 校验 username → 校验 password，任一失败 `exit 1`。**三个变量都没有默认值**，未设置即空串，必然失败。

| 校验项 | 规则 | 失败时 stderr（原文，逐字） |
|---|---|---|
| `HTTPS_ACCESS_HOST` | IPv4（`node:net isIPv4`，不允许前导零）**或**主机名：总长 ≤253、每个点分段 1–63 字符、`[A-Za-z0-9-]`、不以 `-` 开头/结尾；不允许 scheme、port、path、下划线、结尾点、IPv6 | `HTTPS_ACCESS_HOST must be an IPv4 address or hostname without a scheme, path, or port.` |
| `DSH_AUTH_USERNAME` | `^[A-Za-z0-9._-]+$`（必填；不允许 `:` `@` 空格、非 ASCII） | `DSH_AUTH_USERNAME must contain only letters, numbers, dot, underscore, or hyphen.` |
| `DSH_AUTH_PASSWORD` | 长度 ≥ 12（`(( ${#auth_password} < 12 ))`，必填，无上限、无字符集限制） | `DSH_AUTH_PASSWORD must contain at least 12 characters.` |

**最短密码 12**：镜像未设置 `LANG`（config 的 Env 无 LANG），bash 在 C locale 下按**字节**计数（本地复现：6 个汉字 `密码密码密码` 在网络 `env -i` 下 `${#pw}`=18，`LANG=C.UTF-8` 下 =6）。即：ASCII 需 12 字符；多字节字符可能 6 字符就通过。建议统一用 ≥12 位 ASCII。

**accept / reject 矩阵（本地实跑，node 24.22.2 + bash 5.2）**

| 输入 `HTTPS_ACCESS_HOST` | 结果 | 说明 |
|---|---|---|
| `203.0.113.10` / `127.0.0.1` / `0.0.0.0` / `10.0.0.1` | ACCEPT | IPv4 |
| `dsh.example.com` / `localhost` / `a.b-c.d` / `xn--fsq.jp` | ACCEPT | 主机名（`localhost` 单段也可） |
| `EXAMPLE.COM` | ACCEPT | 大写合法（校验大小写不敏感；DSH trustedHosts 断言也按小写比较，见 §5） |
| （空串/未设置） | REJECT | 报 host 错误 |
| `1.2.3`、`1.2.3.4.5`、`203.0.113.999`、`1.2.3.04` | REJECT | 非规范 IPv4，且"纯数字+点"被排除在主机名之外 |
| `https://dsh.example.com`、`dsh.example.com:8443`、`dsh.example.com/path` | REJECT | scheme / port / path |
| `dsh.example.com.`、`bad-.example.com`、`dsh_internal.example.com` | REJECT | 结尾点 / 尾随连字符 / 下划线 |
| `2001:db8::1`、`[::1]` | REJECT | **不支持 IPv6** |
| `dsh 例え.jp`、`dsh.例え.jp` | REJECT | 空格 / 非 ASCII（IDN 只能用 punycode） |
| `-bad.example.com` | REJECT | 额外打印一行 `node: bad option: -bad.example.com`（`node -e` 把以 `-` 开头的值当选项），之后仍是 host 错误、exit 1 |

**用户名示例**：`admin`、`dsh.admin`、`ops_1`、`a-b` 通过；`""`、`a@b`、`admin user`、`üser`、`a:b` 拒绝。

**密码处理**：`caddy hash-password --algorithm argon2id --plaintext "$pw"` 生成 argon2id 哈希；随后 `unset HTTPS_ACCESS_HOST DSH_AUTH_USERNAME DSH_AUTH_PASSWORD`（entrypoint:47），子进程只拿到哈希（`DSH_AUTH_PASSWORD_HASH`）与 `ONEPANEL_DSH_AUTH_PROXY=1`；DSH 侧永远看不到明文/basic auth 头（Caddy 转发前删 `Authorization`）。
- 明文仅存在于容器 env：`docker inspect` / compose 文件仍可见，属已知暴露面（比 bake 进镜像好，但不等于 secret）。
- 密码以单个 argv 传入，含引号/`$`/空格均安全；不支持 NUL。

**自检入口**：`docker run --rm 1panel/deepseek-harness:0.2.1-rc.5 --self-test` → 本地实跑 exit 0（只跑 5 条 `is_access_host` 断言，不启动服务）；镜像构建时也执行过（Dockerfile:66），因此上述 host 规则在发布镜像内已被构建期验证。

## 4. 运行目录、持久化与 uid/gid 后果

| 路径 | 镜像内属性 | 用途 | 是否必须持久化 |
|---|---|---|---|
| `/data/dsh`（`DSH_HOME`） | 0700 node(1000) | DSH 运行时数据：`profiles/`、`logs/` 等（`$DSH_HOME/profiles/web/cordis.yml` 等，本地以 rc.5 实测生成） | **必须** |
| `/data/dsh/home`（`HOME`，dsh 子进程） | 0700 node(1000) | `~`：pnpm store、git/ssh 配置、缓存等（默认 DSH_HOME 是 `$HOME/.dsh`，镜像显式分离成 `/data/dsh`） | 必须（在 `/data/dsh` 之内，随父目录持久） |
| `/data/caddy`（`XDG_DATA_HOME`） | 0700 caddy(1001) | `pki/authorities/local/root.crt` 本地 CA、站点证书等 | **必须**（否则每次重建换 CA，浏览器信任失效） |
| `/data/caddy/config`（`XDG_CONFIG_HOME`） | 0700 caddy(1001) | Caddy 配置/autosave | 必须（在 `/data/caddy` 之内） |
| `/workspace`（`WORKDIR`） | 0750 node(1000) | shell/agent 的工作目录，用户项目文件 | 建议 bind mount；不挂则重建即丢 |

- **镜像没有声明 `VOLUME`**（config `Volumes` 为空）：不显式挂载时，以上数据全在容器可写层，`docker rm` / compose 重建即丢失。最小可用：挂 **2 个卷** `/data/dsh` + `/data/caddy`；需要保留项目文件再 bind mount `/workspace`（只挂 `/data/dsh/home` 不够，`/data/dsh/profiles`、`/data/dsh/logs` 会丢）。
- **启动时以 root 强制修正属主/权限**（entrypoint:49-51，每次启动都执行）：
  `install -d -m 0700 -o node -g node /data/dsh /data/dsh/home`、`-m 0750 -o node -g node /workspace`、`-m 0700 -o caddy -g caddy /data/caddy /data/caddy/config`。
  本地实测：`install -d` 对**已存在**目录也会设置 mode 并尝试 chown（非 root 下 `install -d -g 0 existing/` 报 `install: cannot change owner and permissions of '…': Operation not permitted`）。因此：
  - 命名卷由 Docker 建成 `root:root` → 启动时被改成 1000/1001，**正常工作**；
  - 宿主机上 root 拥有的 bind mount（读写）→ 也能起来，但**宿主目录属主会被改成 uid 1000（dsh/workspace）或 1001（caddy）**，这是宿主机可见的副作用；
  - bind mount 为 `:ro`、只读文件系统、NFS root-squash、SMB 等无法 chown/chmod 的场景 → `install` 失败，`set -e` 直接退出（exit 1），容器进入重启循环；日志会先有 3 行横幅，随后是 `install: cannot change owner and permissions of '/data/dsh': …`（具体文本取决于文件系统，**未在本环境实测**）。
  - 容器内 dsh 以 node(1000) 写数据，宿主上生成的文件属主是 1000:1000；caddy 以 1001:1001 写 CA。宿主机要直接编辑这些文件需对应 uid（或加 supplementary group）。
- 其他路径无需持久化：`/tmp/test-dsh-runtime.mjs` 构建后已删除；`/usr/local/lib/node_modules`（dsh 0.2.1-rc.5 + pnpm 11.7.0）来自镜像；`/var/lib/caddy`（HOME）被 XDG 覆盖，实际不写业务数据。

## 5. 网络面与 TLS / 反向代理

**容器内监听**
- DSH：`node …/lib/bin.js web --no-open --host 127.0.0.1 --port 3080 --trusted-host 127.0.0.1:3080 "<HTTPS_ACCESS_HOST>"`（entrypoint:69-71）→ 仅 loopback。**发布 3080 没有意义**（Docker 端口映射 DNAT 到容器 IP，应用只绑 127.0.0.1，连接会被拒绝）。
- Caddy：site address `https://{$CADDY_ACCESS_HOST}:8443`（监听 8443 全部接口），`EXPOSE 8443` 是唯一对外端口。

**Caddyfile 行为**（镜像内文件与仓库逐字节一致）
- `admin off`（无 admin API）；`auto_https disable_redirects`（**不监听 80、无 HTTP→HTTPS 跳转**）；`skip_install_trust`；`default_sni {$CADDY_ACCESS_HOST}`；`tls internal` → 自签本地 CA；`encode zstd gzip`。
- `basic_auth argon2id`：**Caddy 是唯一用户认证**（401/`WWW-Authenticate: Basic`）。
- 安全响应头：`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、删 `Server`。
- `@unsafe_api`：`/api` 与 `/api/*` 中，`Origin` 非空且 ≠ `"https://" + {http.request.hostport}`，或 `Sec-Fetch-Site: cross-site` → **403 `Forbidden`**（请求不得到达 DSH；仓库 `test-runtime.mjs` 断言此点）。
- `@settings_api`（`/api/settings/{describe,update,replace,mutate}`、`/api/credentials/{describe,set,unset}`、`/api/llm/discoverModels`）→ 反代到 `127.0.0.1:3080`，且 **Host 改写成 `127.0.0.1:3080`、删除 Origin 与 Authorization**（配合镜像打的 `ONEPANEL_DSH_AUTH_PROXY=1` 补丁，使这些接口在代理后可用）。
- 其余请求 → 反代到 `127.0.0.1:3080`，保留原 Host，仅删 `Authorization`。

**DSH 自身的 /api Host/Origin 围栏**（本地安装的 0.2.1-rc.5 源码，`dsh-client-connection/lib/index.js`）
- 每个 `/api` 请求的 Host 必须是：127/8、`localhost`、监听绑定的 IP，或 `trustedHosts` 之一；`trustedHosts` = `127.0.0.1:3080` + `$HTTPS_ACCESS_HOST`（**无端口项匹配任意端口**，比较大小写不敏感）。带 `Origin` 时必须与 Host 同 authority，否则 **403 `forbidden`**（`response.writeHead(403); end("forbidden")`）。
- 因此**浏览器访问的 host 必须等于 `HTTPS_ACCESS_HOST`**，且上层代理不要把 Host 改写成内部地址。

**HTTPS_ACCESS_HOST 不匹配的后果**
1. Caddy site block 不匹配该 Host → 返回**空 200**（不反代；仓库测试明确断言 `attacker.invalid` 得到空 body），表现为白屏而非报错；
2. 证书 SAN 不等于访问名 + `default_sni` 指向 `HTTPS_ACCESS_HOST` → 浏览器/上层校验告警或失败；
3. 若请求绕过 Caddy 直达 DSH → 403 `forbidden`。

**反过来：在 Caddy 前面再放一层反向代理**
- 外层必须用 **HTTPS 连 8443**（Caddy 只提供 TLS；没有明文 8443 监听）。
- 必须设置 SNI = `HTTPS_ACCESS_HOST`（nginx `proxy_ssl_name`/`proxy_ssl_server_name on`；curl `--resolve` 或 `-k`），否则命中 `default_sni` 证书 → 名称不匹配。
- 证书校验二选一：信任 `/data/caddy/pki/authorities/local/root.crt`（从容器/卷取出，nginx `proxy_ssl_trusted_certificate`），或 `proxy_ssl_verify off` 接受自签。**自签是预期行为，不是配置错误**。
- **必须原样转发 `Host` 与 `Origin`**（不要改成 `127.0.0.1:3080`、不要改端口）。原因：`@unsafe_api` 用 `https://` + Host 逐字比较 Origin；DSH 围栏要求 Host=trusted 且 Origin=Host。
- 端口一致性：浏览器对非 443 端口会发送 `Host: host:port`。保持「对外端口 = 容器 8443」映射（`8443:8443`，URL `https://host:8443`）最稳；若映射 `443:8443`，Host 不带端口，DSH trusted host 无端口项可匹配、Caddy 站点匹配按主机名忽略端口（Caddy 文档语义，本环境**未实测**）；但切勿出现「浏览器 443、Host 里是 8443」这类不一致，否则 settings/credentials 接口会 403。
- 外层 TLS 终止 + 重新加密也可以，但 basic auth 仍由 Caddy 校验，外层必须把 `Authorization` 透传；并且这里没有「关闭 Caddy basic auth」的开关（需自行改镜像）。
- 直接发布 8443 用浏览器访问也行：此时需把 `root.crt` 导入系统/浏览器信任库以消除告警（不导入就是告警页，功能仍可用）。
- IPv4/IPv6：`HTTPS_ACCESS_HOST` 不支持 IPv6 字面量，纯 IPv6 入口场景该镜像不可用（校验层结论）。

## 6. 健康检查与生命周期

- 镜像 `HEALTHCHECK`：`curl -fsS --max-time 5 http://127.0.0.1:3080/`，interval 30s、timeout 5s、start-period 30s、retries 3 → **只反映 DSH 进程是否还活着**；8443/TLS/证书/basic auth 坏掉时仍可能显示 healthy。失败累计到 unhealthy 约需 ≥2 分钟（30s start-period + 3×30s）。
- 入口编排：DSH 先起 → 最多 60 次 `curl --max-time 2`（每次 +1s sleep，最坏约 3 分钟墙钟）探活 → 成功后才起 Caddy。超时打印 `DeepSeek Harness did not become ready within 60 seconds.` 并 exit 1。成功打印两行：
  `DeepSeek Harness is available at https://<host>:8443 inside the container.`
  `The local CA certificate is stored at /data/caddy/pki/authorities/local/root.crt.`
- 进程模型：`tini -- docker-entrypoint.sh` 是 PID 1，`STOPSIGNAL SIGTERM`；entrypoint 在 **EXIT trap** 里对 dsh+caddy 发 SIGTERM 并 wait，`trap 'exit 143' TERM`（INT→130）。`wait -n` 表示**任一子进程退出，整个容器即退出**（不会单独重启 dsh 或 caddy）→ 生产请配 `restart: unless-stopped`。
- 实际启动耗时、停机释放耗时、内存/CPU 占用：**未验证**（无法运行镜像）。

## 7. 明确「未验证」清单

1. 镜像**从未运行**：无 docker/containerd、无 `/var/run/docker.sock`，因此启动耗时、`healthy` 时机、CA 实际生成、TLS 握手、`/workspace` 内实际可写性均未实测。
2. Caddy 运行时行为（403、`Forbidden`、空 200、`tls internal` 证书 SAN、`default_sni`）未实跑：本机 `/tmp` 为 `noexec`，下载的 caddy 2.11.4 二进制无法执行；结论依据镜像内 Caddyfile（逐字节一致）+ 仓库 `test-runtime.mjs` 断言（Dockerfile:67 在构建时运行，失败则构建失败）+ Caddy 文档。端口映射 443→8443 的 Host 匹配未实测。
3. 该 tag 是否用 `--build-arg DSH_VERSION=0.2.1-rc.5` 构建：CI 配置不在 sparse checkout 内（`.cnb.yml` 只有 node/php 流水线）；但镜像内容已证明版本为 rc.5，重建时**必须显式传 build-arg**，否则默认 rc.2。
4. 镜像内 `isAuthenticated` 代理补丁是否真的打上：未从 144MB 层里取该文件验证；依据 Dockerfile:18 执行补丁脚本 + 脚本自带校验（行 40-42）会使构建失败，属推断。
5. 镜像内 caddy 二进制版本（Dockerfile `FROM caddy:2.11.4`，未执行二进制验证）。
6. arm64 运行行为：其运行时 config 与 amd64 完全一致，但未运行。
7. `install -d` 在只读卷/网络文件系统上的**具体报错文本与退出码**：仅本地验证了「会尝试 chown」与「失败即中止」的机制。
8. Caddy 的 `/data/caddy/pki/authorities/local/root.crt` 首次生成时机（启动即生成 or 首次签发证书时），未实测路径存在性。

## 8. 证据清单（可复现命令/位置）

- 镜像身份：`curl -H "Authorization: Bearer $TOKEN" https://registry-1.docker.io/v2/1panel/deepseek-harness/manifests/0.2.1-rc.5`（`Docker-Content-Digest: sha256:8badc9cc…c7ae`）；amd64 manifest → config `sha256:0a76303d…e009`；arm64 manifest → config `sha256:6e0946df…3e60`（运行时字段与 amd64 相同）。
- 版本证明：layer `sha256:9bfff0bd…a48c5`（162,265,835 B，8 路 Range 下载，`sha256sum` 与 manifest digest 一致）→ `python3 tarfile` 流式取 `usr/local/lib/node_modules/@deepseek-ai/dsh/package.json`（7989 B，version `0.2.1-rc.5`）。
- 目录/属主证明：layer `sha256:68768faf…5509` → `tar -tvzf`：`data/dsh` 0700 1000:1000、`data/caddy` 0700 1001:1001、`workspace/` 0750 1000:1000；`etc/passwd`/`etc/group` 中 node=1000、caddy=1001。
- 内容一致性：layer `c1a4d26f…64fb`(Caddyfile)、`0e846163…a4db`(dsh)、`e00a9954…027c`(docker-entrypoint.sh)、`a4d95380…fab0`(test-runtime.mjs) → 解包后与 `/tmp/rt-inspect/deepseek-harness/*` `diff` 为空。
- 入口校验：把 `docker-entrypoint.sh:4-12`（`is_access_host`）与 `:27-44`（校验块）**逐字提取**成 `/tmp/val.sh` 跑 25 个 host 用例；再用真实脚本 `env -i PATH=… bash docker-entrypoint.sh` 逐项触发，得到三条 stderr 原文与 exit 1；`bash docker-entrypoint.sh --self-test` 本地 exit 0。
- 密码长度语义：`env -i PATH="$PATH" bash /tmp/pwlen.sh "密码密码密码"` → `chars=18`（C locale 按字节）；`LANG=C.UTF-8` → `chars=6`；镜像 config `Env` 无 LANG。
- 持久化/属主机制：`install -d -m 0700 /tmp/inst-t` 对已存在目录生效（755→700）；`install -d -g 0 /tmp/inst-t`（非 root）→ `install: cannot change owner and permissions of '/tmp/inst-t': Operation not permitted`。
- DSH 围栏与 trustedHosts：本地安装 `@deepseek-ai/dsh@0.2.1-rc.5`（`node -p` 校验版本）→ `dsh-web-app/lib/startup.js`（`--trusted-host` 帮助文本）、`dsh-client-connection/lib/index.js`（`isTrustedApiRequest`、`isSameAuthorityOrigin`、无端口 trustedHosts 项「匹配任意端口」、403 `forbidden`）、`@deepseek-ai/dsh-home-paths`（默认 DSH_HOME=`~/.dsh`）。
- 参考文档：`/tmp/rt-inspect/deepseek-harness/{Dockerfile,docker-entrypoint.sh,Caddyfile,dsh,test-runtime.mjs,patch-dsh-authenticated-settings.mjs}`。
