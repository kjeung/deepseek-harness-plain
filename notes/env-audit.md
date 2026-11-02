# DSH 0.2.1-rc.5 应用层环境变量审计

审计对象：`/usr/local/lib/node_modules/@deepseek-ai/dsh`（`package.json` version = `0.2.1-rc.5`，`node lib/bin.js --version` 输出 `0.2.1-rc.5`）。
方法：只读扫描该包 `lib/*.js`、`node_modules/@deepseek-ai/*/lib/*.js`、各 bundle 的 `cordis.patch.yml`、`node_modules/dshmarket`；覆盖三种读取方式——`process.env.X`、`process.env[...]`、以及 YAML `!!js` 表达式中的 `process.env.X`，并跟踪 `launchEnvironmentOf()` / `ctx.credentials` 的动态读取。默认值一律按代码（或随包 YAML 补丁）实际计算值给出，不按文档猜测。

## 结论（先看这 5 条）

1. `dsh web` 真正会读取并产生效果的 `DSH_*` 只有 7 个：`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED`、`DSH_TELEMETRY_MODE`、`DSH_TELEMETRY_OTLP_URL`、`DSH_PERMISSION_MODE`、`DSH_TOOLS_MODE`。其中镜像默认已覆盖 `DSH_HOME=/data/dsh`、`DSH_TELEMETRY_DISABLED=1`。
2. `DSH_WEB_SEARCH_PROVIDER` / `DSH_WEB_FETCH_PROVIDER` 名义上是运维覆盖，但**默认 web profile 里被 bundle 配置写死，compose 里设置无效**；`DSH_WEB_URL` 是 DSH **输出**给模型 shell 的变量，不是输入，设置无效；`DSH_GITHUB_TOKEN` 只被第三方插件 `dshmarket` 使用（随包默认 web profile 未挂载它；镜像是否预置了自定义 profile 未验证），**不能**让 Agent 访问私有仓库。
3. 名字带 `__` 的 `DSH_BOOT__` / `DSH_TRANSPORT__` / `DSH_REMOTE_ACCESS__` / `DSH_CONNECTION_RECOVERY__` / `DSH_CODE_ICON_INSTANCE__` **根本不是环境变量**：前四个是浏览器端 `globalThis`/`window` 注入键（实际拼写带前导双下划线，如 `__DSH_BOOT__`），最后一个是前端打包产物里的 SVG id 前缀常量。设置成 env 无任何效果。
4. **Provider API Key 由 DSH 自己读取，不只是 vendored SDK**：请求路径经 `ctx.credentials` 解析 provider 路由的 `apiKeyEnv` 引用，回退层是“启动环境 → `$cwd/.env` → `$DSH_HOME/.env`”。但 `$DSH_HOME/.credentials.yaml`（Web UI Models 页写入）优先级最高，**UI 保存过就覆盖环境变量**。因此 compose 里设 `DEEPSEEK_API_KEY` 等是有效但非首选的做法。
5. 所有 `DSH_*` 都是 bootstrap-only：**不能**写进 `.env` 文件（项目或 `$DSH_HOME/.env`），只能来自容器 `environment:`（或启动进程的 shell 环境）；普通变量（包括 provider API Key）可以放 `.env`，但 `HOME`/`PATH`/`DEEPSEEK_BASE_URL`/`DEEPSEEK_SEARCH_BASE_URL`/`SSL_CERT_FILE`/`HTTP(S)_PROXY` 等也属 bootstrap-only（其中代理四件套在 `$DSH_HOME/.env` 有例外）。

## 一、用户可设、且在本镜像的 `dsh web` 中真实生效

