// Ported from r3v07v3r-media-hub's src/party.cjs. This is the Watch Party
// encryption/validation layer (AES-256-GCM message crypto, LAN/WAN and
// relay endpoint validation, share-code encode/decode, queue voting) —
// every validation branch (ip regex, roomId UUID regex, https-only relay
// check, base64url encode/decode, AES-256-GCM iv/tag handling) is
// preserved EXACTLY from the original. Do not "simplify" or restructure
// the crypto/validation logic here; correctness matters more than
// elegance in this file.

import crypto from 'node:crypto'
import type { PartyQueueEntry } from '../../shared/media-hub/types'
import { idOfRawPub } from './roomIdentity'

export interface PartyLanEndpoint {
  ip: string
  port: number
}

export interface PartyRelayEndpoint {
  url: string
  roomId: string
}

export interface ShareCodePayloadV1 {
  v: 1
  lan: PartyLanEndpoint
  wan: PartyLanEndpoint | null
  secret: string
  name: string
}

export interface ShareCodePayloadV2 {
  v: 2
  relay: PartyRelayEndpoint
  secret: string
  name: string
}

/**
 * A room code with a chip-and-tap admin: the relay endpoint, the room
 * secret, and the admin's PUBLIC KEY, which is what turns "the admin
 * renamed the room" and "the admin rotated the secret" from claims into
 * verifiable statements. The admin's id is sha256 of this key — and the
 * encoding does not carry the id at all, so the two cannot disagree.
 */
export interface ShareCodePayloadV4 {
  v: 4
  relay: PartyRelayEndpoint
  secret: string
  name: string
  admin: { id: string; pub: string }
  join?: string
}

/**
 * A hybrid party invite: every way into the party in one code. The host
 * always listens directly and (when configured) attaches to the relay too,
 * so the joiner — not the host — decides the transport, by simply using the
 * first one that connects: LAN, then WAN, then relay. This is what removed
 * the Direct/Relay picker from hosting.
 */
export interface ShareCodePayloadV5 {
  v: 5
  lan: PartyLanEndpoint
  wan: PartyLanEndpoint | null
  relay: PartyRelayEndpoint
  secret: string
  name: string
}

export type ShareCodePayload =
  ShareCodePayloadV1 | ShareCodePayloadV2 | ShareCodePayloadV4 | ShareCodePayloadV5

export type PartyQueueEvent =
  | { type: 'suggest'; queueId: string; item: PartyQueueEntry['item']; suggestedBy?: string }
  | { type: 'remove'; queueId: string }
  | { type: 'vote'; queueId: string; voterId: string; direction: number }
  | { type: 'queue-sync'; queue: PartyQueueEntry[] }

export function isValidEndpoint(endpoint: unknown): endpoint is PartyLanEndpoint {
  const e = endpoint as { ip?: unknown; port?: unknown } | null | undefined
  if (!e || typeof e.ip !== 'string' || !Number.isInteger(e.port)) return false
  if ((e.port as number) < 1 || (e.port as number) > 65535) return false
  return /^[a-zA-Z0-9.:%-]{1,64}$/.test(e.ip)
}

export function isValidRelayEndpoint(endpoint: unknown): endpoint is PartyRelayEndpoint {
  const e = endpoint as { url?: unknown; roomId?: unknown } | null | undefined
  if (!e || typeof e.url !== 'string' || typeof e.roomId !== 'string') return false
  if (
    e.url.length > 300 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.roomId)
  ) {
    return false
  }
  try {
    return new URL(e.url).protocol === 'https:'
  } catch {
    return false
  }
}

// --- Compact wire format ----------------------------------------------------
// The JSON codes above are readable but long: a relay party invite ran to
// roughly 185 characters to copy by hand. The compact form carries the same
// fields as packed bytes — the roomId as its 16 raw UUID bytes instead of 36
// hex characters, IPv4 addresses as 4 bytes, the relay URL without its
// (always https) scheme, and no host display name, which the joiner learns
// from the first party-state broadcast instead. Relay codes land around 96
// characters, direct ones around 54.
//
// This is a packing of the v1/v2 payloads, NOT a new payload version — the
// v3/v4 numbers above belong to the room codes. The leading byte is a format
// tag that cannot collide with a JSON code, because those always begin with
// '{' (0x7b). Decoding stays fail-closed: every compact payload is rebuilt
// into the v1/v2 shape and re-validated through isValidEndpoint /
// isValidRelayEndpoint before it is returned, so callers see exactly the
// payloads they saw before. The encoders fall back to the JSON form whenever
// anything does not fit the compact layout — a short code is never worth an
// unjoinable party.

