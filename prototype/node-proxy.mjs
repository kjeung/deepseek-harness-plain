// Minimal Node reverse proxy prototype: HTTP only, no TLS, no auth.
// Preserves Host + Origin so DSH's own /api fence keeps working.
// Streams request/response bodies without buffering and forwards WebSocket upgrades.
import http from 'node:http'
import net from 'node:net'

const LISTEN_HOST = process.env.LISTEN_HOST ?? '0.0.0.0'
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8080)
const BACKEND_HOST = process.env.BACKEND_HOST ?? '127.0.0.1'
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 4555)

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

function forwardedHeaders(rawHeaders) {
  const headers = {}
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value
  }
  return headers
}

const server = http.createServer((req, res) => {
  const headers = forwardedHeaders(req.headers)
  const upstream = http.request(
    { host: BACKEND_HOST, port: BACKEND_PORT, method: req.method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardedHeaders(upstreamRes.headers))
      // Stream, never buffer: LLM token streams must reach the browser incrementally.
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`bad gateway: ${error.message}\n`)
  })
  req.pipe(upstream)
})

// WebSocket / any HTTP upgrade: raw TCP passthrough after re-sending the request head.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(BACKEND_PORT, BACKEND_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.setTimeout(0)
  upstream.setTimeout(0)
})

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`node-proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${BACKEND_HOST}:${BACKEND_PORT}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