| 变量名 | 作用 | 默认值（代码实际计算） | 示例值 | 是否建议在 compose 中设置 |
|---|---|---|---|---|
| `DSH_HOME` | Harness 用户数据根：`profiles/`、`.credentials.yaml`、sessions、`logs/`、`attachments/`、`cordis.patch.yml`、`.env`、匿名用户 id 全在此。派生显示为 `$DSH_HOME`。 | 未设置时 `join(homedir(), ".dsh")`，即 `$HOME/.dsh`；本镜像 `HOME=/data/dsh/home` 时为 `/data/dsh/home/.dsh`。空白/纯空白视为未设置。镜像已显式设 `/data/dsh`。 | `/data/dsh` | **保持镜像值**（不要覆盖）。若必须改，必须把新路径挂成持久卷，否则会话/凭据/配置全丢。 |
| `DSH_AGENTS_HOME` | 跨 Agent 工具的共享配置根：`$DSH_AGENTS_HOME/AGENTS.md` 指令与 `<agentsHome>/skills` 技能目录。 | 未设置时 `join(homedir(), ".agents")` → 本镜像 `/data/dsh/home/.agents`（在 `/data/dsh` 卷内）。空白视为未设置。 | `/data/dsh/home/.agents` | 可选。默认值已随 `/data/dsh` 持久化，一般不用设。 |
| `DSH_PERMISSION_MODE` | 部署级文件沙箱模式，作为新会话默认（会话内可再覆盖）；同时决定审批策略：仅 `danger-full-access` 时审批为 `never`，其余为 `ask`。 | 随包 YAML 显式写 `workspace-write`（`dsh-base/cordis.patch.yml:246`）。注意插件 schema 自身默认是 `read-only`，但 web profile 被补丁成 `workspace-write`。 | `workspace-write` / `read-only` / `danger-full-access` | 可选，默认 `workspace-write` 适合 compose；`danger-full-access` 等于容器内不再限制，勿用。非法值会在启动时被 schema union 拒绝。 |
| `DSH_TOOLS_MODE` | 整个进程的工具协议：`native` 原生工具 schema，`ptc` 走 PTC 模式。 | YAML 表达式为 `process.env.DSH_TOOLS_MODE`；未设时 `undefined`，插件 schema 默认 `native`。 | `native` | 不建议设置（保持 native）。 |
| `DSH_TELEMETRY_DISABLED` | 遥测总开关：**任意非空值**都禁用 `session-telemetry-otel` 这一行（包括 `0`、`false`），这是“宁可误关”的隐私开关。 | 未设置 = 不关闭（遥测按 `FEEDBACK_ONLY` 模式存在）。镜像已设 `1`。 | `1` | 建议保持关闭（镜像已设 1；显式写 `1` 更清楚）。写 `0` 仍是关闭。 |
| `DSH_TELEMETRY_MODE` | 遥测会话共享模式。 | `FEEDBACK_ONLY`（YAML 用逻辑或，空串也回退到此）。 | `DISABLED` | 不建议。`DSH_TELEMETRY_DISABLED` 非空时整行被禁用，此变量无意义。 |
| `DSH_TELEMETRY_OTLP_URL` | 遥测 OTLP/HTTP 上报端点。 | `https://dsh-otel-collector.deepseeksvc.com/v1/logs`。 | `https://otel.example.com/v1/logs` | 不建议（本镜像已禁用遥测）。仅当自建 collector 且未禁用遥测时才有意义。 |

## 二、容易误用：名字是 DSH_ 但 compose 里设了无效/不该设