const SHARE_COMPACT_DIRECT = 0x31
const SHARE_COMPACT_RELAY = 0x32
const SHARE_COMPACT_ROOM = 0x33
const SHARE_COMPACT_HYBRID = 0x34
const SHARE_COMPACT_SECRET_BYTES = 24
const SHARE_COMPACT_IPV4_TAG = 0
/** Raw Ed25519 public key — see roomIdentity's RAW_PUB_BYTES. */
const SHARE_COMPACT_PUB_BYTES = 32
const SHARE_COMPACT_JOIN_FLAG = 0x01

/** The secret only fits the compact form if it is exactly the 24 random bytes
 *  the host mints, encoded canonically — anything else would not round-trip
 *  byte for byte and the joiner would derive a different key. */
function shareSecretBytes(secret: string): Buffer | null {
  const buf = Buffer.from(String(secret || ''), 'base64url')
  if (buf.length !== SHARE_COMPACT_SECRET_BYTES) return null
  if (buf.toString('base64url') !== secret) return null
  return buf
}

/** `[hostLen:1][host][port:2 BE]`, where a length of 0 means the next four
 *  bytes are a raw IPv4 address. Any other host (IPv6, a `%zone` suffix) is
 *  kept as its UTF-8 text, which is longer but still correct. */
function encodeEndpointCompact(endpoint: PartyLanEndpoint): Buffer | null {
  const octets = endpoint.ip.split('.')
  const isIpv4 =
    octets.length === 4 &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) >= 0 && Number(o) <= 255)
  const host = isIpv4 ? Buffer.from(octets.map((o) => Number(o))) : Buffer.from(endpoint.ip, 'utf8')
  if (host.length < 1 || host.length > 255) return null
  const out = Buffer.alloc(1 + host.length + 2)
  out[0] = isIpv4 ? SHARE_COMPACT_IPV4_TAG : host.length
  host.copy(out, 1)
  out.writeUInt16BE(endpoint.port, 1 + host.length)
  return out
}

function readEndpointCompact(buf: Buffer, cursor: { at: number }): PartyLanEndpoint | null {
  if (cursor.at >= buf.length) return null
  const len = buf[cursor.at]
  cursor.at += 1
  const size = len === SHARE_COMPACT_IPV4_TAG ? 4 : len
  if (cursor.at + size + 2 > buf.length) return null
  const ip =
    len === SHARE_COMPACT_IPV4_TAG
      ? [...buf.subarray(cursor.at, cursor.at + 4)].join('.')
      : buf.subarray(cursor.at, cursor.at + size).toString('utf8')
  cursor.at += size
  const port = buf.readUInt16BE(cursor.at)
  cursor.at += 2
  return { ip, port }
}

/** A direct LAN/WAN party invite, packed. Every rejection below is an
 *  invariant violation rather than an ordinary input: the secret is always
 *  the 24 bytes the host just minted, and isValidEndpoint already caps an
 *  ip at 64 characters. There is no longer a longer encoding to retreat to,
 *  so a violation is raised rather than papered over. */
export function encodeShareCode(input: {
  lan: PartyLanEndpoint
  wan?: PartyLanEndpoint | null
  secret: string
}): string {
  const { lan, wan, secret } = input
  if (!isValidEndpoint(lan) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid party endpoint.')
  }
  const validWan = wan && isValidEndpoint(wan) ? wan : null
  const bytes = shareSecretBytes(secret)
  const lanPart = encodeEndpointCompact(lan)
  const wanPart = validWan ? encodeEndpointCompact(validWan) : Buffer.alloc(0)
  if (!bytes) throw new Error('A party secret must be 24 bytes, base64url.')
  if (!lanPart || !wanPart) throw new Error('Invalid party endpoint.')
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_DIRECT]),
    lanPart,
    Buffer.from([validWan ? 1 : 0]),
    wanPart,
    bytes
  ]).toString('base64url')
}

/** A relay party invite, packed. As above, a rejection here is an invariant
 *  violation, not a longer-code case. */
