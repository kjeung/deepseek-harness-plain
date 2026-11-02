import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'

const dshRoot = process.env.DSH_TEST_ROOT ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh'
const requireDsh = createRequire(join(dshRoot, 'package.json'))
const pdfPath = join(requireDsh.resolve('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/package.json'), '../lib/client.pdf.js')
const pdf = await readFile(pdfPath, 'utf8')
const removeIterator = `
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  for (const name of ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find', 'join']) delete prototype[name];
  delete globalThis.Iterator;
`
const checkIterator = `
  JSON.stringify(Iterator.from([1, 2, 3]).filter(x => x > 1).map(x => x * 2).toArray()) === '[4,6]'
    && new Map([[1, 'one']]).values().some(x => x === 'one')
`

test('PDF page initializes Iterator helpers before registering its module', () => {
  let registered = false
  const context = vm.createContext({ window: { __ModuleLoader__: { load() { registered = true } } } })
  vm.runInContext(removeIterator, context)
  vm.runInContext(pdf, context, { timeout: 5000 })
  assert.ok(registered)
  assert.equal(vm.runInContext(checkIterator, context), true)
})

test('embedded PDF worker initializes its own Iterator helpers', async t => {
  const declaration = pdf.split('\n').find(line => line.trimStart().startsWith('var _dsh_pdf_worker_default = '))
  assert.ok(declaration, 'PDF worker declaration must exist')
  const source = vm.runInNewContext(`${declaration}\n_dsh_pdf_worker_default`)
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      ${removeIterator}
      const pdf = await import('data:text/javascript;base64,' + Buffer.from(workerData).toString('base64'));
      parentPort.postMessage({ ok: (${checkIterator}) && typeof pdf.WorkerMessageHandler === 'function' });
    })().catch(error => { throw error });
  `, { eval: true, workerData: source })
  t.after(() => worker.terminate())
  const [result] = await once(worker, 'message')
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// Node forwarding proxy: it must behave like the Caddy route it replaced for
// everything DSH itself does not enforce (Host preservation, streaming, WS).
// ---------------------------------------------------------------------------

const proxyBin = process.env.DSH_PROXY_BIN ?? '/usr/local/bin/dsh-node-proxy'
const ALLOWED_HOST = 'dsh.example.com'

/** Reserve a free TCP port on loopback. */
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Start a mock DSH backend and record the requests it receives. */
async function startBackend(handler) {
  const requests = []
  const upgraded = new Set()
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body })
      handler(request, response, { body, requests })
    })
  })
  server.on('upgrade', (request, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    requests.push({ method: request.method, url: request.url, headers: request.headers, upgrade: true })
    const key = request.headers['sec-websocket-key'] ?? ''
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${key}\r\n\r\n`,
    )
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return {
    port,
    requests,
    close: () => new Promise((resolve) => {
      // Upgraded sockets are not covered by closeAllConnections(), so close()
      // would otherwise wait forever on an open WebSocket.
      for (const socket of upgraded) socket.destroy()
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

/** Start the proxy against a backend port and wait until it listens. */
async function startProxy(backendPort, env = {}) {
  const child = spawn(process.execPath, [proxyBin], {
    env: {
      ...process.env,
      PROXY_LISTEN_HOST: '127.0.0.1',
      // Port 0 lets the kernel pick: no reserve/release race between tests.
      PROXY_LISTEN_PORT: '0',
      PROXY_BACKEND_HOST: '127.0.0.1',
      PROXY_BACKEND_PORT: String(backendPort),
      PROXY_ALLOWED_HOSTS: ALLOWED_HOST,
      PROXY_ACCESS_LOG: '0',
      // Never inherit a developer's shared secret; tests opt in explicitly.
      PROXY_SHARED_SECRET: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (output.includes('listening on')) break
    if (child.exitCode !== null) throw new Error(`proxy exited: ${output}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(output.includes('listening on'), `proxy did not start: ${output}`)
  const match = /listening on [^\s]+:(\d+)/.exec(output)
  assert.ok(match, `proxy did not report its port: ${output}`)
  const port = Number(match[1])
  return {
    port,
    child,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    },
  }
}

/** One HTTP request against the proxy; resolves with status, headers and body. */
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: ALLOWED_HOST, ...headers }, agent: false },
      (response) => {
        let received = ''
        response.on('data', (chunk) => { received += chunk })
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: received }))
      },
    )
    req.setTimeout(10000, () => req.destroy(new Error('proxy request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

test('proxy preserves Host and Origin, strips credentials, adds security headers', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response, { body }) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, body }))
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const response = await request(proxy.port, {
    method: 'POST',
    path: '/api/settings/describe',
    headers: {
      Origin: `http://${ALLOWED_HOST}`,
      'Content-Type': 'application/json',
      Authorization: 'Basic dGVzdDp0ZXN0',
      'X-DSH-Proxy-Secret': 'leaked-secret',
    },
    body: JSON.stringify({ type: 'client-request', rpcId: '1', method: 'settings/describe', payload: { args: {} } }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['referrer-policy'], 'same-origin')
  assert.equal(response.headers.server, undefined)

  const [seen] = backend.requests
  assert.equal(seen.headers.host, ALLOWED_HOST, 'Host must reach the backend verbatim')
  assert.equal(seen.headers.origin, `http://${ALLOWED_HOST}`, 'Origin must survive for the CSRF fence')
  assert.equal(seen.headers.authorization, undefined, 'Authorization must not reach the backend')
  assert.equal(seen.headers['x-dsh-proxy-secret'], undefined, 'the proxy secret must not reach the backend')
  assert.equal(seen.url, '/api/settings/describe')
  assert.equal(JSON.parse(seen.body).method, 'settings/describe')
})

test('proxy rejects an unknown Host before the request reaches the backend', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('backend')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const rejected = await request(proxy.port, { path: '/api/settings/describe', headers: { Host: 'attacker.invalid' } })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.body.trim(), 'forbidden')
  assert.equal(backend.requests.length, 0, 'rejected requests must not be forwarded')

  // HTTP/1.0 without a Host header is rejected explicitly rather than guessed.
  const raw = await new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write('GET / HTTP/1.0\r\n\r\n')
    })
    let received = ''
    socket.on('data', (chunk) => { received += chunk })
    socket.on('close', () => resolve(received))
    socket.on('error', () => resolve(received))
    setTimeout(() => socket.destroy(), 3000)
  })
  assert.match(raw, /^HTTP\/1\.[01] 400/)
})

