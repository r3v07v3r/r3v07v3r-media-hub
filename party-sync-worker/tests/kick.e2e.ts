// A real kick against the real worker.
//
//   (from party-sync-worker/)  npx wrangler dev --port 8788 --var INVITE_KEY:e2e-test-key
//   (from the repo root)       npx tsx party-sync-worker/tests/kick.e2e.ts
//
// NOT in `npm test` — it needs wrangler dev running. Three connections
// play the three roles: the admin (host token + membership credentials),
// the member being kept, and the member being kicked. It proves the full
// sequence the unit tests can only pin in pieces: admission, ban,
// disconnect-on-kick, the rotated joinSecret refusing the kicked key,
// and the known member's re-admission with the STALE joinSecret.
import crypto from 'node:crypto'
import WebSocket from 'ws'

/** Kicks name hashes, never keys — the same digest the app computes. */
const hashOf = (key: string): string => crypto.createHash('sha256').update(key).digest('hex')

const BASE = 'http://127.0.0.1:8788'
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

function connect(
  roomId: string,
  params: Record<string, string>
): Promise<{ ws: WebSocket; status?: number }> {
  return new Promise((resolve) => {
    const search = new URLSearchParams(params).toString()
    const ws = new WebSocket(`ws://127.0.0.1:8788/party/${roomId}${search ? `?${search}` : ''}`)
    ws.once('open', () => resolve({ ws }))
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }))
    ws.once('error', () => resolve({ ws, status: -1 }))
  })
}

async function main(): Promise<void> {
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

  // --- a party room stays a party room -----------------------------------
  const partyHost = await fetch(`${BASE}/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inviteKey: 'e2e-test-key' })
  })
  const party = (await partyHost.json()) as { roomId: string; joinSecret?: string }
  check('hosting without membership mints none', true, party.joinSecret === undefined)
  const legacy = await connect(party.roomId, {})
  check('a legacy party admits a bare connection', undefined, legacy.status)
  legacy.ws.close()

  // --- admission ----------------------------------------------------------
  const KEPT = 'kept-member-key-0001'
  const KICKED = 'kicked-member-key-01'

  const bare = await connect(roomId, {})
  check('a membership room refuses a bare connection', 403, bare.status)

  const wrongJoin = await connect(roomId, { member: 'stranger-key-00001', join: 'wrong' })
  check('a stranger with the wrong joinSecret is refused', 403, wrongJoin.status)

  const admin = await connect(roomId, {
    token: roomToken,
    member: 'admin-member-key01',
    join: joinSecret
  })
  check('the admin connects', undefined, admin.status)
  const kept = await connect(roomId, { member: KEPT, join: joinSecret })
  check('a member with the current joinSecret is admitted', undefined, kept.status)
  const kicked = await connect(roomId, { member: KICKED, join: joinSecret })
  check('so is the one about to be removed', undefined, kicked.status)

  // --- the kick ------------------------------------------------------------
  const kickedClosed = new Promise<{ code: number }>((resolve) =>
    kicked.ws.once('close', (code) => resolve({ code }))
  )
  const keptClosed = { happened: false }
  kept.ws.once('close', () => {
    keptClosed.happened = true
  })

  const wrongToken = await fetch(`${BASE}/party/${roomId}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomToken: 'not-the-token', memberKeyHashes: [hashOf(KICKED)] })
  })
  check('a kick without the host token is refused', 403, wrongToken.status)

  const kickResponse = await fetch(`${BASE}/party/${roomId}/kick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomToken, memberKeyHashes: [hashOf(KICKED)] })
  })
  check('the admin kick succeeds', 200, kickResponse.status)
  const { joinSecret: rotated } = (await kickResponse.json()) as { joinSecret: string }
  check('the joinSecret rotates', true, typeof rotated === 'string' && rotated !== joinSecret)

  const closed = await kickedClosed
  check('the kicked connection is closed by the relay', 4001, closed.code)

  // --- after the kick ------------------------------------------------------
  const rejoinOld = await connect(roomId, { member: KICKED, join: joinSecret })
  check('the kicked key + old joinSecret is refused', 403, rejoinOld.status)
  const rejoinNew = await connect(roomId, { member: KICKED, join: rotated })
  check('the kicked key is refused even WITH the rotated joinSecret', 403, rejoinNew.status)

  kept.ws.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const keptReturns = await connect(roomId, { member: KEPT, join: joinSecret })
  check(
    'a known member returns on the STALE joinSecret — rotation gates strangers',
    undefined,
    keptReturns.status
  )
  keptReturns.ws.close()

  const stranger = await connect(roomId, { member: 'newcomer-key-00001', join: rotated })
  check('a stranger with the ROTATED joinSecret gets in', undefined, stranger.status)
  stranger.ws.close()

  check('the kept member was never disconnected by the kick', false, keptClosed.happened)
  admin.ws.close()

  console.log('')
  if (failures.length) {
    console.log(`FAILED  ${failures.length} of ${pass + failures.length}`)
    process.exitCode = 1
  } else {
    console.log(`ok  kick end to end (${pass} checks)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
