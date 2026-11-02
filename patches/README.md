# 明文 HTTP 改造补丁（相对上游 `1Panel-dev/runtime`）

本目录是把 **Caddy/HTTPS 版** DeepSeek Harness 镜像改成 **Node 转发 + 明文 HTTP（无登录、无 TLS）**
所必需的全部改动。`runtime/` 只是上游仓库的克隆（且在 `.gitignore` 里），**新机器直接 clone 上游不会得到这些改动**。

## 内容

| 文件 | 说明 |
|---|---|
| `0001-feat-deepseek-harness-replace-Caddy-with-plain-HTTP-.patch` | 单个 `git format-patch` 补丁，含 10 个文件、1030 增 / 186 删（Caddyfile 删除、node-proxy.mjs 新增等） |
| `plain-http.bundle` | 同一个提交的 thin bundle（15 KB），需要基线提交 `83f5b17` 已存在于本地 |

基线：上游 `dev` 分支提交 `83f5b17`（`chore: update OpenClaw, DSH and Hermes workflows`）。
改造提交：`e0d8441`（本地分支 `plain-http`）。

## 用法 A：应用补丁（推荐）

```bash
git clone --branch dev --filter=blob:none --sparse \
  https://github.com/1Panel-dev/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness .github
git -C runtime checkout 83f5b17                       # 固定补丁基线

# 方式 1：保留提交历史（需要本机 git 身份）
git -C runtime am "$PWD/patches/0001-feat-deepseek-harness-replace-Caddy-with-plain-HTTP-.patch"

# 方式 2：不产生提交，直接改工作区（compose build 只看文件）
git -C runtime apply "$PWD/patches/0001-feat-deepseek-harness-replace-Caddy-with-plain-HTTP-.patch"
```

## 用法 B：从 bundle 取分支

```bash
git clone --branch dev --filter=blob:none --sparse \
  https://github.com/1Panel-dev/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness .github
git -C runtime checkout 83f5b17
git -C runtime fetch "$PWD/patches/plain-http.bundle" plain-http:plain-http
git -C runtime checkout plain-http
```

## 用法 C：推到自己的 fork（团队协作/CI 发布）

```bash
git -C runtime remote add mine git@github.com:<你的账号>/runtime.git
git -C runtime push mine plain-http
# 之后在任意机器：
git clone --branch plain-http --filter=blob:none --sparse \
  git@github.com:<你的账号>/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness .github
```

> 发布镜像时请使用独立仓库名（工作流默认 `1panel/deepseek-harness-plain`），
> **不要**覆盖 `1panel/deepseek-harness:<版本>` / `:latest`，那是 Caddy/HTTPS 版。

## 校验

补丁已在干净基线上验证过：`git checkout 83f5b17` + `git apply` 后的
`deepseek-harness/` 与 `.github/workflows/` 与本目录的 `runtime/` **逐文件一致**。

```bash
git -C runtime apply --check --reverse "$PWD/patches/0001-"*.patch   # 能反向应用 = 与提交一致
```

## 重新生成（`runtime/` 里再改过之后）

```bash
git -C runtime add -A
git -C runtime commit -m "…"
git -C runtime format-patch -1 -o patches
git -C runtime bundle create patches/plain-http.bundle 83f5b17..plain-http
```

## 上游更新后怎么办

上游 `dev` 前进后补丁可能无法直接应用，二选一：

```bash
# 在你自己的 plain-http 分支上 rebase 到新的上游
git -C runtime fetch origin dev
git -C runtime rebase origin/dev      # 解决冲突后重新导出补丁

# 或继续固定基线 83f5b17 构建（镜像只取决于该基线的源码）
```