export function encodeRelayShareCode(input: { relay: PartyRelayEndpoint; secret: string }): string {
  const { relay, secret } = input
  if (!isValidRelayEndpoint(relay) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid party endpoint.')
  }
  const bytes = shareSecretBytes(secret)
  const hostBytes = relayHostBytes(relay.url)
  const roomId = uuidBytes(relay.roomId)
  if (!bytes) throw new Error('A party secret must be 24 bytes, base64url.')
  if (!hostBytes || !roomId) throw new Error('Invalid party endpoint.')
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_RELAY]),
    roomId,
    encodeRelayHostLength(hostBytes),
    hostBytes,
    bytes
  ]).toString('base64url')
}

/** A hybrid party invite, packed: `[0x34][lan][wanFlag][wan?][roomId:16]
 *  [hostLen:2][host][secret:24]` — the direct code's endpoint layout
 *  followed by the relay code's endpoint layout, one secret for both
 *  (every transport carries the same AES-GCM payloads). Same invariant
 *  discipline as the two codes it combines. */
export function encodeHybridShareCode(input: {
  lan: PartyLanEndpoint
  wan?: PartyLanEndpoint | null
  relay: PartyRelayEndpoint
  secret: string
}): string {
  const { lan, wan, relay, secret } = input
  if (!isValidEndpoint(lan) || !isValidRelayEndpoint(relay) || typeof secret !== 'string') {
    throw new Error('Invalid party endpoint.')
  }
  const validWan = wan && isValidEndpoint(wan) ? wan : null
  const bytes = shareSecretBytes(secret)
  const lanPart = encodeEndpointCompact(lan)
  const wanPart = validWan ? encodeEndpointCompact(validWan) : Buffer.alloc(0)
  const roomId = uuidBytes(relay.roomId)
  const hostBytes = relayHostBytes(relay.url)
  if (!bytes) throw new Error('A party secret must be 24 bytes, base64url.')
  if (!lanPart || !wanPart || !roomId || !hostBytes) throw new Error('Invalid party endpoint.')
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_HYBRID]),
    lanPart,
    Buffer.from([validWan ? 1 : 0]),
    wanPart,
    roomId,
    encodeRelayHostLength(hostBytes),
    hostBytes,
    bytes
  ]).toString('base64url')
}

/** A UUID packs to its 16 raw bytes; anything else does not fit. */
function uuidBytes(value: string): Buffer | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null
  return Buffer.from(value.replace(/-/g, ''), 'hex')
}

function uuidFromBytes(buf: Buffer): string {
  const hex = buf.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The relay URL travels without its scheme, which is always https (the
 *  endpoint validators refuse anything else) and would otherwise cost eight
 *  bytes in every code. The length is two bytes rather than one so the whole
 *  domain isValidRelayEndpoint admits (up to 300 characters) packs — with a
 *  one-byte length a legitimate long worker URL would have had nowhere to
 *  go once the JSON encoders were removed. */
function relayHostBytes(url: string): Buffer | null {
  if (!/^https:\/\//i.test(url)) return null
  const host = Buffer.from(url.replace(/^https:\/\//i, '').replace(/\/+$/, ''), 'utf8')
  return host.length >= 1 && host.length <= 0xffff ? host : null
}

function encodeRelayHostLength(host: Buffer): Buffer {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(host.length)
  return out
}

/** A room invite, packed.
 *
 *  The admin's id is NOT carried: it is the sha256 of the public key that is
 *  carried, so the decoder recomputes it. The payload's own promise — the id
 *  and the key cannot disagree — becomes structural rather than checked, and
 *  it saves 32 bytes. An id that contradicts its key is therefore not an
 *  encodable room: it is raised here rather than silently rewritten to
 *  agree, because a caller holding a mismatched pair has a bug worth
 *  hearing about. */
export function encodeRoomShareCode(input: {
  relay: PartyRelayEndpoint
  secret: string
  name: string
  admin: { id: string; pub: string }
  join?: string
}): string {
  const { relay, secret, name, admin, join } = input
  if (!isValidRelayEndpoint(relay) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid room endpoint.')
  }
  if (!admin?.id || !admin?.pub) {
    throw new Error('A room code names its admin.')
  }
  const roomName = String(name || '').slice(0, 40)
  const nameBytes = Buffer.from(roomName, 'utf8')
  const secretBuf = shareSecretBytes(secret)
  const roomId = uuidBytes(relay.roomId)
  const host = relayHostBytes(relay.url)
  const pub = Buffer.from(admin.pub, 'base64url')
  const joinBuf = join ? uuidBytes(String(join)) : null
  if (!secretBuf) throw new Error('A room secret must be 24 bytes, base64url.')
  if (!roomId || !host) throw new Error('Invalid room endpoint.')
  if (pub.length !== SHARE_COMPACT_PUB_BYTES || pub.toString('base64url') !== admin.pub) {
    throw new Error("A room admin's key must be a raw Ed25519 public key, base64url.")
  }
  if (idOfRawPub(admin.pub) !== admin.id) {
    throw new Error("A room admin's id must be the sha256 of its public key.")
  }
  if (join && !joinBuf) throw new Error('A room join secret must be a UUID.')
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_ROOM]),
    roomId,
    secretBuf,
    pub,
    Buffer.from([joinBuf ? SHARE_COMPACT_JOIN_FLAG : 0]),
    joinBuf || Buffer.alloc(0),
    encodeRelayHostLength(host),
    host,
    Buffer.from([nameBytes.length]),
    nameBytes
  ]).toString('base64url')
}

