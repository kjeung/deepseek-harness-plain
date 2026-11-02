#!/usr/bin/env node
// Plain-HTTP forwarding proxy for DeepSeek Harness.
//
// Replaces Caddy in deployments where an upstream reverse proxy already provides
// authentication and TLS: this process terminates nothing, authenticates nobody,
// and only forwards HTTP + WebSocket traffic to the loopback DSH backend.
//
// Security model: the listener MUST NOT be reachable by anything except the
// trusted upstream proxy. It enforces a Host allowlist and can require a shared
// secret header, but those are not authentication — they only stop an accidental
// or network-adjacent client from using this port.
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

// A closed stdout (log pipe) must never take the whole proxy — and with it every
// running agent session — down with an unhandled EPIPE.
process.stdout.on('error', () => {})

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
// Credentials the proxy owns, plus forwarding metadata a client must not forge:
// DSH does not read any of these, and trusting them would only widen the spoof surface.
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-dsh-proxy-secret',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
])
const STRIPPED_RESPONSE_HEADERS = new Set(['server', 'x-powered-by'])

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    fail(`${name} must be an integer between 0 and 65535`)
  }
  return value
}

function fail(message) {
  process.stderr.write(`dsh-node-proxy: ${message}\n`)
  process.exit(1)
}

/** Canonical host form: lowercase, no trailing dot, no port. */
export function normalizeHost(authority) {
  let value = String(authority ?? '').trim().toLowerCase()
  if (value === '') return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? '' : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(value.slice(colon + 1))) value = value.slice(0, colon)
  return value.endsWith('.') ? value.slice(0, -1) : value
}

const accessHosts = (process.env.PROXY_ALLOWED_HOSTS ?? '')
  .split(',')
  .map(normalizeHost)
  .filter(Boolean)
const listenHost = process.env.PROXY_LISTEN_HOST ?? '0.0.0.0'
const listenPort = envInt('PROXY_LISTEN_PORT', 8080)
const backendHost = process.env.PROXY_BACKEND_HOST ?? '127.0.0.1'
const backendPort = envInt('PROXY_BACKEND_PORT', 3080)
const sharedSecret = process.env.PROXY_SHARED_SECRET ?? ''
const accessLog = process.env.PROXY_ACCESS_LOG !== '0'
const upstreamHeaderTimeoutMs = 120_000

/** @returns {boolean} whether the request authority is one we serve. */
function hostAllowed(authority) {
  return accessHosts.includes(normalizeHost(authority))
}

/** @returns {boolean} whether the presented Host ends with a dot (rejected: DSH 403s it). */
function hostHasTrailingDot(authority) {
  const value = String(authority ?? '').trim()
  if (value.startsWith('[')) return false
  const withoutPort = value.replace(/:\d+$/, '')
  return withoutPort.endsWith('.')
}

/** @returns {boolean} whether more than one Host header was sent (RFC 7230 requires 400). */
function duplicateHost(request) {
  let seen = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'host') seen += 1
  }
  return seen > 1
}

function isLoopback(remote) {
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** Constant-time shared-secret check; an empty secret disables the requirement. */
function secretOk(request) {
  if (sharedSecret === '') return true
  const presented = request.headers['x-dsh-proxy-secret']
  if (typeof presented !== 'string') return false
  const expected = Buffer.from(sharedSecret)
  const actual = Buffer.from(presented)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

/** Header names named by the Connection header are hop-by-hop too (RFC 7230 §6.1). */
function connectionTokens(value) {
  const tokens = []
  for (const part of String(value ?? '').split(',')) {
    const token = part.trim().toLowerCase()
    if (token !== '') tokens.push(token)
  }
  return tokens
}

/** Copy end-to-end request headers, keeping the original Host verbatim. */
function requestHeaders(request) {
  const drop = new Set(HOP_BY_HOP)
  for (const token of connectionTokens(request.headers.connection)) drop.add(token)
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (drop.has(lower) || STRIPPED_REQUEST_HEADERS.has(lower)) continue
    headers[name] = value
  }
  return headers
}

/** Copy end-to-end response headers and force the security headers Caddy used to set. */
function responseHeaders(upstream) {
  const drop = new Set(HOP_BY_HOP)
  for (const token of connectionTokens(upstream.headers.connection)) drop.add(token)
  const headers = {}
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lower = name.toLowerCase()
    if (drop.has(lower) || STRIPPED_RESPONSE_HEADERS.has(lower)) continue
    headers[name] = value
  }
  headers['x-content-type-options'] = 'nosniff'
  headers['referrer-policy'] = 'same-origin'
  return headers
}

function logLine(request, remote, status, startedAt, bytes) {
  if (!accessLog) return
  const path = (request.url ?? '/').split('?')[0]
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    remote,
    method: request.method ?? '',
    path,
    status,
    ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    bytes,
  })}\n`)
}

function logUpgrade(request, remote, status, startedAt) {
  if (!accessLog) return
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    remote,
    method: request.method ?? '',
    path: (request.url ?? '/').split('?')[0],
    status,
    ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
    bytes: 0,
    upgrade: true,
  })}\n`)
}

