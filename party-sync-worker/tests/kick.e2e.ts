// Chip-and-tap membership against the real worker.
//
//   (from party-sync-worker/)  npx wrangler dev --port 8788 --var INVITE_KEY:e2e-test-key
//   (from the repo root)       npx tsx party-sync-worker/tests/kick.e2e.ts
//
// NOT in `npm test` — it needs wrangler dev running. This drives the
// full EMV loop with real Ed25519 identities minted by the same
// roomIdentity module production uses, against the worker's own
// WebCrypto verifier: admission by cryptogram, the counter refusing a
// perfect replay, carry hand-offs for a household hop, the kick banning
// an identity outright, and the joinSecret rotation gating strangers
// while known members return on possession proof alone.

import WebSocket from 'ws'

import {
  generateIdentity,
  mintCryptogram,
  type Cryptogram,
  type RoomIdentity
} from '../../src/main/media-hub/roomIdentity'

const BASE = 'http://127.0.0.1:8788'
const HOST = '127.0.0.1:8788'
let pass = 0
const failures: string[] = []

function check(name: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    pass += 1
    console.log(`  ok    ${name}`)
  } else {
    failures.push(name)
    console.log(
      `  FAIL  ${name}\n        expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`
    )
  }
}

let ctr = 0
const tap = (identity: RoomIdentity, purpose: 'admit' | 'carry', roomId: string): Cryptogram =>
  mintCryptogram(identity, purpose, HOST, roomId, ++ctr)

function connect(
  roomId: string,
  params: Record<string, string>
): Promise<{ ws: WebSocket; status?: number; messages: string[] }> {
  return new Promise((resolve) => {
    const search = new URLSearchParams(params).toString()
    const ws = new WebSocket(`ws://${HOST}/party/${roomId}${search ? `?${search}` : ''}`)
    const messages: string[] = []
    ws.on('message', (raw) => messages.push(String(raw)))
    ws.once('open', () => resolve({ ws, messages }))
    ws.once('unexpected-response', (_req, res) => resolve({ ws, messages, status: res.statusCode }))
    ws.once('error', () => resolve({ ws, messages, status: -1 }))
  })
}

const withTap = (
  cryptogram: Cryptogram,
  extra: Record<string, string> = {}
): Record<string, string> => ({
  pub: cryptogram.pub,
  ts: String(cryptogram.ts),
  ctr: String(cryptogram.ctr),
  sig: cryptogram.sig,
  ...extra
})