test('proxy streams responses without buffering', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('first\n')
    // Generous gap: a buffering proxy would hold "first" this long.
    setTimeout(() => response.end('second\n'), 800)
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const startedAt = Date.now()
  let firstChunkAt = 0
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, path: '/', headers: { Host: ALLOWED_HOST }, agent: false },
      (response) => {
        let received = ''
        response.on('data', (chunk) => {
          if (firstChunkAt === 0) firstChunkAt = Date.now()
          received += chunk
        })
        response.on('end', () => resolve(received))
      },
    )
    req.setTimeout(10000, () => req.destroy(new Error('stream timed out')))
    req.on('error', reject)
    req.end()
  })

  assert.equal(body, 'first\nsecond\n')
  // A buffering proxy would hold "first" until the backend ended 800 ms later.
  assert.ok(firstChunkAt - startedAt < 600, `first chunk arrived after ${firstChunkAt - startedAt} ms`)
})

test('proxy forwards WebSocket upgrades and fences the Host', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('http')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const handshake = (host) => new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n' +
        `Host: ${host}\r\n` +
        'Origin: http://dsh.example.com\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      )
    })
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk
      if (received.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(received.split('\r\n')[0])
      }
    })
    socket.on('error', () => resolve(received.split('\r\n')[0] ?? ''))
    setTimeout(() => socket.destroy(), 3000)
  })

  assert.match(await handshake(ALLOWED_HOST), /^HTTP\/1\.1 101/)
  assert.match(await handshake('attacker.invalid'), /^HTTP\/1\.1 403/)
})

test('proxy returns 502 when the backend is unreachable', { timeout: 30000 }, async (t) => {
  const deadPort = await freePort()
  const proxy = await startProxy(deadPort)
  t.after(() => proxy.stop())

  const response = await request(proxy.port, { path: '/' })
  assert.equal(response.status, 502)
  assert.match(response.body, /bad gateway/)
})

test('proxy enforces an optional shared secret', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const proxy = await startProxy(backend.port, { PROXY_SHARED_SECRET: 's3cret-value' })
  t.after(async () => { await proxy.stop(); await backend.close() })

  assert.equal((await request(proxy.port, { path: '/' })).status, 403)
  assert.equal((await request(proxy.port, { path: '/', headers: { 'X-DSH-Proxy-Secret': 'wrong' } })).status, 403)
  const allowed = await request(proxy.port, { path: '/', headers: { 'X-DSH-Proxy-Secret': 's3cret-value' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.body, 'ok')
})

test('healthz proves the backend answers and survives shutdown', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await backend.close() })

  const healthy = await request(proxy.port, { path: '/healthz' })
  assert.equal(healthy.status, 200)
  assert.equal(JSON.parse(healthy.body).ok, true)

  const exited = once(proxy.child, 'exit')
  proxy.child.kill('SIGTERM')
  const [code] = await exited
  assert.equal(code, 0)
})

test('proxy normalizes Host case, trailing dot and port for the allowlist', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  for (const host of ['DSH.Example.COM', 'dsh.example.com:8443', 'Dsh.Example.COM:8080']) {
    const response = await request(proxy.port, { path: '/', headers: { Host: host } })
    assert.equal(response.status, 200, `Host ${host} should be accepted`)
  }
  assert.equal((await request(proxy.port, { path: '/', headers: { Host: 'dsh.example.com.evil.test' } })).status, 403)
  // A FQDN trailing dot is a valid authority but DSH's fence 403s it; reject it here
  // with a clear 400 instead of forwarding a confusing failure.
  assert.equal((await request(proxy.port, { path: '/', headers: { Host: 'dsh.example.com.' } })).status, 400)
})