| 变量名 | 作用 | 默认值 | 示例值 | 是否建议在 compose 中设置 |
|---|---|---|---|---|
| `DSH_WEB_SEARCH_PROVIDER` | 名义上选择 web 搜索 provider，代码等价于配置字段 `searchProvider`，**但取值为 `config.searchProvider ?? env`，配置优先**。 | 未设置；且随包 `web` 行已写死 `searchProvider: deepseek-official`，`process.env` 虽在构造时被读取，但永远不会参与选择。 | `deepseek-search-api` | 不建议（设了不生效）。切换请用 Web 设置页（会改 profile 配置），或在自定义 profile 中覆盖该行配置。 |
| `DSH_WEB_FETCH_PROVIDER` | 同上，对应 `fetchProvider`。 | 未设置；`web` 行写死 `fetchProvider: http`，env 不生效。 | `deepseek-fetch-api` | 不建议（设了不生效）。 |
| `DSH_WEB_URL` | **输出变量**：DSH 每次模型 shell 调用时注入到子环境，告诉 Agent 本 GUI 的对外 URL。不是输入配置。 | 无输入默认；值由 `--public-url` 或监听地址推导（`appRootUrl()`）。 | `https://dsh.example.com` | 不要设（设了无效）。要改对外 URL 用 `dsh web --public-url`。 |
| `DSH_GITHUB_TOKEN` | 仅第三方插件 `dshmarket` 的 “备份到私有 Gist” 功能读取；优先级为 会话内输入 token → `DSH_GITHUB_TOKEN` → `gh auth token`。 | 未设置（无 token 时回退 `gh auth token`，再失败报错）。 | `ghp_xxx` | **不要设**。它不会被 git 使用，**不能**为 Agent 提供私有仓库访问；且随包默认 web profile 未挂载 `dshmarket`。私有仓库请用挂载 git 凭据/SSH key 或 `gh auth`。 |
| `DSH_SPEECH_TOKEN` | 语音识别 worker 子进程的一次性 bearer secret：由 DSH 主机侧 `randomBytes(32).toString("hex")` 生成并经 `env` 传给子进程，子进程读到后立即 `delete`。 | 无（每次启动随机）。 | — | 不要设。实验性 voice-input bundle 默认未挂载，且该值由 DSH 自己生成，外部设置只会被覆盖/无意义。 |
| `DSH_BUNDLED_SKILL_DIR` | 内置（bundled）技能目录覆盖，打包运行时/SDK 场景用。仅在 `includeDefaultRoots` 且配置未给 `bundledSkillDir` 时读取。 | 未设置（未设置则无 bundled 根）。 | `/opt/dsh/skills` | 不建议。属于发行打包内部约定，不是用户目录（用户技能放 `$DSH_HOME`/`$DSH_AGENTS_HOME` 下）。 |
| `DSH_MARKET_INSTALL_TIMEOUT_MS` / `DSH_MARKET_HOT_MOUNT_TIMEOUT_MS` | 第三方插件 `dshmarket` 的安装超时（15 分钟）与热挂载超时（10 秒）。 | 未设置时 900000 / 10000。 | `600000` | 不适用（随包默认 web profile 未挂载 dshmarket；它不是 `@deepseek-ai/dsh` 的依赖）。 |
| `DSH_CLIENT_VERSION` / `DSH_PRODUCT_ANALYTICS_OTLP_URL` | 仅 desktop profile 的两行（product telemetry / product-analytics）引用的 `!!js` 表达式，这两行在非 `desktop` profile 下 `disabled: true`。 | 未设置 | — | 不适用（web profile 下这些行被禁用，设了也不读）。 |

## 三、内部 IPC / 标记变量（禁止在 compose 中设置）

这些名字确实是环境变量，但由 DSH 自己管理；`dsh web` 的模型 shell 每次执行都会**丢弃环境里的 `DSH_*`** 再注入自己的快照，所以外部设置既无效也可能干扰内部识别：

