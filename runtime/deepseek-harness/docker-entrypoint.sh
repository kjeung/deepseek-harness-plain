#!/usr/bin/env bash
set -Eeuo pipefail

is_access_host() {
  node -e '
    const { isIPv4 } = require("node:net");
    const value = process.argv[1];
    // Wildcard and broadcast literals are never a browser authority; accepting
    // them would only produce a white screen (and would trust a loopback alias).
    if (value === "0.0.0.0" || value === "255.255.255.255") process.exit(1);
    const hostname = value.length <= 253 && !/^[0-9.]+$/.test(value) &&
      value.split(".").every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
    process.exit(isIPv4(value) || hostname ? 0 : 1);
  ' "$1"
}

if [[ "${1:-}" == "--self-test" ]]; then
  is_access_host 203.0.113.10
  is_access_host dsh.example.com
  ! is_access_host https://dsh.example.com
  ! is_access_host 203.0.113.10:10443
  ! is_access_host 203.0.113.999
  ! is_access_host 0.0.0.0
  ! is_access_host 255.255.255.255
  exit 0
fi

printf '\033[1;32m%s\033[0m\n' 'This image is maintained by 1Panel.'
printf '\033[1;33m%s\033[0m\n' 'For support or issue discussion, please visit:'
printf '\033[1;36m%s\033[0m\n' 'https://github.com/1Panel-dev/1Panel/discussions'

# DSH_ACCESS_HOST is the host name browsers use to reach the deployment. It is
# only used to fence the backend's /api requests; this container terminates no
# TLS. HTTPS_ACCESS_HOST is accepted for compatibility with older deployments.
access_host="${DSH_ACCESS_HOST:-${HTTPS_ACCESS_HOST:-}}"

if [[ -z "${DSH_ACCESS_HOST:-}" && -n "${HTTPS_ACCESS_HOST:-}" ]]; then
  printf 'HTTPS_ACCESS_HOST is deprecated; rename it to DSH_ACCESS_HOST (this container serves plain HTTP).\n' >&2
fi

if ! is_access_host "$access_host"; then
  printf 'DSH_ACCESS_HOST must be an IPv4 address or hostname without a scheme, path, or port (wildcard/broadcast addresses are rejected).\n' >&2
  exit 1
fi

if [[ "$access_host" == 127.* ]]; then
  printf 'Warning: DSH_ACCESS_HOST is a loopback address; the backend also trusts loopback Hosts, so the proxy Host allowlist adds nothing. Use the browser-facing host name.\n' >&2
fi

unset DSH_ACCESS_HOST HTTPS_ACCESS_HOST

install -d -m 0700 -o node -g node /data/dsh /data/dsh/home
install -d -m 0750 -o node -g node /workspace

pids=()
cleanup() {
  if (( ${#pids[@]} )); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

gosu node env \
  HOME=/data/dsh/home \
  DSH_HOME=/data/dsh \
  DSH_TELEMETRY_DISABLED=1 \
  ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
    web --no-open --host 127.0.0.1 --port 3080 \
      --trusted-host 127.0.0.1:3080 "$access_host" &
dsh_pid=$!
pids+=("$dsh_pid")

ready=false
for _ in {1..60}; do
  if curl -fsS --noproxy '*' --max-time 2 http://127.0.0.1:3080/ >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$dsh_pid" 2>/dev/null; then
    wait "$dsh_pid"
    exit $?
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  printf 'DeepSeek Harness did not become ready within 60 seconds.\n' >&2
  exit 1
fi

gosu node env \
  HOME=/data/dsh/home \
  PROXY_LISTEN_HOST=0.0.0.0 \
  PROXY_LISTEN_PORT=8080 \
  PROXY_ALLOWED_HOSTS="$access_host" \
  node /usr/local/bin/dsh-node-proxy &
proxy_pid=$!
pids+=("$proxy_pid")

printf 'DeepSeek Harness is available at http://%s:8080 inside the container (plain HTTP).\n' "$access_host"
printf 'This container performs no TLS and no authentication: restrict port 8080 to the trusted reverse proxy.\n'

status=0
wait -n "$dsh_pid" "$proxy_pid" || status=$?
exit "$status"
