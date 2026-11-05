import assert from 'node:assert'
import { serialize } from 'node:v8'
import {
  admissionVerdict,
  isRelayMessageWithinLimit,
  MAX_KNOWN_MEMBERS,
  MAX_RELAY_MESSAGES_PER_WINDOW,
  MAX_RELAY_MESSAGE_BYTES,
  nextRelayMessageRate,
  PartyRoom,
  RELAY_RATE_WINDOW_MS
} from '../party-sync-worker/src/room.ts'

let pass = 0

function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

console.log('party relay message bounds')
check('allows a payload at the byte limit', () =>
  assert.equal(isRelayMessageWithinLimit('a'.repeat(MAX_RELAY_MESSAGE_BYTES)), true)
)
check('rejects a payload one byte above the limit', () =>
  assert.equal(isRelayMessageWithinLimit('a'.repeat(MAX_RELAY_MESSAGE_BYTES + 1)), false)
)
check('counts UTF-8 bytes instead of JavaScript code units', () =>
  assert.equal(
    isRelayMessageWithinLimit('😀'.repeat(Math.ceil(MAX_RELAY_MESSAGE_BYTES / 2))),
    false
  )
)
check('enforces a per-connection message rate', () => {
  const startedAt = 1_000
  const atLimit = nextRelayMessageRate(startedAt, MAX_RELAY_MESSAGES_PER_WINDOW - 1, startedAt + 1)
  assert.equal(atLimit.allowed, true)
  const overLimit = nextRelayMessageRate(
    atLimit.windowStartedAt,
    atLimit.windowMessageCount,
    startedAt + 2
  )
  assert.equal(overLimit.allowed, false)
})
check('resets a message rate after its window closes', () => {
  const rate = nextRelayMessageRate(
    1_000,
    MAX_RELAY_MESSAGES_PER_WINDOW,
    1_000 + RELAY_RATE_WINDOW_MS
  )
  assert.deepEqual(rate, {
    allowed: true,
    windowStartedAt: 1_000 + RELAY_RATE_WINDOW_MS,
    windowMessageCount: 1
  })
})

// --- the membership gate ----------------------------------------------------
//
// The admission POLICY, given an identity the cryptogram layer has
// already VERIFIED (signature, freshness, counter — pinned separately
// in tests/rooms.test.ts against the client mirror, and end-to-end in
// kick.e2e.ts against this worker's own verifier). Each row closes a
// specific door — docs/ROOMS.md names them.

const ID = 'a'.repeat(64)
const OTHER_ID = 'b'.repeat(64)
const JOIN = 'join-secret-current'

check('a legacy room (no joinSecret) admits anyone, as it always has', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: null,
      verifiedId: null,
      presentedJoinSecret: null,
      known: new Set(),
      banned: new Set()
    }),
    'admit'
  )
})

check('a membership room refuses a connection with no verified identity', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: null,
      presentedJoinSecret: JOIN,
      known: new Set(),
      banned: new Set()
    }),
    'refuse',
    'the joinSecret alone admits nobody — possession proof is not optional'
  )
})

check('banned wins over everything — even the current joinSecret', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: ID,
      presentedJoinSecret: JOIN,
      known: new Set([ID]),
      banned: new Set([ID])
    }),
    'refuse'
  )
})

check(
  'a known identity is admitted with a STALE joinSecret — rotation gates strangers, not members',
  () => {
    assert.strictEqual(
      admissionVerdict({
        currentJoinSecret: JOIN,
        verifiedId: ID,
        presentedJoinSecret: 'stale-after-a-kick',
        known: new Set([ID]),
        banned: new Set()
      }),
      'admit'
    )
  }
)

check('a stranger with the current joinSecret is admitted and registered', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: OTHER_ID,
      presentedJoinSecret: JOIN,
      known: new Set([ID]),
      banned: new Set()
    }),
    'admit-and-register'
  )
})

check('a stranger without it is refused', () => {
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: OTHER_ID,
      presentedJoinSecret: 'stale-or-guessed',
      known: new Set([ID]),
      banned: new Set()
    }),
    'refuse'
  )
})

check('registration stops at the cap — a room of 256 installs is not a household', () => {
  const known = new Set<string>()
  for (let i = 0; i < MAX_KNOWN_MEMBERS; i++) known.add(String(i).padStart(64, '0'))
  assert.strictEqual(
    admissionVerdict({
      currentJoinSecret: JOIN,
      verifiedId: 'c'.repeat(64),
      presentedJoinSecret: JOIN,
      known,
      banned: new Set()
    }),
    'refuse'
  )
})