// DSH's own HTTP server closes idle keep-alive sockets after ~5 s; keep the pool's
// idle timeout below that so a reused socket is never one the backend already closed.
const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 256, timeout: 4000 })
const trackedSockets = new Set()

function securityHeaders() {
  return {
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  }
}

/**
 * Readiness/liveness: proves this proxy AND the DSH backend answer.
 * Reachable only from loopback (the container healthcheck) or with the shared
 * secret, so an unauthenticated client cannot use it to probe the backend.
 */
function healthz(request, remote, response, startedAt) {
  response.on('finish', () => logLine(request, remote, response.statusCode, startedAt, 0))
  if (!isLoopback(remote) && !secretOk(request)) {
    response.writeHead(403, { ...securityHeaders(), 'content-type': 'text/plain' })
    response.end('forbidden\n')
    return
  }

  let settled = false
  const finish = (status, payload) => {
    if (settled) return
    settled = true
    if (response.writableEnded || response.destroyed) return
    response.writeHead(status, securityHeaders())
    response.end(`${JSON.stringify(payload)}\n`)
  }

  const probe = http.request(
    {
      host: backendHost,
      port: backendPort,
      method: 'GET',
      path: '/',
      headers: { host: `${backendHost}:${backendPort}`, connection: 'close' },
      timeout: 2000,
    },
    (upstream) => {
      upstream.resume()
      const status = upstream.statusCode ?? 0
      // A 401 means the auth bypass patch is missing; report it as unhealthy.
      finish(status === 200 ? 200 : 502, { ok: status === 200, backend: status })
    },
  )
  probe.on('timeout', () => probe.destroy(new Error('backend timeout')))
  probe.on('error', () => {
    probe.destroy()
    finish(502, { ok: false })
  })
  response.on('close', () => {
    if (!response.writableFinished) probe.destroy()
  })
  probe.end()
}

function reject(response, status, message) {
  response.writeHead(status, {
    'content-type': 'text/plain',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  })
  response.end(`${message}\n`)
}

const server = http.createServer((request, response) => {
  const startedAt = process.hrtime.bigint()
  // Captured now: after a client abort the socket no longer reports an address.
  const remote = request.socket.remoteAddress ?? ''
  const path = (request.url ?? '/').split('?')[0]
  if (path === '/healthz') {
    healthz(request, remote, response, startedAt)
    return
  }
  if (duplicateHost(request)) {
    reject(response, 400, 'bad request: duplicate Host header')
    logLine(request, remote, 400, startedAt, 0)
    return
  }
  if (request.headers.host === undefined) {
    reject(response, 400, 'bad request: missing Host')
    logLine(request, remote, 400, startedAt, 0)
    return
  }
  if (hostHasTrailingDot(request.headers.host)) {
    // The backend's own Host fence rejects FQDN trailing dots with 403; say so clearly.
    reject(response, 400, 'bad request: Host must not end with a dot')
    logLine(request, remote, 400, startedAt, 0)
    return
  }
  if (!hostAllowed(request.headers.host)) {
    reject(response, 403, 'forbidden')
    logLine(request, remote, 403, startedAt, 0)
    return
  }
  if (!secretOk(request)) {
    reject(response, 403, 'forbidden')
    logLine(request, remote, 403, startedAt, 0)
    return
  }

  // Exactly one access-log line per request, and a distinct status when the
  // client itself walked away mid-stream (nginx calls this 499).
  let logged = false
  let clientGone = false
  const log = (status, bytes) => {
    if (logged) return
    logged = true
    logLine(request, remote, status, startedAt, bytes)
  }

  let headerTimer
  const upstream = http.request(
    {
      host: backendHost,
      port: backendPort,
      method: request.method,
      path: request.url,
      headers: requestHeaders(request),
      agent,
    },
    (upstreamResponse) => {
      clearTimeout(headerTimer)
      const headers = responseHeaders(upstreamResponse)
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      let bytes = 0
      upstreamResponse.on('data', (chunk) => { bytes += chunk.length })
      upstreamResponse.on('end', () => log(upstreamResponse.statusCode ?? 0, bytes))
      // A mid-stream upstream failure must not crash the process or hang the client.
      upstreamResponse.on('error', () => {
        response.destroy()
        log(clientGone ? 499 : 502, bytes)
      })
      // Stream chunk by chunk: LLM output and SSE must not be buffered.
      upstreamResponse.pipe(response)
    },
  )
  // A backend that accepts the connection but never answers must not pin the client forever.
  headerTimer = setTimeout(() => upstream.destroy(new Error('upstream response timeout')), upstreamHeaderTimeoutMs)
  upstream.on('response', () => clearTimeout(headerTimer))
  upstream.on('close', () => clearTimeout(headerTimer))
  upstream.on('error', (error) => {
    clearTimeout(headerTimer)
    const timedOut = error.message === 'upstream response timeout'
    // Keep the detail in the container log; the client only sees a generic status.
    if (!clientGone) process.stderr.write(`dsh-node-proxy: upstream error: ${error.message}\n`)
    if (!response.headersSent) {
      reject(response, timedOut ? 504 : 502, timedOut ? 'gateway timeout' : 'bad gateway')
      log(timedOut ? 504 : 502, 0)
    } else {
      response.destroy()
      log(clientGone ? 499 : timedOut ? 504 : 502, 0)
    }
  })
  // Client aborted mid-request (including mid-upload): stop the upstream.
  request.on('aborted', () => {
    clientGone = true
    upstream.destroy()
  })
  request.on('error', () => {
    clientGone = true
    upstream.destroy()
  })
  request.on('close', () => {
    if (!request.complete) {
      clientGone = true
      upstream.destroy()
    }
  })
  response.on('close', () => {
    if (!response.writableFinished) {
      clientGone = true
      upstream.destroy()
    }
  })
  request.pipe(upstream)
})