test('healthz reports the backend as unhealthy instead of pretending to be up', { timeout: 30000 }, async (t) => {
  const deadPort = await freePort()
  const proxy = await startProxy(deadPort)
  t.after(() => proxy.stop())

  const response = await request(proxy.port, { path: '/healthz' })
  assert.equal(response.status, 502)
  assert.equal(JSON.parse(response.body).ok, false)
})

test('the shared secret is required for WebSocket upgrades too', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('http')
  })
  const proxy = await startProxy(backend.port, { PROXY_SHARED_SECRET: 's3cret-value' })
  t.after(async () => { await proxy.stop(); await backend.close() })

  const handshake = (headers) => new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => {
      socket.write(
        'GET /api/remote.mux HTTP/1.1\r\n' +
        `Host: ${ALLOWED_HOST}\r\n` +
        'Origin: http://dsh.example.com\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
        headers.map(([name, value]) => `${name}: ${value}\r\n`).join('') +
        '\r\n',
      )
    })
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk
      if (received.includes('\r\n\r\n')) {
        socket.destroy()
        resolve(received.split('\r\n')[0])
      }
    })
    socket.on('error', () => resolve(received.split('\r\n')[0] ?? ''))
    setTimeout(() => socket.destroy(), 3000)
  })

  assert.match(await handshake([]), /^HTTP\/1\.1 403/)
  assert.match(await handshake([['X-DSH-Proxy-Secret', 's3cret-value']]), /^HTTP\/1\.1 101/)
})

test('SIGTERM drains an open WebSocket and exits 0', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('http')
  })
  const proxy = await startProxy(backend.port)
  t.after(() => backend.close())

  const socket = net.connect(proxy.port, '127.0.0.1', () => {
    socket.write(
      'GET /api/remote.mux HTTP/1.1\r\n' +
      `Host: ${ALLOWED_HOST}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
  })
  socket.on('error', () => {})
  await once(socket, 'data')

  const exited = once(proxy.child, 'exit')
  proxy.child.kill('SIGTERM')
  const [code] = await exited
  socket.destroy()
  assert.equal(code, 0)
})

test('proxy rejects duplicate Host headers and connection-nominated hop headers', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200)
    response.end('ok')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const raw = (payload) => new Promise((resolve) => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write(payload))
    let received = ''
    const finish = () => { socket.destroy(); resolve(received) }
    socket.on('data', (chunk) => {
      received += chunk
      if (received.includes('\r\n\r\n')) setTimeout(finish, 50)
    })
    socket.on('close', () => resolve(received))
    socket.on('error', () => resolve(received))
    setTimeout(finish, 3000)
  })

  const duplicated = await raw(
    'GET /x HTTP/1.1\r\nHost: dsh.example.com\r\nHost: dsh.example.com\r\n\r\n',
  )
  assert.match(duplicated, /^HTTP\/1\.1 400/)
  assert.equal(backend.requests.length, 0)

  const nominated = await raw(
    'GET /x HTTP/1.1\r\nHost: dsh.example.com\r\nConnection: keep-alive, X-Secret-Hop\r\n' +
    'X-Secret-Hop: leak\r\nX-Forwarded-For: 1.2.3.4\r\n\r\n',
  )
  assert.match(nominated, /^HTTP\/1\.1 200/)
  const [seen] = backend.requests
  assert.equal(seen.headers['x-secret-hop'], undefined, 'Connection-nominated header must be dropped')
  assert.equal(seen.headers['x-forwarded-for'], undefined, 'client forwarding headers must be dropped')
})

test('proxy strips upstream Server headers', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response) => {
    response.writeHead(200, { server: 'secret-version', 'x-powered-by': 'secret-framework' })
    response.end('ok')
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const response = await request(proxy.port, { path: '/' })
  assert.equal(response.headers.server, undefined)
  assert.equal(response.headers['x-powered-by'], undefined)
})

test('healthz survives a backend that sends headers then stalls', { timeout: 30000 }, async (t) => {
  // Regression: the probe must never write a second response (ERR_HTTP_HEADERS_SENT).
  const backend = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('x')
    // never ends
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  t.after(() => new Promise((resolve) => {
    backend.closeAllConnections?.()
    backend.close(resolve)
  }))
  const proxy = await startProxy(backend.address().port)
  t.after(() => proxy.stop())

  const first = await request(proxy.port, { path: '/healthz' })
  assert.equal(first.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(proxy.child.exitCode, null, 'proxy must stay alive after a healthz probe timeout')
  const second = await request(proxy.port, { path: '/healthz' })
  assert.equal(second.status, 200)
})

test('proxy forwards large bodies intact', { timeout: 30000 }, async (t) => {
  const backend = await startBackend((_request, response, { body }) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ bytes: Buffer.byteLength(body) }))
  })
  const proxy = await startProxy(backend.port)
  t.after(async () => { await proxy.stop(); await backend.close() })

  const payload = Buffer.alloc(4 * 1024 * 1024, 0x61)
  const response = await request(proxy.port, {
    method: 'POST',
    path: '/api/session/uploadFileBinary',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: payload,
  })
  assert.equal(response.status, 200)
  assert.equal(JSON.parse(response.body).bytes, payload.length)
})