async function main(): Promise<void> {
  const admin = generateIdentity()
  const kept = generateIdentity()
  const kicked = generateIdentity()
  const hopMember = generateIdentity()

  // --- create a membership room ------------------------------------------
  const host = await fetch(`${BASE}/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteKey: 'e2e-test-key', membership: true })
  })
  const { roomId, roomToken, joinSecret } = (await host.json()) as {
    roomId: string
    roomToken: string
    joinSecret?: string
  }
  check('hosting with membership mints a joinSecret', true, typeof joinSecret === 'string')
  if (!joinSecret) throw new Error('no joinSecret — nothing further can run')

  // --- admission is possession proof, not string knowledge ----------------
  const bare = await connect(roomId, { join: joinSecret })
  check('the joinSecret ALONE admits nobody — no tap, no entry', 403, bare.status)

  const adminConn = await connect(
    roomId,
    withTap(tap(admin, 'admit', roomId), { token: roomToken, join: joinSecret })
  )
  check('the admin taps in', undefined, adminConn.status)

  const keptTap = tap(kept, 'admit', roomId)
  const keptConn = await connect(roomId, withTap(keptTap, { join: joinSecret }))
  check('a member with a genuine tap and the joinSecret is admitted', undefined, keptConn.status)

  // EMV's whole point: a PERFECT copy of a spent tap is worthless.
  const replayed = await connect(roomId, withTap(keptTap, { join: joinSecret }))
  check('a perfectly replayed tap is refused — the counter is spent', 403, replayed.status)

  const keptConn2 = await connect(roomId, withTap(tap(kept, 'admit', roomId), { join: 'wrong' }))
  check(
    'the KNOWN member returns on a fresh tap alone — stale joinSecret and all',
    undefined,
    keptConn2.status
  )
  keptConn2.ws.close()

  const wrongDoor = mintCryptogram(kicked, 'admit', 'other.example.com', roomId, ++ctr)
  const crossDoor = await connect(roomId, withTap(wrongDoor, { join: joinSecret }))
  check('a tap minted for another relay is refused at this one', 403, crossDoor.status)

  // --- the household hop: a carrier connection + a carry frame -------------
  const carrier = await connect(
    roomId,
    withTap(tap(kicked, 'carry', roomId), { carrier: '1', join: joinSecret })
  )
  check("a carrier is admitted on its first member's carry tap", undefined, carrier.status)
  const carryReply = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 3000)
    carrier.ws.on('message', (raw) => {
      const text = String(raw)
      if (text.includes('carry-ok') || text.includes('carry-rejected')) {
        clearTimeout(timer)
        resolve(text.includes('carry-ok') ? 'ok' : 'rejected')
      }
    })
  })
  carrier.ws.send(
    JSON.stringify({ type: 'carry', ...tap(hopMember, 'carry', roomId), join: joinSecret })
  )
  check('a second member is carried after relay verification', 'ok', await carryReply)

  // --- the kick ------------------------------------------------------------
  const wrongToken = await fetch(`${BASE}/party/${roomId}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomToken: 'not-the-token', memberIds: [kicked.id] })
  })
  check('a kick without the host token is refused', 403, wrongToken.status)

  const carrierSawBan = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000)
    carrier.ws.on('message', (raw) => {
      const text = String(raw)
      if (text.includes('"banned"') && text.includes(kicked.id)) {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  const kickResponse = await fetch(`${BASE}/party/${roomId}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomToken, memberIds: [kicked.id] })
  })
  check('the admin kick succeeds', 200, kickResponse.status)
  const { joinSecret: rotated } = (await kickResponse.json()) as { joinSecret: string }
  check('the joinSecret rotates', true, typeof rotated === 'string' && rotated !== joinSecret)
  check(
    'the carrier hears the banned broadcast — its enforcement order for the hop',
    true,
    await carrierSawBan
  )

  // --- after the kick ------------------------------------------------------
  const kickedFresh = await connect(
    roomId,
    withTap(tap(kicked, 'admit', roomId), { join: rotated })
  )
  check(
    'the kicked identity is refused even with a FRESH tap and the ROTATED joinSecret',
    403,
    kickedFresh.status
  )

  const keptReturns = await connect(
    roomId,
    withTap(tap(kept, 'admit', roomId), { join: joinSecret })
  )
  check(
    'a known member returns on the STALE joinSecret — rotation gates strangers',
    undefined,
    keptReturns.status
  )
  keptReturns.ws.close()

  const strangerId = generateIdentity()
  const stranger = await connect(
    roomId,
    withTap(tap(strangerId, 'admit', roomId), { join: rotated })
  )
  check('a stranger with a tap and the ROTATED joinSecret gets in', undefined, stranger.status)
  stranger.ws.close()

  // --- a party room stays a party room -----------------------------------
  const partyHost = await fetch(`${BASE}/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteKey: 'e2e-test-key' })
  })
  const party = (await partyHost.json()) as { roomId: string; joinSecret?: string }
  check('hosting without membership mints no joinSecret', true, party.joinSecret === undefined)
  const legacy = await connect(party.roomId, {})
  check('a legacy party admits a bare connection', undefined, legacy.status)
  legacy.ws.close()

  keptConn.ws.close()
  carrier.ws.close()
  adminConn.ws.close()

  console.log('')
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${pass + failures.length}`)
    process.exitCode = 1
  } else {
    console.log(`ok  chip-and-tap end to end (${pass} checks)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
