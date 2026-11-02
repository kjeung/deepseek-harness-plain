# 构建 / 部署 / 文档 / 发布侧独立评审（明文 HTTP 版 DeepSeek Harness）

> 评审人：review-build（独立评审，不代表实现方）
> 时间：2026-11-02T05:35Z 左右；环境：node v24.22.2、bash 5.2.37、**无 docker/containerd**（`command -v docker` 为空），因此**未构建、未运行镜像**，镜像内行为只能静态推断 + 本机等价执行。
> 交付物只包含本文件；未改动任何实现文件。

## 0. 评审基线与一个必须先说明的事实

**实现正在被并发修改。** 评审期间 `runtime/deepseek-harness/node-proxy.mjs` 在 05:26→05:34 之间至少变更 3 次（102→319→321 行）。本报告的**构建侧结论**依据的文件在 05:23–05:25 之后未再变化，仅代理内部行为/行号可能漂移。

| 文件 | 评审时 sha256（前缀） | 备注 |
|---|---|---|
| `runtime/deepseek-harness/Dockerfile` | `75a774ec…` | 77 行 |
| `runtime/deepseek-harness/docker-entrypoint.sh` | `ec4627e6…` | 96 行 |
| `runtime/deepseek-harness/test-runtime.mjs` | `0d924771…` | 352 行 |
| `runtime/deepseek-harness/patch-dsh-authenticated-settings.mjs` | `50d6c2ae…` | 仅注释改动 |
| `runtime/deepseek-harness/node-proxy.mjs` | `7df102a9…` | **并发修改中**，321 行；本报告引用其行号时标注「评审时修订」 |
| `docker-compose.yml` / `.env.example` / `README.md` | 见正文行号 | 05:25 后未变 |

另外：`runtime/.github/workflows/deepseek-harness-release.yml` **不在工作树里**（该克隆是 sparse-checkout，只检出 `deepseek-harness/`），本报告按 `git show HEAD:.github/...` 读取；`git status` 显示它**未被本次改动修改**，这正是 P0 的根据。

---

## 1. 结论（verdict）

**构建链本身基本自洽，但当前形态不可发布。**

- 可以确认正确的部分：Dockerfile 的 COPY 路径与 build context 一致；`dsh-node-proxy` 有 node shebang 且被 chmod 0755；`--self-test`、`node --test`、HEALTHCHECK 的 `curl`、`EXPOSE 8080`、无 Caddy 残留、compose YAML、compose 构建路径与 Dockerfile 的对应关系、env 变量集合一致性，这些**静态检查全部通过**。
- 本地实测：8 个代理测试在**连续 3 次**运行中全部通过（每次约 4.7 s）；完整 `node --test` 为 8 pass / 2 fail，失败的恰好是需要镜像构建期 polyfill 的 2 个 PDF 用例（本地 DSH 未打补丁，属预期，见 §5）。
- **阻塞项（P0）**：发布工作流完全没有改。它会把"无认证、无 TLS、8080"的镜像推到现有的 `1panel/deepseek-harness:<dshVersion>` 和 `:latest` 同名 tag 上，等于把官网镜像静默替换成安全边界完全不同的镜像。
- **必须修（P1）**：compose 硬性要求 `DSH_ACCESS_HOST`，使文档承诺的 `HTTPS_ACCESS_HOST` 兼容在 compose 路径不可达；`PROXY_SHARED_SECRET` 等安全开关在 compose 里未转发，用户以为已开启实际未生效；`image:` 与 `build:` 并存时默认 pull 优先，`DSH_IMAGE` 设成旧 HTTPS 镜像会在不改源码的情况下直接运行旧镜像。
- **未验证**：镜像构建/运行、镜像内 PDF 测试、arm64/QEMU 下构建期时序测试、`gosu env` 在 root 下的继承行为、compose 的 pull/build 实际动作（本机无 docker；pull 语义依据官方文档）。

---

## 2. Findings（按严重度）

