import net from 'node:net'
import crypto from 'node:crypto'
const [, , port, host, origin, path = '/api/remote.mux'] = process.argv
const key = crypto.randomBytes(16).toString('base64')
const socket = net.connect(Number(port), '127.0.0.1', () => {
  const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, `Upgrade: websocket`, `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Version: 13`]
  if (origin) lines.push(`Origin: ${origin}`)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
})
let buf = ''
socket.on('data', (d) => {
  buf += d.toString('latin1')
  if (buf.includes('\r\n\r\n')) {
    const first = buf.split('\r\n')[0]
    console.log(`${first}`)
    setTimeout(() => socket.destroy(), 200)
  }
})
socket.on('error', (e) => console.log('ERR', e.message))
setTimeout(() => socket.destroy(), 4000)
