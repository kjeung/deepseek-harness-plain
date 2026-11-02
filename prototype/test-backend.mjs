import http from 'node:http'
import crypto from 'node:crypto'

http.createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
    let i = 0
    const timer = setInterval(() => {
      res.write(`chunk-${i}:${process.hrtime.bigint()}\n`)
      if (++i === 3) { clearInterval(timer); res.end('done\n') }
    }, 400)
    return
  }
  if (req.url === '/echo') {
    let bytes = 0
    req.on('data', (c) => { bytes += c.length })
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes })) })
    return
  }
  res.writeHead(404); res.end('nope')
}).on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'] ?? ''
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on('data', (d) => socket.write(d))  // echo raw frames
}).listen(4556, '127.0.0.1', () => console.log('test-backend on 4556'))