| 变量名 | 归属/用途 | 默认值 | 示例 | 建议 |
|---|---|---|---|---|
| `DSH_SHELL`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR` | `dsh-shell-env` 每执行一次 shell 时注入的“事实变量”（`shell-env/lib/index.js:19-37, 86-95`）。 | DSH 计算（`DSH_SHELL=1`、当前 profile 名/目录、会话 id）。 | — | 禁止设置（会被丢弃/覆盖）。 |
| `DSH_PTY_SESSION_ID` | `dsh-terminal-bash` 给终端子进程的会话标记。 | DSH 计算 | — | 禁止设置。 |
| `DSH_SUBPROCESS_CONTROL` / `DSH_SUBPROCESS_RUNNER` | 子进程控制协议标记（值如 `pipe`、runner 入口标识）。 | DSH 内部写入 | — | 禁止设置。 |
| `DSH_PTC_RUNTIME_NODE` | PTC Node 运行时的内部标记（`= "1"`）。 | 未设置 | — | 禁止设置。 |
| `DSH_DIALOG_TITLE` | 原生目录选择器子进程的对话框标题。 | DSH 内部写入 | — | 禁止设置。 |

补充：`dsh-subprocess` 的 `scrubbedParentEnv()` 会把父环境里所有 `DSH_*` 和 key/secret/token/password 形态的变量**从子进程环境剔除**（`dsh-subprocess/lib/index.js:35-56`）。所以 compose 里设的 provider key、`DSH_*` 不会泄漏给模型执行的 bash/git 子进程；反过来也意味着**不要指望通过 `DSH_*` 给 Agent 的 shell 传参**。

## 四、名字像环境变量、其实不是（设置完全无效）

| 名称 | 真实身份 | 证据 | 建议 |
|---|---|---|---|
| `__DSH_BOOT__`（也写作 `DSH_BOOT__`） | 浏览器端 `window.__DSH_BOOT__`，由 Host 以 `<script>` 类型 `kind:"global"` 注入的启动插件图。 | `dsh-client-modules/lib/index.js:499-503`（`name: "__DSH_BOOT__"`，`kind: "global"`） | 不要当作 env。 |
| `__DSH_BOOT_READY__` | 服务端注入 HTML 的就绪 deferred。 | `dsh-host-webserver/lib/index.js:70`（`globalThis.__DSH_BOOT_READY__ ??= ...`） | 非 env。 |
| `__DSH_TRANSPORT__` | 浏览器全局传输配置（stream base URL 等）。 | `dsh-api-gateway/lib/client.browser.js:761`、`dsh-client-connection/lib/client.browser.js:1506` | 非 env。 |
| `__DSH_CONNECTION_RECOVERY__` | 浏览器全局重连配置。 | `dsh-client-connection/lib/index.js:1040`、`client.browser.js:1509` | 非 env。 |
| `__DSH_REMOTE_ACCESS__` | 浏览器全局 remote-access 快照。 | `dsh-api-remote-access/lib/index.js:9` | 非 env。 |
| `__DSH_CODE_ICON_INSTANCE__` | 前端打包产物里的常量，仅用作内联 SVG 的 `id` 前缀（`const ... = "__DSH_CODE_ICON_INSTANCE__"`）。 | 全包 grep 只命中 `dsh-web-frontend/dist/assets/index-BXV-oxvX.js`，无任何 `process.env` 读取 | 非 env。 |

## 五、Provider API Key 裁决（权威结论）

**结论：DSH 自己会读 provider API Key，不是“只有 vendored SDK 才读、对部署无意义”。** 但优先级和语义要分清：

1. **DSH 请求路径确实经自己的凭据服务解析。**
   - DeepSeek 官方路由：`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`（`dsh-llm-deepseek-api-key/lib/index.js:12`）；`resolveApiKey` 先 `ctx.credentials.resolve(ref)`，没有 credentials 服务才直接读 launch environment（同文件 `:56-67`）。错误信息明确写着 “store it through the credentials service … or export it in the launching environment”。
   - 第三方路由（Models 页添加的 pi-ai provider）：`resolveApiKey` 同样经 `ctx.credentials.resolve(ref)` 解析（credentials 服务内部再回退到环境）；只有在没有 credentials 服务时才直接 `launchEnvironmentOf(ctx).get(ref)`（`dsh-llm-pi-ai/lib/index.js:2890-2899`）。provider 目录里的 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`AZURE_OPENAI_API_KEY`/`GEMINI_API_KEY`/`AWS_*` 等是 catalog 的“环境名元数据”（同文件 `:2599-2601` 注释：catalog endpoints and environment names; no credentials are evaluated at runtime）；对指定了 `apiKeyEnv` 的路由，值由该引用解析，未指定时见下面第 4 点。
   - Web 搜索 / Web fetch 的 DeepSeek provider 也走同一凭据：`dsh-web-deepseek-api/lib/index.js:15-30`、`dsh-web-search-deepseek/lib/index.js:279`（默认 `DEEPSEEK_API_KEY`）。
2. **回退顺序（代码实测）：** `$DSH_HOME/.credentials.yaml` → 继承的进程环境（compose 的 `environment:`）→ `<启动 cwd>/.env` → `$DSH_HOME/.env`。见 `dsh-credentials-local/lib/index.js:13-27`（优先级注释）、`:431-446`（`inherited`/`dotenvFallback`）、`:480-496`（`resolve`）。因此**Web UI Models 页保存过 key 后，环境变量就被文件覆盖**；反之只用环境变量也能工作。
3. **UI 也把环境变量当作一等回退**：Models 页文案 “Saved credentials are used first. Environment fallbacks shown here, in order: {env}. Sources are launch environment, $cwd/.env, then $DSH_HOME/.env.” 并提示 “Env var not detected. Enter an API key, or configure {hint} in your env.”（`dsh-client-ui-settings-models/lib/client.js:3273` 附近）。
4. **vendored SDK 的 ambient discovery 是另一条路径，不是主线**：对未指定 `apiKeyEnv` 的 pi-ai 目录路由，适配器保留 provider 自带的 auth（`dsh-llm-pi-ai/lib/index.js:881-899` 的注释说明“provider-native ambient discovery”），此时由 `@earendil-works/pi-ai` 自己读 `AWS_PROFILE`/`GOOGLE_APPLICATION_CREDENTIALS` 等。对 DSH 核心 DeepSeek 路由不适用。
5. **安全边界**：provider key 只被 DSH 服务器进程使用；`scrubbedParentEnv()` 不把 key 形态变量转发给模型 shell 子进程（`dsh-subprocess/lib/index.js:35-56`）。所以在 compose 里给 key 不会泄漏给 Agent 执行的命令，但也意味着不能用这种方式给 git 提供凭据。
6. **部署建议（二选一，不要双写）**：
   - 首选：首次登录后在 **Settings → Models** 填 key（写入 `/data/dsh/.credentials.yaml`，文件权限必须 `0600`；权限过宽会被拒绝启动，`dsh-credentials-local/lib/index.js:92-105`）。
   - 或者：在 compose 的 `environment:` 里写 `DEEPSEEK_API_KEY`（以及你实际使用 provider 对应的名字，如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`）。注意它低于 UI 保存值；且 `.env` 文件不能放 `DSH_*`，但可以放 provider key（会进 `<cwd>/.env` 或 `$DSH_HOME/.env` 回退层）。
   - 不建议把长期 key 写进 compose 文件/`.env.example`：容器环境变量对同主机 root 可见，rotate 也麻烦。