/** Reads `[hostLen:2 BE][host]` and rebuilds the https URL the encoder
 *  stripped. Returns null rather than a truncated read if the length runs
 *  past the buffer — every caller treats null as "not a code". */
function readRelayHost(buf: Buffer, cursor: { at: number }): string | null {
  if (cursor.at + 2 > buf.length) return null
  const len = buf.readUInt16BE(cursor.at)
  cursor.at += 2
  if (len < 1 || cursor.at + len > buf.length) return null
  const host = buf.subarray(cursor.at, cursor.at + len).toString('utf8')
  cursor.at += len
  return `https://${host}`
}

function decodeCompactShareCode(buf: Buffer): ShareCodePayload | null {
  if (buf[0] === SHARE_COMPACT_ROOM) {
    const cursor = { at: 1 }
    const need = 16 + SHARE_COMPACT_SECRET_BYTES + SHARE_COMPACT_PUB_BYTES + 1
    if (buf.length < cursor.at + need) return null
    const roomId = uuidFromBytes(buf.subarray(cursor.at, cursor.at + 16))
    cursor.at += 16
    const secret = buf.subarray(cursor.at, cursor.at + SHARE_COMPACT_SECRET_BYTES)
    cursor.at += SHARE_COMPACT_SECRET_BYTES
    const pub = buf.subarray(cursor.at, cursor.at + SHARE_COMPACT_PUB_BYTES)
    cursor.at += SHARE_COMPACT_PUB_BYTES
    const hasJoin = buf[cursor.at] === SHARE_COMPACT_JOIN_FLAG
    cursor.at += 1
    let join = ''
    if (hasJoin) {
      if (cursor.at + 16 > buf.length) return null
      join = uuidFromBytes(buf.subarray(cursor.at, cursor.at + 16))
      cursor.at += 16
    }
    const url = readRelayHost(buf, cursor)
    if (url === null || cursor.at >= buf.length) return null
    const relay: PartyRelayEndpoint = { url, roomId }
    const nameLen = buf[cursor.at]
    cursor.at += 1
    if (buf.length !== cursor.at + nameLen) return null
    if (!isValidRelayEndpoint(relay)) return null
    const pubB64 = pub.toString('base64url')
    return {
      v: 4,
      relay,
      secret: secret.toString('base64url'),
      name: buf.subarray(cursor.at).toString('utf8'),
      // Recomputed, never carried — see encodeRoomShareCode.
      admin: { id: idOfRawPub(pubB64), pub: pubB64 },
      ...(hasJoin ? { join } : {})
    }
  }
  if (buf[0] === SHARE_COMPACT_RELAY) {
    const cursor = { at: 1 }
    if (buf.length < cursor.at + 16) return null
    const roomId = uuidFromBytes(buf.subarray(cursor.at, cursor.at + 16))
    cursor.at += 16
    const url = readRelayHost(buf, cursor)
    if (url === null) return null
    const relay: PartyRelayEndpoint = { url, roomId }
    if (buf.length !== cursor.at + SHARE_COMPACT_SECRET_BYTES) return null
    if (!isValidRelayEndpoint(relay)) return null
    return {
      v: 2,
      relay,
      secret: buf.subarray(cursor.at).toString('base64url'),
      name: ''
    }
  }
  if (buf[0] === SHARE_COMPACT_HYBRID) {
    const cursor = { at: 1 }
    const lan = readEndpointCompact(buf, cursor)
    if (!lan || cursor.at >= buf.length) return null
    const hasWan = buf[cursor.at] === 1
    cursor.at += 1
    const wan = hasWan ? readEndpointCompact(buf, cursor) : null
    if (hasWan && !wan) return null
    if (cursor.at + 16 > buf.length) return null
    const roomId = uuidFromBytes(buf.subarray(cursor.at, cursor.at + 16))
    cursor.at += 16
    const url = readRelayHost(buf, cursor)
    if (url === null) return null
    const relay: PartyRelayEndpoint = { url, roomId }
    if (buf.length !== cursor.at + SHARE_COMPACT_SECRET_BYTES) return null
    if (!isValidEndpoint(lan) || (wan && !isValidEndpoint(wan))) return null
    if (!isValidRelayEndpoint(relay)) return null
    return {
      v: 5,
      lan,
      wan,
      relay,
      secret: buf.subarray(cursor.at).toString('base64url'),
      name: ''
    }
  }
  if (buf[0] !== SHARE_COMPACT_DIRECT) return null
  const cursor = { at: 1 }
  const lan = readEndpointCompact(buf, cursor)
  if (!lan || cursor.at >= buf.length) return null
  const hasWan = buf[cursor.at] === 1
  cursor.at += 1
  const wan = hasWan ? readEndpointCompact(buf, cursor) : null
  if (hasWan && !wan) return null
  if (buf.length !== cursor.at + SHARE_COMPACT_SECRET_BYTES) return null
  if (!isValidEndpoint(lan) || (wan && !isValidEndpoint(wan))) return null
  return {
    v: 1,
    lan,
    wan,
    secret: buf.subarray(cursor.at).toString('base64url'),
    name: ''
  }
}