| 级别 | # | 位置（file:line） | 问题 | 影响 |
|---|---|---|---|---|
| **P0** | B-1 | `runtime/.github/workflows/deepseek-harness-release.yml:22,52-53,57-68`（HEAD；工作树未检出、无 diff）；`runtime/README.md:21`、`runtime/README_zh.md:21` | 发布流水线仍把镜像打成 `1panel/deepseek-harness:<dshVersion>`，第二段还默认 `pushLatest=true` 覆盖 `:latest`。仓库 README 却已改成"明文 HTTP 反代"描述 | 现有 HTTPS+Caddy 镜像被同名 tag 静默替换；升级用户拿到无认证、无 TLS、端口从 8443 变 8080 的镜像；`:latest` 语义被破坏；无 tag 可区分两种行为，回滚/排障困难。**安全回归 + breaking change** |
| **P1** | B-2 | `docker-compose.yml:34` vs `docker-entrypoint.sh:30,37`；`README.md:82,195` | compose 用 `${DSH_ACCESS_HOST:?…}` 强制必填；入口脚本虽兼容 `HTTPS_ACCESS_HOST` 回退，但 compose 的插值阶段就会失败。README 却写"旧名兼容"且"会提示改用" | 旧部署仅替换 compose/镜像时 `docker compose up` 直接报插值错误；`HTTPS_ACCESS_HOST` 兼容性在官方 compose 路径上不可达，文档承诺不成立 |
| **P1** | B-3 | `docker-compose.yml:35-38`；`.env.example:34-39,42-44`；`README.md:96-99` | `PROXY_SHARED_SECRET`、`PROXY_ACCESS_LOG` 在 compose 的 `environment:` 中被注释掉（compose 只转发显式列出的变量）；"还需到 compose 取消注释"的提示只写在 `.env.example:42-44` 的**应用层变量**段落，没覆盖这两个安全/日志变量 | 用户按 `.env.example` 在 `.env` 里设置共享密钥，实际容器内 `PROXY_SHARED_SECRET` 为空 → 共享密钥"看起来开启、实际关闭"，纵深防御静默失效；访问日志同理 |
| **P1** | B-4 | `docker-compose.yml:20-25`；`README.md:118`；`.env.example:20-21` | `image:` 与 `build:` 同时存在且未设 `pull_policy`。按 Compose 规范，此时 **先 pull，pull 不到才 build**（[官方文档](https://docs.docker.com/reference/compose-file/build/#using-build-and-image)）。`DSH_IMAGE` 若指向已存在的镜像（最容易踩的是旧 `1panel/deepseek-harness:<version>` HTTPS 镜像），compose 会直接运行被拉取的旧镜像，而不构建 `./runtime` 源码；反之默认 `deepseek-harness:plain`（无 registry）会先 pull 失败再构建。且 `DSH_VERSION` 只是 build arg，**不进入 tag**，不同 dsh 版本互相覆盖同一 tag | 迁移时"以为在用新明文镜像，实际在跑旧 HTTPS 镜像"：8443 监听、入口要求 `HTTPS_ACCESS_HOST/DSH_AUTH_*`、healthcheck 打 8080 必然失败 → 重启循环；版本不可追溯、无法回滚 |
| P2 | B-5 | `Dockerfile:72-73`；`docker-entrypoint.sh:65-80` | 镜像自带 HEALTHCHECK 的 `start_period=30s`，小于入口脚本等待 DSH 就绪的上限 60s。compose 覆盖成 120s 所以 compose 场景无碍 | 直接 `docker run`（不走 compose）时冷启动前半分钟 healthcheck 连续失败，最长可能被标 `unhealthy`；属状态误报，不重启容器 |
| P2 | B-6 | `README.md:82`；`docker-entrypoint.sh:29-30,37` | README 写"`HTTPS_ACCESS_HOST` 仍被接受（兼容），但会提示改用 `DSH_ACCESS_HOST`"。入口脚本里**没有任何 deprecation 提示**，只是静默回退；错误信息也只打印 `DSH_ACCESS_HOST` | 文档与行为不一致，B-2 的误导性被放大 |
| P2 | B-7 | `README.md:193`；`node-proxy.mjs`（评审时修订 321 行） | 表格写 `node-proxy.mjs`"130 行，Node 内置模块，无第三方依赖"。当前实现 321 行（原型 `prototype/node-proxy.mjs` 也只有 63 行）。"无第三方依赖"本身正确 | 文档数字失真，读者无法据此评估维护成本 |
| P2 | B-8 | `README.md:96-111`；`.env.example:42-44` | "compose 只转发显式列出的变量、所以 .env 里设了还要去 compose 取消注释"这句话只出现在 `.env.example` 的应用层段落；README §3.3/§3.4 直接按"设这个变量就行"的口吻写 | 用户按 README 在 `.env` 设 `DEEPSEEK_API_KEY`/`PROXY_SHARED_SECRET` 会被静默忽略，排查成本高 |
| P2 | B-9 | `test-runtime.mjs:164-352` | 8 个代理用例覆盖了 Host/Origin 透传、Authorization/secret 剥除、安全头、Host 白名单 403、缺 Host、流式、WS 101+403、502、共享密钥、healthz+SIGTERM、4 MB body。**缺口**：SSE `/plugins/events` 不缓冲、300 MiB 上限、SIGTERM 时有活跃 WS、Host 带端口/大写/尾点归一化、healthz 后端宕机返回 502、空闲 keep-alive 复用后首请求、错误响应也带安全头、WS 路径上的共享密钥校验 | 当前测试不足以证明 README §8/§2 承诺的 SSE、≥300 MiB 上传、优雅退出等行为；发布前无法用构建期测试兜底这些回归 |
| P2 | B-10 | `test-runtime.mjs:62-69,129-134,229,255`；`workflow:13,31-35` | 时序/端口类不稳定因素：流式用例固定 `setTimeout(400)` + `<300ms` 墙钟断言；`freePort()` 先关后用的 TOCTOU；`startProxy` 最多等 5s；而工作流默认在 **linux/amd64 + linux/arm64（QEMU 模拟）** 两种架构上执行同一套构建期测试 | 发布构建在慢/模拟环境下可能偶发失败（尤其 300ms 断言）；本地 3/3 通过（4.6–4.7s），**本次未复现**，但这是发布流水线的现实风险 |
| P2 | B-11 | `test-runtime.mjs:27-51`；`Dockerfile:62`；`README.md:214` | 本地完整 `node --test` 的 2 个 PDF 用例失败，因为本机 DSH 未执行镜像构建期的 `patch-dsh-authenticated-settings.mjs` polyfill；镜像内预期通过但**本环境无法构建镜像验证**。README 却已宣称"镜像内改动已通过构建期测试" | README 的"已验证"声明在本环境不可复核；若 PDF patch 回归，构建会失败（好事），但评审无法提前发现 |
| P2 | B-12 | `runtime/.github/workflows/...:46,61`；`docker-compose.yml:22` | 仓库根**没有 `.dockerignore`**（`runtime/.dockerignore` 不存在；只有 `comfyui/.dockerignore`）。workflow 的 build context 是 `.`，compose 的 context 是 `./runtime`（克隆根） | 构建上下文包含 `.git` 与仓库内其他镜像源码（当前稀疏 `.git` 仅 420K，完整 clone 更大）；构建变慢、缓存易失效；未来若有人放宽 COPY 还有误打包风险。属既有问题，但本次改动让 context 依赖更明显 |
| P2 | B-13 | `deployment/.gitignore:12`；`docker-compose.yml:18,22` | `.gitignore` 把 `runtime/`（"克隆的上游镜像仓库"）整个忽略，而 compose 的 build context 恰好是 `./runtime`；`deployment/` 目录本身当前**不是** git 仓库（未验证其发布方式） | 若把 deployment 目录作为独立仓库发布，fresh clone 没有 `runtime/`，`docker compose build` 会因 context 不存在而失败；需要 submodule/发布说明/或改为引用已发布镜像 |
| P2 | B-14 | `Dockerfile:72-73`；`docker-entrypoint.sh:66` | readiness/healthcheck 的 curl 没有 `--noproxy '*'`。本机 curl 8.14.1 实测：大写 `HTTP_PROXY` 不生效，但**小写 `http_proxy` / `ALL_PROXY` 会生效**；DSH 自身也识别小写代理变量（见 `notes/env-audit.md` 的代理条目） | 当前 compose 只转发大写 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`，按文档配置不受影响；但用户/后续维护者若补小写变量（DSH 支持），127.0.0.1 探测会被代理劫持 → 容器永远起不来或 healthcheck 恒 unhealthy。属加固项 |
| P2 | B-15 | `README.md:172`；`node-proxy.mjs:120`（评审时修订） | README 把"偶发 502（空闲后首次请求）"归因为"外部反代 keepalive 与容器 `keepAliveTimeout(65s)` 不匹配"，未给证据；代理 upstream agent 设了 `timeout:0`，而 DSH 后端是 Node 默认 `keepAliveTimeout=5s`，这一组合下空闲复用旧连接的行为**没有任何测试覆盖** | 该排障建议可能误导；如果 502 真实来自容器内 proxy→DSH 的 keep-alive 复用，用户按 README 调外部反代不会解决 |
| P2 | B-16 | `.env.example:21`；`docker-compose.yml:20`；`README.md:118` | `.env.example` 的示例 `DSH_IMAGE=registry.example.com/deepseek-harness:0.2.1-rc.5-plain` 这种 `-plain` tag **没有任何流水线会产出**（见 B-1）；compose 默认 `deepseek-harness:plain` 又与文档示例不一致 | 用户按示例去拉镜像会 404；与 B-1/B-4 的修复必须联动 |
| P2 | B-17 | `test-runtime.mjs:113-123` | `startProxy` 用 `...process.env` 继承环境但只覆盖了 `PROXY_ALLOWED_HOSTS/PROXY_ACCESS_LOG` 等，**没有覆盖 `PROXY_SHARED_SECRET`** | 开发机/CI 若恰好导出 `PROXY_SHARED_SECRET`，除共享密钥用例外全部测试会因 403 误失败；测试环境不封闭 |
| P2 | B-18 | `Dockerfile:20-26` | 最终阶段没有 `ARG DSH_VERSION`/`org.opencontainers.image.version`、`revision` 标签；镜像元数据只有一个 description | 镜像内容里的 dsh 版本无法从 `docker inspect` 追溯（旧问题，但本次同时改了版本默认值，建议一并修） |

### 2.1 对 P0 的补充

- 该工作流文件在 `git status` 中没有任何改动，说明"改成明文 HTTP"只改了 Dockerfile/entrypoint/test/docs，**发布出口没改**。
- 合并后 `1panel/deepseek-harness:0.2.1-rc.5` 与 `:latest` 都会指向新行为；`image-verify` 已证明现有 `:0.2.1-rc.5` 是 Caddy/HTTPS/8443 镜像，因此这是**same-tag 行为替换**，不是新增变体。
- 第二段"Push latest tag"是一次**独立的 build-push**（`workflow:57-69`，重复 build-args），与第一段可能产生不同 digest；即便要保留 `:latest`，也应一次 build 打两个 tag。

### 2.2 对 P1（B-4）的补充（已核对 Compose 规范）

官方 Compose Build 规范原文："When Compose is confronted with both a `build` subsection for a service and an `image` attribute, it follows the rules defined by the `pull_policy` attribute. If `pull_policy` is missing …, Compose attempts to pull the image first and then builds from source if the image isn't found in the registry or platform cache."（[Using build and image](https://docs.docker.com/reference/compose-file/build/#using-build-and-image)）
`pull_policy: build` 可显式指定"总是构建、已存在也重建"（[pull_policy](https://docs.docker.com/reference/compose-file/services/#pull_policy)）。

所以：
- 默认 `deepseek-harness:plain`（无 registry 命名空间）：`docker compose up -d` 会**先尝试 pull `docker.io/library/deepseek-harness:plain`**（通常 404/denied），随后才 build；README 的 `up -d --build` 可以绕过，但 `docker compose pull` 会稳定报错，日志噪音大且易被误解。
- `DSH_IMAGE=1panel/deepseek-harness:0.2.1-rc.5` + 保留 `build:`：pull 成功 → **实际运行旧 HTTPS 镜像**。这与"用仓库源码构建"的预期完全相反。
- `DSH_VERSION` 不是 tag 的一部分：两个不同 dsh 版本构建都会落到同一个 `deepseek-harness:plain`/`DSH_IMAGE` tag，升级不可追溯（README §5 的"改 DSH_VERSION 后 build"正是这种覆盖式升级）。

---

## 3. Dockerfile 逐项核查

| 检查项 | 结论 | 证据 |
|---|---|---|
| 多阶段构建是否还成立 | ✅ 静态成立。builder 安装 dsh + 运行 patch；final 从 builder COPY node_modules | `Dockerfile:1,10,12-16,41` |
| Caddy stage / 二进制 / 用户 / 目录是否有残留 | ✅ 无。`FROM caddy`、`COPY --from=caddy`、`groupadd caddy`、`/data/caddy` 全部删除；其余脚本无 `caddy` 引用 | `Dockerfile` 全文；`docker-entrypoint.sh` 全文；`test-runtime.mjs` 仅注释提到 Caddy |
| COPY 路径与 build context 是否一致 | ✅ 一致。Dockerfile 用 `deepseek-harness/...` 前缀 → context 必须是 runtime 仓库根；workflow `context: .`、compose `context: ./runtime`，二者都满足 | `Dockerfile:12,52-55`；workflow:46,61；`docker-compose.yml:22` |
| 目标文件权限 | ✅ `chmod 0755 /usr/local/bin/dsh /usr/local/bin/docker-entrypoint.sh /usr/local/bin/dsh-node-proxy`；COPY 源文件权限（工作区当前 0600）被 chmod 覆盖 | `Dockerfile:57-58` |
| `dsh-node-proxy` 是否可执行、shebang 是否正确 | ✅ `#!/usr/bin/env node`，0755；本机用 0755 副本**直接执行** `--self-test` 退出 0。注意：工作区文件是 0600，直接 `./node-proxy.mjs` 会 permission denied；`/tmp` 在本机是 noexec（首次实测 126 是环境原因，不是脚本问题），镜像 `/usr/local/bin` 不受影响 | `node-proxy.mjs:1`；本地实测见附录 A |
| 无扩展名脚本的 ESM 解析 | ✅ 在 node 24.22.2 上 `node ./node-proxy.mjs --self-test` 与直接执行均退出 0（Node 22.7+ 模块语法探测）；镜像 node:24 满足。**风险**：若将来把基础镜像降到 <22.7 会立刻失败；建议显式 `.mjs` 或加 `package.json {"type":"module"}` | `node-proxy.mjs:45`（`export`）；附录 A |
| `--self-test` 调用是否会被"必需环境变量"拦截 | ✅ `--self-test` 分支在 `PROXY_ALLOWED_HOSTS` 必填检查**之前**，无 env 也退出 0 | `node-proxy.mjs:301-309`（评审时修订） |
| `docker-entrypoint.sh --self-test` | ✅ 本地执行退出 0 | 附录 A |
| HEALTHCHECK 的 curl 是否存在 | ✅ final 阶段 `apt-get install ... curl` | `Dockerfile:33` |
| HEALTHCHECK 由谁执行 | ✅ 镜像无 `USER` 指令，healthcheck 以 root 执行；`/healthz` 不依赖容器 env | `Dockerfile`（无 USER）；`node-proxy.mjs:160`（healthz 分支在 Host/secret 校验之前） |
| HEALTHCHECK 探测路径是否可用 | ✅ 代理启动后 `/healthz` 会再探测后端 `GET /`；入口脚本先等 3080 就绪再起代理。**注意 start-period 偏低**（B-5） | `Dockerfile:72-73`；`docker-entrypoint.sh:64-89` |
| 端口 | ✅ `EXPOSE 8080`、代理默认 `PROXY_LISTEN_PORT=8080`、entrypoint 显式传 8080、compose 映射 `:8080` 一致 | `Dockerfile:70`；`docker-entrypoint.sh:82-87`；`docker-compose.yml:52` |
| 代理以 node(1000) 运行是否可行 | ✅ 端口 8080>1024；`/usr/local/bin` 只读可执行；代理不写文件系统（仅 stdout/stderr）。入口用 `gosu node env ... node /usr/local/bin/dsh-node-proxy` | `docker-entrypoint.sh:82-89`；`Dockerfile:52-58` |
| 构建期测试能否在镜像内跑 | ✅ 结构上可以：测试文件被 COPY 到 `/tmp`，测试 spawn `process.execPath` + `/usr/local/bin/dsh-node-proxy`（不依赖 shebang/可执行位），绑定 127.0.0.1 临时端口，读取已安装 DSH 包（默认路径 `/usr/local/lib/node_modules/@deepseek-ai/dsh`）。本机用**无扩展名 0755 副本**跑 8 个代理用例 3/3 全过。**未验证**：镜像内 2 个 PDF 用例 | `Dockerfile:55,62`；`test-runtime.mjs:13,58,111-145`；附录 A |
| `node --test` 是否在镜像内可用 | ✅ node 24 自带 test runner | `Dockerfile:1,62` |
| 构建参数顺序 / 层 | ✅ 无明显错误；`dsh --help`、entrypoint/proxy self-test、测试 在同一 RUN，任一失败即构建失败 | `Dockerfile:43-63` |
| 版本默认值是否一致 | ✅ Dockerfile `ARG DSH_VERSION=0.2.1-rc.5`、compose 默认、`.env.example`、workflow 默认一致（旧版 rc.2/rc.5 错位已修正） | `Dockerfile:3`；`docker-compose.yml:25`；`.env.example:18`；workflow:9 |
| `.dockerignore` | ⚠️ 缺失（B-12） | 仓库根无 `.dockerignore` |
| 镜像元数据 | ⚠️ 无 version/revision label（B-18） | `Dockerfile:20-26` |

---

## 4. Compose 核查

- **YAML 合法**：用 js-yaml 解析通过，service 键为 image/build/container_name/restart/environment/ports/volumes/healthcheck/stop_grace_period/logging。
- **构建路由正确**：`context: ./runtime` + `dockerfile: deepseek-harness/Dockerfile`，与 Dockerfile 的 `deepseek-harness/...` COPY 前缀一致（B-12 的 context 体积问题另记）。
- **必填插值**：`${DSH_ACCESS_HOST:?...}` 会在 `up`/`config` 阶段硬失败——语义正确，但**与 `HTTPS_ACCESS_HOST` 兼容承诺矛盾**（B-2）。
- **端口**：`"127.0.0.1:${DSH_HTTP_PORT:-8080}:8080"`，只发布到宿主机回环，符合"外部反代同机"的默认场景；反代是容器时需改共享网络，README 已说明。
- **卷**：`${DSH_DATA_DIR:-./data/dsh}:/data/dsh`、`${WORKSPACE_DIR:-./workspace}:/workspace`；无 `/data/caddy`，与"删除 Caddy"一致。
- **healthcheck**：`interval 30s / timeout 5s / retries 3 / start_period 120s`，与入口最多 60s 的启动等待匹配；`CMD-SHELL` 使用 curl（镜像内有）。镜像自带的 30s start-period 被 compose 覆盖，见 B-5。
- **进程模型**：`restart: unless-stopped` + `stop_grace_period: 30s` 与 tini/入口脚本/wait -n 匹配。
- **image+build 语义**：见 B-4（P1）。当前默认 `image: deepseek-harness:plain` 无 registry 命名空间，`docker compose pull` 会对 Docker Hub 发起无效拉取。
- **日志轮转**：json-file 10m×3，合理。
- **未设 `user:`**：正确（入口需要 root 做 chown，然后 gosu 降权）；注释已写明。
- **compose 只转发显式 environment**：`environment` 里**只有 `DSH_ACCESS_HOST` 一项是启用的**，其余全部注释；这与 B-3/B-8 直接相关。下表给出完整映射。

### 4.1 变量映射（compose ↔ .env.example ↔ 镜像/入口）

| 变量 | compose | .env.example | 实际生效路径 | 结论 |
|---|---|---|---|---|
| `DSH_ACCESS_HOST` | 启用（必填） | 有 | compose env → entrypoint 校验/白名单/`--trusted-host` | ✅ |
| `DSH_VERSION` | build arg | 有 | Docker build ARG | ✅（但不进 tag，B-4） |
| `DSH_IMAGE` | image 名 | 有 | compose | ⚠️ B-4/B-16 |
| `DSH_HTTP_PORT` | ports 插值 | 有 | compose | ✅ |
| `DSH_DATA_DIR` / `WORKSPACE_DIR` | volumes 插值 | 有 | compose | ✅ |
| `PROXY_SHARED_SECRET` | **注释** | 有（注释示例） | 若注释放开则 entrypoint 的 `gosu env` 会继承 | ❌ B-3：默认不转发 |
| `PROXY_ACCESS_LOG` | **注释** | 有（注释示例） | 同上 | ❌ B-3（默认在代理里是开启，影响小） |
| `DSH_PERMISSION_MODE` / `DSH_TOOLS_MODE` / `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | **注释** | 有 | 需两处同时取消注释 | ⚠️ B-8：README 未写这个两步操作 |
| `DSH_HOME` / `DSH_TELEMETRY_DISABLED` | 不传 | 有（说明为镜像内置） | Dockerfile ENV + entrypoint env | ✅ |
| `ONEPANEL_DSH_AUTH_PROXY` | 不传（正确） | 有（说明写死） | entrypoint 写死 | ✅ |
| `PROXY_LISTEN_HOST/PORT/ALLOWED_HOSTS` | 不传 | 不列（README §3.2 有） | entrypoint 写死 | ✅ |

---

## 5. 测试质量与本地实测

### 5.1 实际结果（本机 node v24.22.2）

补充证据：旧版 `test-runtime.mjs` 本来就在 Docker build 中 `spawn` Caddy 并绑定 `127.0.0.1` 临时端口（`git show HEAD:deepseek-harness/test-runtime.mjs:54-100`），因此"构建期启动子进程 / 绑端口"不是本次新增的风险面；本次新增的是测试数量与墙钟断言。

命令与结果（完整命令见附录 A）：

1. `node --test --test-name-pattern='proxy|healthz' test-runtime.mjs`（`DSH_PROXY_BIN` 指向无扩展名 0755 副本）：**8 pass / 0 fail**，连续 3 次全部通过，每次约 4.6–4.7 s。
2. 完整 `node --test test-runtime.mjs`：**8 pass / 2 fail**。失败的是两个 PDF 用例（`test-runtime.mjs:27-51`），原因是本机安装的 DSH **没有**执行镜像构建期的 `patch-dsh-authenticated-settings.mjs`（该 patch 会注入 core-js Iterator polyfill）。这与任务说明一致："PDF tests intentionally need the image-time polyfill"。**镜像内是否通过未验证**（无 docker）。
3. `node ./node-proxy.mjs --self-test`、`/usr/local/bin` 等价 0755 副本直接执行、`bash docker-entrypoint.sh --self-test`：全部退出 0。
4. 现有 8 个用例与它们声称覆盖的能力：

| # | 用例 | 证明的能力 | 评价 |
|---|---|---|---|
| 1 | preserves Host/Origin, strips credentials, security headers | Host 原样、Origin 保留、Authorization 与 proxy secret 不落到后端、`nosniff`/`Referrer-Policy`、无 Server 头 | ✅ 与实现声明一致 |
| 2 | rejects unknown Host / HTTP1.0 no Host | 403 + 400，且被拒请求不转发 | ✅ |
| 3 | streams without buffering | 首 chunk 在 300ms 内到达（后端 400ms 后才 end） | ✅ 有效但墙钟断言有风险（B-10） |
| 4 | WS 101 + Host fence | upgrade 透传、Host 403 | ✅ 只测 `/api/remote.mux` |
| 5 | 502 when backend unreachable | 连接错误映射 502 | ✅ |
| 6 | optional shared secret | 403/403/200 | ✅ 只测 HTTP，未测 WS 路径 |
| 7 | healthz + SIGTERM exit 0 | 健康检查透到后端、SIGTERM 退出码 0 | ✅ 未测"后端宕机 → healthz 502"与"有活跃 WS 时 SIGTERM" |
| 8 | 4 MB body intact | 大请求体透传 | ✅ 未测 300 MiB |

### 5.2 缺失的高价值用例（建议补）

- SSE：`GET /plugins/events`（或任一 `text/event-stream`）连续多事件不被缓冲；当前只有 2 个 chunk 的普通响应。
- 300 MiB 级上传（README 承诺外部反代 `client_max_body_size 300m`；DSH 上限确认为 300 MiB，见附录 B）。
- SIGTERM 时有 1 个活跃 WebSocket + 1 个进行中的上传，验证 drain/超时退出与退出码。
- Host 归一化：`DSH.EXAMPLE.COM`、`dsh.example.com.`、`dsh.example.com:8443` 都应通过并原样转发；`127.0.0.1:3080` 应被白名单拒绝（当前只测 `attacker.invalid`）。
- `healthz` 在后端不可用时返回 502；`PROXY_SHARED_SECRET` 对 WS upgrade 的 403。
- 空闲 keep-alive 后首请求（对应 B-15 的 502 排障）。
- 错误响应（403/502/400）也带 `x-content-type-options`。
- `PROXY_ACCESS_LOG` 输出形态：JSON 行、path 不含 query、每个请求恰好一行。

### 5.3 不稳定因素

- `test-runtime.mjs:229` 固定 400ms、`:255` 断言 <300ms：在 QEMU 模拟的 arm64 构建或高负载 CI 上存在误报可能（本地未复现）。建议改成**事件序**断言（例如后端在发出第二段前记录时间戳，或断言"收到首 chunk 时后端尚未 end"），而不是墙钟阈值。
- `freePort()`（`:62-69`）close 到 proxy listen 之间有 TOCTOU；`startProxy`（`:129-134`）最多等 5s。概率低，但建议把端口分配改为"测试进程先绑定再传 fd"或允许重试。
- `startProxy` 的 `...process.env`（`:113-123`）会带进宿主 `PROXY_SHARED_SECRET` 等环境（B-17），建议显式置空。

---

## 6. 发布 / tag 建议（具体方案）

**前提结论：不能继续用 `1panel/deepseek-harness:<dshVersion>` + `:latest` 发布明文无认证变体。** 二选一：

**方案 A（推荐，彻底隔离）**
1. 新镜像仓库名：`1panel/deepseek-harness-plain`（或团队内部 registry 的独立 repo）。
2. 新 workflow 文件（例如 `deepseek-harness-plain-release.yml`），不要改动现有 HTTPS 流水线：
   - `env.IMAGE_NAME: 1panel/deepseek-harness-plain`
   - tags：`${{ inputs.dshVersion }}` + `latest`（或再加 `plain`）
   - **一次 build 打两个 tag**（替代现在两段 build），避免 `:latest` 与版本 tag digest 不一致；
   - 保留 `context: .`、`file: deepseek-harness/Dockerfile`、`build-args DSH_VERSION`；
   - 加 `labels: org.opencontainers.image.version=<dshVersion>, org.opencontainers.image.ref.name=plain`；
   - `pushLatest` 默认值按团队策略，**不建议默认 true**（除非明确接受 latest 换行为）。
3. 部署侧：`.env.example:21`、`README.md:118` 的 `DSH_IMAGE` 示例改成实际发布名；compose 默认 `image` 改为该名字（若仍保留 build，见 B-4 的修法）。

**方案 B（同仓库加后缀，改动小但仍有同仓库混淆风险）**
- tags：`1panel/deepseek-harness:<dshVersion>-plain` + `1panel/deepseek-harness:plain`；**绝不**在明文流水线里 push `:latest`。
- `:latest` 保持在现有 HTTPS 流水线，直到正式宣布迁移。
- 仍需一次性 build 打多 tag，并更新 `runtime/README{,_zh}.md` 说明两个变体的 tag 规则。

**配套（无论 A/B）**
- 发布说明里写清：端口 8443→8080、认证/TLS 移除、`/data/caddy` 不再使用、必须由外部反代提供认证+TLS。
- 把构建期测试拆成"amd64 原生 job"（快且稳），镜像 build 阶段只保留 `--self-test` 等快速校验；或至少把 §5.3 的墙钟断言改成事件序，否则多架构发布可能偶发红。
- 若要减少"旧 tag 被覆盖"的风险，给新 workflow 加 `concurrency` 和 tag 存在性检查（`docker manifest inspect` 已存在则失败），避免同名 tag 被重复推送。
- 不要用 `:latest` 表达"最新版"同时承载两种安全模型；这是本次最需要避免的。

---

## 7. 修复清单（按顺序；本次不实施）

1. **[P0] 改发布出口**：新建 plain 专用 workflow/镜像名或 `-plain` tag 方案；明文流水线**不覆盖** `:latest`；保留现有 HTTPS 镜像 tag。同步更新 `runtime/README{,_zh}.md` 的 tag 说明、`.env.example:21`、`README.md:118`。
2. **[P1] compose 的 access host 兼容**：把 `docker-compose.yml:34` 改成
   `DSH_ACCESS_HOST: ${DSH_ACCESS_HOST:-${HTTPS_ACCESS_HOST:-}}`，并在 entrypoint 里对"仅设置 HTTPS_ACCESS_HOST"打印一条 deprecation 提示；或者明确删除"旧名兼容"文档承诺（二选一，不要两者都保留）。
3. **[P1] 显式转发安全/日志变量**：在 `docker-compose.yml` 的 `environment:` 中取消注释
   `PROXY_SHARED_SECRET: ${PROXY_SHARED_SECRET:-}`、`PROXY_ACCESS_LOG: ${PROXY_ACCESS_LOG:-1}`（空 secret = 关闭，语义不变）；在 `README.md` §3.3 补一句"compose 只转发这里列出的变量，`.env` 里设置后还需在 compose 取消同名注释"。
4. **[P1] 处理 image+build**：三选一——(a) 删除 `image:`，让 compose 生成默认名；(b) 删除 `build:`，只允许 `DSH_IMAGE` 拉取（另提供 `docker-compose.build.yml` override）；(c) 保留两者但加 `pull_policy: build`（要求 Compose 版本支持），并加 `--build` 说明。无论哪种，tag 要包含 `DSH_VERSION` 或 `-plain` 后缀，避免不同版本互相覆盖。
5. **[P2] 文档对齐**：
   - `README.md:82` 删除"会提示改用 DSH_ACCESS_HOST"或给 entrypoint 加提示；
   - `README.md:193` 把"130 行"改成实际行数；
   - `README.md` §3.3/§3.4 补"compose 转发"说明（或直接采用第 3 条的显式空默认写法，从根上消除两步操作）；
   - `README.md:172` 的 502 归因改成"未验证的可能原因"，先补测试再定论。
6. **[P2] 镜像 healthcheck**：把 `Dockerfile:72` 的 `--start-period=30s` 提到 ≥90s（与入口 60s 等待匹配）；或明确文档只支持 compose 场景。
7. **[P2] curl 探测加 `--noproxy '*'`**：`Dockerfile:72-73` 与 `docker-entrypoint.sh:66` 两处；同时可考虑在 entrypoint 里对 `NO_PROXY` 补 `127.0.0.1,localhost`。
8. **[P2] 补测试**：§5.2 的 SSE、300 MiB、SIGTERM+活跃 WS、Host 归一化、healthz 后端宕机、空闲 keep-alive、错误响应安全头、WS 共享密钥；`startProxy` 显式清空 `PROXY_SHARED_SECRET`。
9. **[P2] 降时序测试风险**：`test-runtime.mjs:229/255` 改事件序断言；`freePort` 加重试或改为继承 fd；发布流水线把测试放到 amd64 原生 job（或构建阶段跳过墙钟用例）。
10. **[P2] 构建上下文卫生**：仓库根加 `.dockerignore`（至少 `.git`、`**/.git`、`data/`、`workspace/`、其他镜像目录中与 dsh 无关的部分）；若 deployment 目录要独立发布，给 `runtime/` 加 submodule/发布说明，或让 compose 默认改用已发布镜像。
11. **[P2] 版本元数据**：最终阶段 `ARG DSH_VERSION` + `org.opencontainers.image.version` 标签；发布流水线传入同一值，避免来源漂移。
12. **[P3] 显式 ESM**：把 `/usr/local/bin/dsh-node-proxy` 改成 `.mjs`（或要求 `node --experimental-detect-module`/`package.json type`），使"无扩展名 + export"不再依赖 Node 24 的探测行为；同时在 README 记录该依赖。

---

## 8. 未验证项（明确标记）

| 项 | 状态 | 原因 |
|---|---|---|
| 镜像实际构建成功 / COPY 后权限 / HEALTHCHECK 实际状态 | **未验证** | 本机无 docker，无法 build/run |
| 镜像内 `node --test` 全绿（尤其 2 个 PDF 用例） | **未验证** | 需要镜像构建期 patch；本地未打 patch，2 个 PDF 用例失败（预期） |
| `dsh --help`、entrypoint self-test、proxy self-test 在最终镜像层中的实际执行 | **未验证**（本机等价命令均已执行通过） | 无 docker |
| compose 的 pull-first 行为、`DSH_IMAGE` 实际拉取/构建路径 | **未验证**（依据 Compose 官方文档推断） | 无 docker |
| `gosu node env ...` 在 root 下继承 `PROXY_SHARED_SECRET/PROXY_ACCESS_LOG` | **未验证**（按 `env` 语义应为继承） | 本机为 node 用户，无法执行 gosu |
| arm64/QEMU 下构建期测试的时序稳定性 | **未验证** | 本机 amd64，未做模拟 |
| README 声称的"settings 端点原样透传实测 200" | 采用既有 `reports/node-proxy-feasibility.md` 的结论，**本次未复测** | 功能测试属于 lead/其他评审范围 |
| deployment 目录的最终发布形态（是否作为 git 仓库、runtime 如何分发） | **未验证** | 当前 deployment 目录不是 git 仓库 |
| 偶发 502 的根因（README:172） | **未验证** | 无真实 DSH 长连接复现 |

---

## 附录 A：本次实际执行的命令与结果

```bash
# 1) 本机环境
node --version                 # v24.22.2
bash --version                 # 5.2.37(1)-release
command -v docker              # 空（无 docker）

# 2) self-test（代理与入口）
node runtime/deepseek-harness/node-proxy.mjs --self-test            # exit 0
cp node-proxy.mjs /workspace/.../.work/review-build/dsh-node-proxy && chmod 0755 \
  && .work/review-build/dsh-node-proxy --self-test                  # exit 0（直接 shebang 执行）
bash runtime/deepseek-harness/docker-entrypoint.sh --self-test      # exit 0
# 说明：工作区原文件 0600 直接执行会 permission denied；/tmp 是 noexec，复制到 /tmp 执行会 exit 126，
#       这些是本机权限/挂载属性，不是镜像内问题。

# 3) 代理测试（用无扩展名 0755 副本模拟 /usr/local/bin/dsh-node-proxy）
DSH_PROXY_BIN=/workspace/.../.work/review-build/dsh-node-proxy \
  node --test --test-name-pattern='proxy|healthz' runtime/deepseek-harness/test-runtime.mjs
# → 8 pass / 0 fail；连续 3 次通过（每次约 4.6–4.7 s）

# 4) 完整套件（PDF 用例需要镜像构建期 polyfill）
DSH_PROXY_BIN=/workspace/.../.work/review-build/dsh-node-proxy \
  node --test runtime/deepseek-harness/test-runtime.mjs
# → 8 pass / 2 fail：两个 PDF 用例失败（本机 DSH 未打镜像 patch，预期）

# 5) compose / workflow YAML 解析（本机用 DSH 自带的 js-yaml）
node -e 'const req=require("module").createRequire("/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json"); ...'
# → docker-compose.yml OK；workflow HEAD 版本 OK

# 6) curl 代理环境变量行为（支撑 B-14）
#    大写 HTTP_PROXY 不生效（200），小写 http_proxy / ALL_PROXY 生效（连接失败）→ curl 8.14.1 实测
```

## 附录 B：本报告用到的 DSH 源码佐证（/usr/local/lib/node_modules/@deepseek-ai/dsh）

| 事实 | 证据 |
|---|---|
| `--trusted-host` 的**无端口条目匹配任意端口**；Host 与 Origin 同源比较按 URL 语义 | `node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:196-207,240-268` |
| DSH 的请求体上限默认 **300 MiB**，超过返回 413 | 同文件 `:30,40,57,68,1018` |
| DSH 自身带 gzip 压缩中间件（排除 SSE/部分 multipart），因此 Caddy 的 `encode zstd gzip` 只损失 zstd，不是全部压缩 | `node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:197-225,264-265` |
| DSH 不读 `X-Forwarded-*`（外部反代是否设置不影响功能） | 在 `dsh-host-webserver`/`dsh-client-connection`/`lib` 中 grep 无结果 |
| `/api/remote.mux` 的 WS 升级也走 `admitConnection → isTrustedRequest` Host/Origin 栅栏 | `node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js:800-830`；`dsh-client-connection/lib/index.js:737,779` |
| 认证补丁仍是必需（无 patch → `GET /` 401） | `patch-dsh-authenticated-settings.mjs:33-38`；`reports/node-proxy-feasibility.md` |
| Compose 同时存在 build+image 时的 pull/build 规则 | <https://docs.docker.com/reference/compose-file/build/#using-build-and-image>；<https://docs.docker.com/reference/compose-file/services/#pull_policy> |

> 说明：report 中"评审时修订"的行号以 `node-proxy.mjs` 321 行修订为基准；该文件在评审结束后若继续变化，请以最终提交版本复核，但构建侧 P0/P1 结论与代理内部实现无关。