// --- retention never costs a message -----------------------------------------
//
// The room keeps each connection's last message in that socket's
// attachment, and the runtime refuses an attachment over 16 KiB once
// serialized (workerd says so in as many words), far below the 60 KiB a
// message may be. These sockets refuse the same way, measured with the
// same V8 serializer, so webSocketMessage runs as it does on Cloudflare.
// Checked against wrangler dev too: before the fix a 20 KB body reached
// nobody and the sender saw no close code.

const ATTACHMENT_LIMIT_BYTES = 16 * 1024

type RoomState = ConstructorParameters<typeof PartyRoom>[0]
type RoomSocket = Parameters<PartyRoom['webSocketMessage']>[0]

interface FakeSocket {
  attachment: Record<string, unknown>
  sent: string[]
  closeCode: number | null
  serializeAttachment(value: Record<string, unknown>): void
  deserializeAttachment(): Record<string, unknown>
  send(message: string): void
  close(code: number): void
}

function fakeSocket(connId: string): FakeSocket {
  const socket: FakeSocket = {
    attachment: { connId, isHost: false },
    sent: [],
    closeCode: null,
    serializeAttachment(value) {
      const bytes = serialize(value).byteLength
      if (bytes > ATTACHMENT_LIMIT_BYTES) {
        throw new Error(`A WebSocket 'attachment' cannot be larger than ${ATTACHMENT_LIMIT_BYTES}`)
      }
      socket.attachment = structuredClone(value)
    },
    deserializeAttachment: () => structuredClone(socket.attachment),
    send(message) {
      socket.sent.push(message)
    },
    close(code) {
      socket.closeCode = code
    }
  }
  return socket
}

function roomOf(sockets: FakeSocket[]): PartyRoom {
  const state = { getWebSockets: () => sockets, storage: { setAlarm: async () => {} } }
  return new PartyRoom(state as unknown as RoomState)
}

function sendFrom(room: PartyRoom, socket: FakeSocket, body: string): Promise<void> {
  return room.webSocketMessage(socket as unknown as RoomSocket, body)
}

function relayedTo(socket: FakeSocket): string[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; body?: string })
    .filter((message) => message.type === 'relay')
    .map((message) => message.body ?? '')
}

/** Shaped like party.ts's encryptMessage output: base64 inside JSON. */
const ciphertext = (chars: number): string =>
  JSON.stringify({ iv: 'i'.repeat(16), ct: 'A'.repeat(chars), tag: 't'.repeat(24) })

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

async function retentionChecks(): Promise<void> {
  await checkAsync('a message too big to retain is still relayed to everyone else', async () => {
    const sender = fakeSocket('sender')
    const others = [fakeSocket('a'), fakeSocket('b')]
    const room = roomOf([sender, ...others])
    const body = ciphertext(20_000)
    assert.equal(isRelayMessageWithinLimit(body), true, 'inside the relay limit')
    assert.ok(serialize({ last: body }).byteLength > ATTACHMENT_LIMIT_BYTES, 'over the cap')
    await sendFrom(room, sender, body)
    for (const other of others) assert.deepEqual(relayedTo(other), [body])
    assert.equal(sender.closeCode, null)
  })

  await checkAsync('a message that fits is retained for later joiners', async () => {
    const sender = fakeSocket('sender')
    const room = roomOf([sender, fakeSocket('a')])
    const body = ciphertext(1_000)
    await sendFrom(room, sender, body)
    assert.equal(sender.attachment.last, body)
    assert.equal(typeof sender.attachment.lastAt, 'number')
  })

  await checkAsync(
    'a message too big to retain takes the older retained one with it, and still counts toward the rate',
    async () => {
      const sender = fakeSocket('sender')
      const room = roomOf([sender, fakeSocket('a')])
      await sendFrom(room, sender, ciphertext(1_000))
      await sendFrom(room, sender, ciphertext(40_000))
      assert.equal(sender.attachment.last, undefined, 'no stale state replayed to a joiner')
      assert.equal(sender.attachment.lastAt, undefined)
      assert.equal(sender.attachment.connId, 'sender')
      assert.equal(sender.attachment.rateWindowMessageCount, 2)
    }
  )
}

void retentionChecks().then(() => console.log(`\n${pass} passed`))