/** Encodes a room invite. Same validation discipline as the party codes
 *  above. The admin travels as id AND public key — the key is what lets
 *  every member verify the admin's renames and re-keys rather than
 *  trust them. */
/** The only entry point for a pasted or stored code. There is no JSON
 *  path any more: an invite is packed bytes or it is nothing, so nothing
 *  reachable from here parses attacker-supplied JSON. */
export function decodeShareCode(code: unknown): ShareCodePayload | null {
  try {
    return decodeCompactShareCode(Buffer.from(String(code || ''), 'base64url'))
  } catch {
    return null
  }
}

export function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(String(secret)).digest()
}

export function encryptMessage(secret: string, payload: unknown): string {
  const key = deriveKey(secret)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return JSON.stringify({
    iv: iv.toString('base64'),
    ct: ciphertext.toString('base64'),
    tag: authTag.toString('base64')
  })
}

// Fail-closed by design: ANY parse/decrypt/auth-tag failure returns null,
// exactly as the original's broad try/catch does. Do not narrow this catch.
export function decryptMessage(secret: string, raw: string): unknown {
  try {
    const { iv, ct, tag } = JSON.parse(raw)
    const key = deriveKey(secret)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    return null
  }
}

export function createMemberId(
  randomBytes: typeof crypto.randomBytes = crypto.randomBytes
): string {
  return (randomBytes(8) as Buffer).toString('hex')
}

export function queueScore(entry: PartyQueueEntry): number {
  return Object.values(entry?.votes || {}).reduce((sum: number, v) => sum + v, 0)
}

export function sortQueue(list: PartyQueueEntry[]): PartyQueueEntry[] {
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => queueScore(b.entry) - queueScore(a.entry) || a.index - b.index)
    .map((x) => x.entry)
}

export function applyQueueEvent(
  queue: PartyQueueEntry[] | unknown,
  event: PartyQueueEvent
): PartyQueueEntry[] {
  const list: PartyQueueEntry[] = Array.isArray(queue) ? (queue as PartyQueueEntry[]) : []
  if (event?.type === 'suggest') {
    if (!event.item || !event.item.id) return list
    if (list.some((x) => String(x.item?.id) === String(event.item.id))) return list
    return [
      ...list,
      { queueId: event.queueId, item: event.item, suggestedBy: event.suggestedBy || '', votes: {} }
    ]
  }
  if (event?.type === 'remove') return list.filter((x) => x.queueId !== event.queueId)
  if (event?.type === 'vote') {
    const direction = Number(event.direction)
    const voterId = String(event.voterId || '')
    if ((direction !== 1 && direction !== -1) || !voterId) return list
    return sortQueue(
      list.map((entry) => {
        if (entry.queueId !== event.queueId) return entry
        const votes: Record<string, 1 | -1> = { ...(entry.votes || {}) }
        if (votes[voterId] === direction) delete votes[voterId]
        else votes[voterId] = direction as 1 | -1
        return { ...entry, votes }
      })
    )
  }
  if (event?.type === 'queue-sync') return Array.isArray(event.queue) ? event.queue : list
  return list
}
