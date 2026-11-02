FROM node:24-bookworm-slim AS dsh-builder

ARG DSH_VERSION=0.2.1-rc.5

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      g++ \
      make \
      python3 && \
    npm install --global "@deepseek-ai/dsh@${DSH_VERSION}"

COPY deepseek-harness/patch-dsh-authenticated-settings.mjs /tmp/patch-dsh-authenticated-settings.mjs

RUN npm install --prefix /tmp/dsh-browser-compat --no-audit --no-fund \
      core-js@3.51.0 esbuild@0.28.2 && \
    node /tmp/patch-dsh-authenticated-settings.mjs

FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.7.0
# Re-declared so the version is recorded as image metadata as well.
ARG DSH_VERSION=0.2.1-rc.5

LABEL org.opencontainers.image.source="https://github.com/1Panel-dev/runtime" \
      org.opencontainers.image.url="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.title="1Panel DeepSeek Harness" \
      org.opencontainers.image.description="DeepSeek Harness image maintained by 1Panel with plain HTTP access, meant to run behind an authenticated TLS reverse proxy" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.vendor="1Panel"

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      gosu \
      openssh-client \
      ripgrep \
      tini && \
    rm -rf /var/lib/apt/lists/*

COPY --from=dsh-builder /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      --help >/dev/null && \
    install -d -m 0700 -o node -g node /data/dsh /data/dsh/home && \
    install -d -m 0750 -o node -g node /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" && \
    npm cache clean --force && \
    test "$(gosu node env HOME=/data/dsh/home pnpm --version)" = "$PNPM_VERSION"

COPY deepseek-harness/node-proxy.mjs /usr/local/bin/dsh-node-proxy
COPY deepseek-harness/dsh /usr/local/bin/dsh
COPY deepseek-harness/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deepseek-harness/test-runtime.mjs /tmp/test-dsh-runtime.mjs

RUN chmod 0755 /usr/local/bin/dsh /usr/local/bin/docker-entrypoint.sh \
      /usr/local/bin/dsh-node-proxy && \
    dsh --help >/dev/null && \
    /usr/local/bin/docker-entrypoint.sh --self-test && \
    /usr/local/bin/dsh-node-proxy --self-test && \
    node --test /tmp/test-dsh-runtime.mjs && \
    rm /tmp/test-dsh-runtime.mjs

ENV DSH_HOME=/data/dsh \
    DSH_TELEMETRY_DISABLED=1

WORKDIR /workspace

EXPOSE 8080

# The entrypoint waits up to 60 s for the backend before starting the proxy, so the
# start period must stay above that or a cold container is briefly marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS --noproxy '*' --max-time 5 http://127.0.0.1:8080/healthz >/dev/null || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