server.on('upgrade', (request, socket, head) => {
  const startedAt = process.hrtime.bigint()
  const remote = request.socket.remoteAddress ?? ''
  trackedSockets.add(socket)
  socket.on('close', () => trackedSockets.delete(socket))
  socket.on('error', () => socket.destroy())

  const refuse = (status) => {
    logUpgrade(request, remote, status, startedAt)
    socket.end(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden`)
  }

  if (duplicateHost(request) || hostHasTrailingDot(request.headers.host ?? '') ||
      request.headers.host === undefined || !hostAllowed(request.headers.host) || !secretOk(request)) {
    refuse(403)
    return
  }

  const drop = new Set(STRIPPED_REQUEST_HEADERS)
  const lines = [`${request.method} ${request.url} HTTP/1.1`]
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    if (drop.has(name.toLowerCase())) continue
    lines.push(`${name}: ${request.rawHeaders[index + 1]}`)
  }
  const upstream = net.connect(backendPort, backendHost, () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
  })
  // Log the status the backend actually answered with (101 for a successful upgrade).
  let logged = false
  let preface = ''
  upstream.on('data', (chunk) => {
    if (!logged) {
      preface += chunk.toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(preface)
      if (match) {
        logged = true
        logUpgrade(request, remote, Number(match[1]), startedAt)
      }
    }
    if (!socket.write(chunk)) upstream.pause()
  })
  socket.on('drain', () => upstream.resume())
  socket.on('data', (chunk) => {
    if (!upstream.write(chunk)) socket.pause()
  })
  upstream.on('drain', () => socket.resume())
  upstream.on('error', () => socket.destroy())
  upstream.on('close', () => {
    if (!logged) logUpgrade(request, remote, 0, startedAt)
    socket.destroy()
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => {
    if (!logged) logUpgrade(request, remote, 0, startedAt)
    upstream.destroy()
  })
  socket.setTimeout(0)
  upstream.setTimeout(0)
})

server.on('clientError', (error, socket) => {
  if (socket.writable && error.code !== 'ECONNRESET') {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n' +
      'Content-Type: text/plain\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\n\r\n',
    )
  } else {
    socket.destroy()
  }
})

// Long uploads and long-lived streams need generous limits; DSH owns the
// application-level 300 MiB body cap and replies 413 itself. A stalled backend is
// bounded by upstreamHeaderTimeoutMs instead of by the client connection.
server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 65_000

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write(`dsh-node-proxy: ${signal} received, draining\n`)
  server.close(() => process.exit(0))
  for (const socket of trackedSockets) socket.destroy()
  server.closeIdleConnections?.()
  setTimeout(() => process.exit(0), 5000).unref()
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal))

if (process.argv.includes('--self-test')) {
  const ok = normalizeHost('DSH.Example.COM.:8080') === 'dsh.example.com' &&
    normalizeHost('203.0.113.10:8080') === '203.0.113.10' &&
    normalizeHost('') === '' &&
    normalizeHost('[::1]:8080') === '::1' &&
    hostHasTrailingDot('dsh.example.com.') === true &&
    hostHasTrailingDot('dsh.example.com:8080') === false
  process.exit(ok ? 0 : 1)
}

if (accessHosts.length === 0) {
  fail('PROXY_ALLOWED_HOSTS is required (comma-separated host names, e.g. dsh.example.com)')
}

server.listen(listenPort, listenHost, () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : listenPort
  process.stdout.write(
    `dsh-node-proxy listening on ${listenHost}:${port} -> ${backendHost}:${backendPort} ` +
    `(plain HTTP, no authentication; allowed hosts: ${accessHosts.join(', ')}` +
    `${sharedSecret === '' ? '' : '; shared secret required'})\n`,
  )
})
