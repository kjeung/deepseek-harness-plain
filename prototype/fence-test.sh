#!/usr/bin/env bash
# Test DSH's native Host/Origin fence and settings endpoints directly against the backend.
BASE=http://127.0.0.1:4555
req() { # label path host origin extra...
  local label="$1" path="$2" host="$3" origin="$4"; shift 4
  local args=(-sS -o /tmp/body.$$ -w '%{http_code}' --max-time 5 -X POST -H "Content-Type: application/json" -H "Host: $host")
  [[ -n "$origin" ]] && args+=(-H "Origin: $origin")
  for h in "$@"; do args+=(-H "$h"); done
  local code; code=$(curl "${args[@]}" -d '{"value":"test"}' "$BASE$path")
  printf '%-52s host=%-22s origin=%-26s -> %s  %s\n' "$label" "$host" "${origin:-<none>}" "$code" "$(head -c 120 /tmp/body.$$)"
  rm -f /tmp/body.$$
}
echo "--- /api/settings/describe with trusted vs untrusted Host ---"
req "settings/describe"            /api/settings/describe  example.test      "http://example.test"
req "settings/describe loopback"   /api/settings/describe  127.0.0.1:4555    "http://127.0.0.1:4555"
req "settings/describe untrusted"  /api/settings/describe  evil.test         "http://evil.test"
req "settings/describe bad origin" /api/settings/describe  example.test      "http://evil.test"
req "settings/describe no origin"  /api/settings/describe  example.test      ""
req "settings/describe crossorigin" /api/settings/describe example.test      "" "Sec-Fetch-Site: cross-site"
echo "--- other APIs ---"
req "credentials/set (trusted)"    /api/credentials/set    example.test      "http://example.test"
req "llm/discoverModels (trusted)" /api/llm/discoverModels example.test      "http://example.test"
req "remote.mux (http POST)"       /api/remote.mux         example.test      ""