## 六、与部署相关、但不是 DSH_ 前缀的变量

| 变量名 | 作用 | 默认值 | 是否建议设置 |
|---|---|---|---|
| `HOME` | 决定 `DSH_HOME`/`DSH_AGENTS_HOME` 的默认 `homedir()`。 | 镜像 `HOME=/data/dsh/home`。 | 保持镜像值。改了它但没设 `DSH_HOME`，数据目录会跟着变。 |
| `DEEPSEEK_BASE_URL` | DeepSeek 官方对话 Messages 端点根（`dsh-llm-deepseek/lib/index.js:349,441`）。 | `https://api.deepseek.com/anthropic`。 | 可选。接私有网关时设置；bootstrap-only，**不能**写 `.env`。 |
| `DEEPSEEK_SEARCH_BASE_URL` | DeepSeek 搜索的 Messages 端点（与对话端点独立，`dsh-web-search-deepseek/lib/index.js:290,319`）。 | `https://api.deepseek.com/anthropic/v1`。 | 可选；同 bootstrap-only。 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（小写同名也识别） | 出站代理；profile 启动时 `installProxyFromEnvironment(options.environment, …)` 统一安装，供模型 API、web fetch、子进程复用；loopback 自动绕过。 | 未设置=直连。 | 可选；容器出网需代理时设置。这些属 bootstrap-only，但 `$DSH_HOME/.env` 对代理四件套有例外（`dsh-app-boot/lib/index.js:3675-3684`），可写在 home `.env`；其余 bootstrap 变量不行。SOCKS 代理不支持。 |

