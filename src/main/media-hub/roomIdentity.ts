// Chip-and-tap identity for rooms.
//
// The model is the one EMV bank cards use, asked for by name: a private
// key that never leaves the device, and one-time cryptograms — a
// signature over the relay, the room, the moment and a monotonic
// counter — that a terminal (the cache-server hop) can forward but
// never forge, and the issuer (the relay worker) verifies. Intercept a
// cryptogram and you hold a receipt, not a card.
//
// One deliberate upgrade over EMV's symmetric scheme: Ed25519, so the
// verifiers hold nothing that could forge. And one thing EMV cannot do
// at all: every ROOM MESSAGE is signed by its sender before it is
// encrypted, so even the people who share the room secret cannot speak
// as each other. Readability and identity part ways — a leaked room
// secret leaks words, never a voice.
//
// THE IDENTITY IS THE KEY. A member's id is the sha256 of their public
// key, so claiming an id without its private key is impossible: nothing
// you say verifies. This is what lets three separate concepts from the
// bearer-string era (friendId, memberKey, memberKeyHash) collapse into
// one, with no registry and no first-use leap of faith. (The names
// friendId/memberKey/memberKeyHash date that era; only friendId
// survives, and it now means this hash.)
//
// This module is pure: keys in, bytes out. Nothing here reads settings,
// sockets or Electron — persistence belongs to the caller, which is
// what lets the whole scheme be tested (and mutation-tested) directly.

import crypto from 'node:crypto'

export interface RoomIdentity {
  /** 64-hex sha256 of the raw public key — the member's id everywhere. */
  id: string
  /** Raw 32-byte Ed25519 public key, base64url. Travels with every
   *  signed message and cryptogram; it is public by definition. */
  pub: string
  privateKey: crypto.KeyObject
  publicKey: crypto.KeyObject
}

/** How far a cryptogram's timestamp may sit from the verifier's clock.
 *  Generous for real clock skew, tight enough that a captured cryptogram
 *  goes stale before it is useful — and the counter kills it anyway. */
export const CRYPTOGRAM_FRESHNESS_MS = 5 * 60 * 1000

const RAW_PUB_BYTES = 32
/** DER prefix for an Ed25519 SPKI public key — the 12 bytes node's
 *  exporter puts in front of the raw 32. Fixed by RFC 8410. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function rawPublicKey(publicKey: crypto.KeyObject): Buffer {
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(der.length - RAW_PUB_BYTES))
}

export function publicKeyFromRaw(pubB64: string): crypto.KeyObject | null {
  try {
    const raw = Buffer.from(pubB64, 'base64url')
    if (raw.length !== RAW_PUB_BYTES) return null
    return crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki'
    })
  } catch {
    return null
  }
}

export function idOfRawPub(pubB64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64url')).digest('hex')
}

export function generateIdentity(): RoomIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return identityFromKeys(privateKey, publicKey)
}

/** Rebuilds an identity from a persisted private key (PKCS8 DER,
 *  base64) — the public half is derived, never stored separately, so
 *  the two cannot drift apart. */
export function identityFromPrivateDer(privateDerB64: string): RoomIdentity | null {
  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(privateDerB64, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
    return identityFromKeys(privateKey, crypto.createPublicKey(privateKey))
  } catch {
    return null
  }
}

export function exportPrivateDer(identity: RoomIdentity): string {
  return identity.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
}

function identityFromKeys(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject): RoomIdentity {
  const pub = rawPublicKey(publicKey).toString('base64url')
  return { id: idOfRawPub(pub), pub, privateKey, publicKey }
}

// --- cryptograms — the tap ---------------------------------------------------

export type CryptogramPurpose = 'admit' | 'carry'

export interface Cryptogram {
  pub: string
  ts: number
  ctr: number
  sig: string
}

/** The exact bytes both sides sign and verify. Binding the relay host
 *  and the room into the signature is what makes a captured cryptogram
 *  worthless anywhere but the one door it was minted for. */
export function cryptogramData(
  purpose: CryptogramPurpose,
  relayHost: string,
  roomId: string,
  ts: number,
  ctr: number
): Buffer {
  return Buffer.from(`${purpose}|${relayHost}|${roomId.toLowerCase()}|${ts}|${ctr}`, 'utf8')
}

export function mintCryptogram(
  identity: RoomIdentity,
  purpose: CryptogramPurpose,
  relayHost: string,
  roomId: string,
  ctr: number,
  ts = Date.now()
): Cryptogram {
  const sig = crypto
    .sign(null, cryptogramData(purpose, relayHost, roomId, ts, ctr), identity.privateKey)
    .toString('base64url')
  return { pub: identity.pub, ts, ctr, sig }
}

