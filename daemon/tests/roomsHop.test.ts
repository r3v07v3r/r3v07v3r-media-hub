// The rooms hop, against a fake relay — everything but Cloudflare.
//
// The daemon under test is the real createRoomsHop on a real HTTP server
// with real WebSockets on ephemeral ports; only the relay at the far end
// is a stand-in that mimics room.ts's envelope behaviour (fan to every
// connection but the sender). What this pins is the hop's whole reason
// to exist and its two easy-to-lose obligations:
//
//   - ONE upstream connection per room, however many local devices —
//     that is the feature;
//   - the LOCAL ECHO — the relay never fans a message back to its own
//     connection, and a household shares one, so siblings only hear each
//     other if the daemon says it;
//   - teardown — the last local unsubscribe closes the upstream, or the
//     daemon holds relay connections for rooms nobody is in.

import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

import { createRoomsHop } from '../roomsHop'

const ROOM_ID = '11111111-2222-3333-4444-555555555555'

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port)
    })
  })
}

async function main(): Promise<void> {
  // --- the stand-in relay --------------------------------------------------
  const relayServer = http.createServer()
  const relayWss = new WebSocketServer({ noServer: true })
  interface RelayConn {
    ws: WebSocket
    member: string | null
    id: number
  }
  const relayConns: RelayConn[] = []
  const relayReceived: string[] = []
  let nextConnId = 1
  relayServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    relayWss.handleUpgrade(req, socket, head, (ws) => {
      const conn: RelayConn = { ws, member: url.searchParams.get('member'), id: nextConnId++ }
      relayConns.push(conn)
      ws.on('message', (raw) => {
        const body = String(raw)
        relayReceived.push(body)
        // room.ts's contract: tag and fan to every OTHER connection.
        const envelope = JSON.stringify({
          type: 'relay',
          connId: `up-${conn.id}`,
          isHost: false,
          body
        })
        for (const other of relayConns) {
          if (other !== conn && other.ws.readyState === WebSocket.OPEN) other.ws.send(envelope)
        }
      })
      ws.on('close', () => {
        const index = relayConns.indexOf(conn)
        if (index >= 0) relayConns.splice(index, 1)
      })
    })
  })
  const relayPort = await listen(relayServer)
  // http, which the hop permits ONLY for loopback — the carve-out that
  // exists for exactly this harness and local wrangler dev.
  const relayUrl = `http://127.0.0.1:${relayPort}`

  // --- the daemon side -----------------------------------------------------
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rooms-hop-'))
  const hop = createRoomsHop({
    isAuthorized: (token) => token === 'good-token',
    dataDir,
    log: () => {}
  })
  const daemonServer = http.createServer()
  daemonServer.on('upgrade', (req, socket, head) => {
    if (!hop.handleUpgrade(req, socket, head)) socket.destroy()
  })
  const daemonPort = await listen(daemonServer)

  const subscribe = (
    token = 'good-token'
  ): Promise<{ ws: WebSocket; messages: string[]; status?: number }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/api/rooms/hop?token=${token}`)
      const messages: string[] = []
      ws.on('message', (raw) => messages.push(String(raw)))
      ws.once('unexpected-response', (_req, res) =>
        resolve({ ws, messages, status: res.statusCode })
      )
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'sub', roomId: ROOM_ID, relayUrl, join: 'join-1' }))
        const wait = (): void => {
          if (messages.some((m) => m.includes('sub-ok') || m.includes('sub-error'))) {
            resolve({ ws, messages })
          } else setTimeout(wait, 20)
        }
        wait()
      })
    })

  const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Parses one hop message down to the relay envelope it carries, or
   *  null — the test reads the protocol properly rather than grepping
   *  JSON-escaped strings. */
  const envelopeOf = (m: string): { type?: string; body?: string; ageMs?: number } | null => {
    try {
      const outer = JSON.parse(m) as { type?: string; raw?: string }
      if (outer.type !== 'msg' || typeof outer.raw !== 'string') return null
      return JSON.parse(outer.raw) as { type?: string; body?: string; ageMs?: number }
    } catch {
      return null
    }
  }

  // --- auth ----------------------------------------------------------------
  const refused = await subscribe('bad-token')
  assert.equal(refused.status, 401, 'an unapproved token is refused at the upgrade')

  // --- one upstream for the household --------------------------------------
  const a = await subscribe()
  assert.ok(
    a.messages.some((m) => m.includes('sub-ok')),
    'A subscribes'
  )
  assert.equal(relayConns.length, 1, 'the first subscriber opens the upstream')
  assert.ok(relayConns[0].member?.startsWith('hh-'), 'the upstream presents the householdKey')

  const b = await subscribe()
  assert.equal(relayConns.length, 1, 'the second subscriber SHARES it — that is the feature')
  assert.equal(hop.upstreamCount(), 1)

  // --- send: upstream + local echo -----------------------------------------
  a.messages.length = 0
  b.messages.length = 0
  a.ws.send(JSON.stringify({ type: 'send', roomId: ROOM_ID, body: 'ciphertext-from-a' }))
  await settle()
  assert.deepEqual(relayReceived, ['ciphertext-from-a'], 'the send reaches the relay once')
  assert.ok(
    b.messages.some((m) => {
      const envelope = envelopeOf(m)
      return envelope?.type === 'relay' && envelope.body === 'ciphertext-from-a'
    }),
    'the sibling hears it through the LOCAL echo — the relay never fans to its own connection'
  )
  assert.ok(
    !a.messages.some((m) => m.includes('ciphertext-from-a')),
    'the sender does not hear itself'
  )

  // --- retention for the next local joiner ----------------------------------
  const c = await subscribe()
  assert.ok(
    c.messages.some((m) => {
      const envelope = envelopeOf(m)
      return (
        envelope?.type === 'retained' &&
        envelope.body === 'ciphertext-from-a' &&
        typeof envelope.ageMs === 'number'
      )
    }),
    'a later joiner is handed the household state with retained/ageMs semantics'
  )

  // --- traffic from the wider room reaches everyone -------------------------
  a.messages.length = 0
  b.messages.length = 0
  const remote = new WebSocket(`ws://127.0.0.1:${relayPort}/party/${ROOM_ID}?member=remote-1`)
  await new Promise((resolve) => remote.once('open', resolve))
  remote.send('ciphertext-from-remote')
  await settle()
  for (const [name, client] of [
    ['A', a],
    ['B', b]
  ] as const) {
    assert.ok(
      client.messages.some((m) => m.includes('ciphertext-from-remote')),
      `${name} hears the wider room through the shared upstream`
    )
  }

  // --- teardown --------------------------------------------------------------
  a.ws.close()
  b.ws.close()
  await settle()
  assert.equal(hop.upstreamCount(), 1, 'the upstream survives while anyone local remains')
  c.ws.close()
  await settle(300)
  assert.equal(hop.upstreamCount(), 0, 'the last local unsubscribe closes the upstream')
  assert.equal(
    relayConns.filter((conn) => conn.member?.startsWith('hh-')).length,
    0,
    'the relay sees the household leave'
  )

  // --- the householdKey survives restarts ------------------------------------
  const persisted = JSON.parse(await fsp.readFile(path.join(dataDir, 'rooms-hop.json'), 'utf8'))
  assert.ok(
    String(persisted[ROOM_ID] || '').startsWith('hh-'),
    'the household identity is persisted — a fresh key per boot would lose known-member status'
  )

  remote.close()
  hop.stop()
  relayWss.close()
  await new Promise((resolve) => daemonServer.close(resolve))
  await new Promise((resolve) => relayServer.close(resolve))
  await fsp.rm(dataDir, { recursive: true, force: true })
  console.log('ok  rooms hop')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