## 七、证据索引（file:line）

以下路径除特别注明外，均相对于 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`；`lib/...` 相对于本包根 `/usr/local/lib/node_modules/@deepseek-ai/dsh/`，`dshmarket/...` 相对于 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/`。

- 版本：`/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json`（`"version": "0.2.1-rc.5"`）；`dsh --version` 实测 `0.2.1-rc.5`。
- 家目录与优先级：`dsh-home-paths/lib/index.js:15`（`DSH_HOME` 常量）、`:55-57`（默认 `~/.dsh`）、`:83-86`（空白视为未设置、`resolve`/`~` 展开）、`:109-111`（显式配置 > `$DSH_HOME` > 默认）；`:21`、`:62-64`、`:124-126`（`DSH_AGENTS_HOME`）。消费者：`dsh-agent-instructions/lib/index.js:80,490`、`dsh-skill-filesystem/lib/index.js:77,176`。
- bootstrap-only：`dsh-app-boot/lib/index.js:3610-3666`（`DSH_` 前缀禁止来自 `.env`）、`:3675-3684`（home `.env` 的代理例外）、`:3736-3760`（`loadLayeredEnv`：继承环境 > 项目 `.env` > home `.env`）。
- 遥测：`lib/profile-boot-C14i-8IN.js:300`（读取 `DSH_TELEMETRY_DISABLED`）；`dsh-app-boot/lib/index.js:1093,1105-1110`（`resolveTelemetryPatch`：任意非空即硬禁用该行）；`dsh-base/cordis.patch.yml:205-226`（说明 + 行配置，`DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL`）；`dsh-session-telemetry-otel/lib/index.js:16-26,68`（模式枚举 `FEEDBACK_ONLY`/`DISABLED`）。
- 权限/工具：`dsh-base/cordis.patch.yml:240-250`（`DSH_PERMISSION_MODE ?? 'workspace-write'`）、`:262`（审批策略）；`dsh-sandbox-policy/lib/index.js:26-30,97-104`（三值 + schema 默认 `read-only`）；`dsh-web-app/cordis.patch.yml:34-38`（`DSH_TOOLS_MODE`）、`dsh-tools/lib/index.js:2763`（`native`/`ptc`，默认 `native`）。
- Web：`dsh-web/lib/index.js:44-51,59-60,100,115`（`DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` 为 `config ?? env`）；`dsh-base/cordis.patch.yml:467-471`（写死 `searchProvider: deepseek-official`、`fetchProvider: http`）；`dsh-web-app/lib/index.js:37,146,152-153`（`DSH_WEB_URL` 仅 `shellEnv` 输出）；`dsh-web-app/cordis.patch.yml:183-184,203`（host 默认 `127.0.0.1`、port 默认 `3080`、`publicUrl` 来自 `--public-url`，**没有任何端口/host 的 env 回退**，只有 CLI flag）。
- 代理：`lib/profile-boot-C14i-8IN.js:256`（`installProxyFromEnvironment`）；`dsh-http-proxy/lib/index.js:29-43,60-76`（`http_proxy`/`HTTP_PROXY` 等大小写、空白视为未设置、SOCKS 拒绝）；`dsh-subprocess/lib/index.js:50-56`（子进程继承解析后的代理、剔除 `DSH_*` 与敏感名）。
- 内部标记：`dsh-shell-env/lib/index.js:19-37,86-95`（ambient `DSH_*` 被丢弃、重新注入）；`dsh-terminal-bash/lib/index.js:942-944`；`dsh-subprocess/lib/index.js:13`；`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:1301`；`dsh-ptc-runtime-node/lib/index.js:1618`；`dsh-host-directory-picker-native/lib/index.js:74-78`。
- 全局键（非 env）：`dsh-client-modules/lib/index.js:499-503`；`dsh-host-webserver/lib/index.js:70`；`dsh-client-connection/lib/index.js:1040`；`dsh-api-remote-access/lib/index.js:9`；`dsh-api-gateway/lib/client.browser.js:761`；`dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（仅此处出现 `__DSH_CODE_ICON_INSTANCE__`）。
- 语音 token：`dsh-experimental-speech-to-text-sensevoice/lib/index.js:778,782-786`（生成并传 env）；`worker.js:225-239`（读取后删除）；实验 bundle 不在默认 web profile（`dsh-app-boot/lib/index.js:551-557` 的 `PROFILE_TEMPLATES.web` 仅 `dsh-base` + `dsh-web-app`，`:583+` 的 `OPTIONAL_BUNDLES` 才含 voice-input）。
- Gist token：`dshmarket/lib/gist.js:33,86-104`；`dshmarket/package.json`（第三方包，`name: "dshmarket"`，version 1.66.9）；它只由自身的 `dshmarket/cordis.patch.yml:1-4` 声明挂载，`@deepseek-ai/dsh` 的 `package.json` 依赖中**没有** dshmarket；随包默认 web profile 模板只有 `dsh-base` + `dsh-web-app`（`dsh-app-boot/lib/index.js:551-557`），不含它。**未验证**：镜像若在 `/data/dsh` 预置了自定义 profile，则实际挂载列表可能不同（属 image-verify 范围）。
- 凭据：`dsh-base/cordis.patch.yml:112-126`（credential 说明 + `credentials` 行 `@deepseek-ai/dsh-credentials-local`）、`:522-529`（`llm-deepseek`/`llm-deepseek-account`）；`dsh-llm-deepseek-api-key/lib/index.js:12,56-67`；`dsh-llm-pi-ai/lib/index.js:2599-2601,2890-2899`；`dsh-web-deepseek-api/lib/index.js:15-30,159,354`；`dsh-web-search-deepseek/lib/index.js:279,319`；`dsh-credentials-local/lib/index.js:13-27,92-105,431-446,480-496`；`dsh-launch-environment/lib/index.js:30-54,63-68`；`dsh-client-ui-settings-models/lib/client.js:3268-3273`（UI 环境回退文案）。
- 非 DSH 应用变量：`DSH_AUTH_USERNAME`/`DSH_AUTH_PASSWORD`/`HTTPS_ACCESS_HOST` 在 DSH 包源码中**无任何引用**（应用层不读取；由镜像 entrypoint/Caddy 使用，见 `notes/image-verify.md`）。

## 八、给 compose 配置的最小建议

```yaml
environment:
  # 保持镜像默认即可，以下仅作显式记录：
  DSH_HOME: /data/dsh                 # 必须落在持久卷上
  DSH_TELEMETRY_DISABLED: "1"         # 任意非空值均关闭
  # 可选：
  # DSH_PERMISSION_MODE: workspace-write
  # DSH_AGENTS_HOME: /data/dsh/home/.agents
  # DeepSeek 官方 key（也可在 Web UI Models 页填，UI 值优先）：
  # DEEPSEEK_API_KEY: sk-...
# 不要设置：DSH_WEB_URL、DSH_WEB_SEARCH_PROVIDER、DSH_WEB_FETCH_PROVIDER、DSH_GITHUB_TOKEN、
#           DSH_SPEECH_TOKEN、DSH_BUNDLED_SKILL_DIR、任何 DSH_*__ 标记。
```
