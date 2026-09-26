// SPIKE TOOL — not part of the app, and to be deleted with android-spike/.
//
// The headless backend's bridge listens on 127.0.0.1 and refuses anything that
// does not name it in Host and Origin. That is the right product behaviour, and
// it stays exactly as it is. But the device spikes need the TV box's WebView to
// load the REAL app from the backend running on this PC — so this stands in
// front of it, on the LAN, for the length of a test:
//
//     TV box  ──http/ws──▶  this proxy (0.0.0.0:5311)  ──▶  bridge (127.0.0.1:5310)
//
// It rewrites Host and Origin to the loopback values the bridge expects and is
// otherwise a dumb pipe. Signing in still takes the bridge's single-use launch
// code, so being on the LAN is not by itself enough to get in — but everything
// here is cleartext, so: home network, scratch profile with no credentials in
// it, and stop it when the test is done. The real answer to "another device
// talks to this backend" is the paired, encrypted device link, not this.
//
//   node scripts/spike-lan-proxy.mjs [listenPort=5311] [bridgePort=5310]

import http from 'node:http'
import net from 'node:net'
import os from 'node:os'

const listenPort = Number(process.argv[2] ?? 5311)
const bridgePort = Number(process.argv[3] ?? 5310)
const bridgeHost = `127.0.0.1:${bridgePort}`
const bridgeOrigin = `http://${bridgeHost}`

/** The request's headers, as the bridge needs to see them. */
function towardsBridge(headers) {
  const out = { ...headers, host: bridgeHost }
  if (out.origin) out.origin = bridgeOrigin
  if (out.referer) delete out.referer
  return out
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: bridgePort,
      method: req.method,
      path: req.url,
      headers: towardsBridge(req.headers)
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    }
  )
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' }).end(`bridge unreachable: ${error.message}`)
  })
  req.pipe(upstream)
})

// The WebSocket: replay the upgrade request to the bridge with rewritten
// headers, then join the two sockets and get out of the way.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(bridgePort, '127.0.0.1', () => {
    const headers = towardsBridge(req.headers)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const drop = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', drop)
  socket.on('error', drop)
})

server.listen(listenPort, '0.0.0.0', () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
  console.log(`[spike-lan-proxy] LAN :${listenPort} -> bridge ${bridgeHost}   (Ctrl+C to stop)`)
  console.log(
    '[spike-lan-proxy] take the launch URL the backend printed and swap its origin for one of:'
  )
  for (const address of addresses) console.log(`    http://${address}:${listenPort}/?launch=<code>`)
})