/** Client-side mirror of the worker's verification, used by tests and
 *  by the daemon when it wants to fail fast on garbage before wasting a
 *  relay round-trip. The COUNTER floor lives with whoever persists
 *  counters (the worker); this checks everything stateless. */
export function verifyCryptogram(
  cryptogram: Cryptogram,
  purpose: CryptogramPurpose,
  relayHost: string,
  roomId: string,
  now = Date.now()
): { ok: true; id: string } | { ok: false; reason: string } {
  if (Math.abs(now - cryptogram.ts) > CRYPTOGRAM_FRESHNESS_MS) {
    return { ok: false, reason: 'stale' }
  }
  const publicKey = publicKeyFromRaw(cryptogram.pub)
  if (!publicKey) return { ok: false, reason: 'bad key' }
  const data = cryptogramData(purpose, relayHost, roomId, cryptogram.ts, cryptogram.ctr)
  let valid = false
  try {
    valid = crypto.verify(null, data, publicKey, Buffer.from(cryptogram.sig, 'base64url'))
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'bad signature' }
  return { ok: true, id: idOfRawPub(cryptogram.pub) }
}

// --- signed room messages ----------------------------------------------------
//
// Sign-then-encrypt: the signature goes over the plaintext, and the
// whole envelope is then AES-GCM'd with the room secret exactly as
// before. The relay and the hop still see only ciphertext; members see
// proof of who spoke.

export interface SignedEnvelope {
  b: Record<string, unknown>
  from: string
  pub: string
  ts: number
  /** Per-sender monotonic. What makes yesterday's captured announcement
   *  unplayable today — the message-layer ATC. */
  seq: number
  sig: string
}

/** Deterministic encoding of the signed surface. JSON.stringify with
 *  sorted keys, because two honest serializers disagreeing about key
 *  order must not read as forgery. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function signedSurface(roomId: string, envelope: Omit<SignedEnvelope, 'sig'>): Buffer {
  return Buffer.from(
    `${roomId.toLowerCase()}|${envelope.from}|${envelope.ts}|${envelope.seq}|${canonical(envelope.b)}`,
    'utf8'
  )
}

export function signRoomMessage(
  identity: RoomIdentity,
  roomId: string,
  body: Record<string, unknown>,
  seq: number,
  ts = Date.now()
): SignedEnvelope {
  const unsigned = { b: body, from: identity.id, pub: identity.pub, ts, seq }
  const sig = crypto
    .sign(null, signedSurface(roomId, unsigned), identity.privateKey)
    .toString('base64url')
  return { ...unsigned, sig }
}

/**
 * Verifies one decrypted room message.
 *
 * Three checks, each closing its own door:
 *  - the signature verifies against the carried public key (no forgery);
 *  - sha256(pub) equals the CLAIMED sender id (no wearing someone
 *    else's id over your own valid key);
 *  - `seq` is strictly above the last seen from this sender (no
 *    replaying an old, genuinely-signed message).
 *
 * `lastSeq` is the caller's per-sender high-water mark; undefined means
 * first contact, which is always acceptable — the identity is
 * self-certifying, so there is no first-use leap of faith to take.
 */
export function verifyRoomMessage(
  roomId: string,
  envelope: SignedEnvelope,
  lastSeq: number | undefined
): { ok: true; from: string; body: Record<string, unknown> } | { ok: false; reason: string } {
  if (
    typeof envelope !== 'object' ||
    typeof envelope.from !== 'string' ||
    typeof envelope.pub !== 'string' ||
    typeof envelope.sig !== 'string' ||
    typeof envelope.seq !== 'number' ||
    !envelope.b ||
    typeof envelope.b !== 'object'
  ) {
    return { ok: false, reason: 'malformed' }
  }
  if (idOfRawPub(envelope.pub) !== envelope.from) return { ok: false, reason: 'id mismatch' }
  const publicKey = publicKeyFromRaw(envelope.pub)
  if (!publicKey) return { ok: false, reason: 'bad key' }
  let valid = false
  try {
    valid = crypto.verify(
      null,
      signedSurface(roomId, envelope),
      publicKey,
      Buffer.from(envelope.sig, 'base64url')
    )
  } catch {
    valid = false
  }
  if (!valid) return { ok: false, reason: 'bad signature' }
  if (lastSeq !== undefined && envelope.seq <= lastSeq) return { ok: false, reason: 'replay' }
  return { ok: true, from: envelope.from, body: envelope.b }
}
