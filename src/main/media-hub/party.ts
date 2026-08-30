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
 * A room code. v2 plus the creator's stable friendId, which is what makes
 * "admin" mean something offline: members trust the code they joined
 * with, so the admin badge and the rename rule work with no relay
 * round-trip and regardless of which transport carried the message.
 */
export interface ShareCodePayloadV3 {
  v: 3
  relay: PartyRelayEndpoint
  secret: string
  name: string
  adminFriendId: string
  /** The relay's admission ticket for rooms with a membership layer —
   *  what a stranger must present to connect at all. Absent on rooms
   *  created before kick existed; those admit anyone at the relay, as
   *  they always did. A RELAY credential, not content: holding it lets
   *  a device connect, not read. */
  join?: string
}

/**
 * A room code with a chip-and-tap admin: v3 plus the admin's PUBLIC KEY,
 * which is what turns "the admin renamed the room" and "the admin
 * rotated the secret" from claims into verifiable statements. The
 * admin's id is sha256 of this key, so the two fields cannot disagree
 * without failing verification.
 */
export interface ShareCodePayloadV4 {
  v: 4
  relay: PartyRelayEndpoint
  secret: string
  name: string
  admin: { id: string; pub: string }
  join?: string
}

export type ShareCodePayload =
  ShareCodePayloadV1 | ShareCodePayloadV2 | ShareCodePayloadV3 | ShareCodePayloadV4

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

export function encodeShareCode(input: {
  lan: PartyLanEndpoint
  wan?: PartyLanEndpoint | null
  secret: string
  name?: string
}): string {
  const { lan, wan, secret, name } = input
  if (!isValidEndpoint(lan) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid party endpoint.')
  }
  const payload: ShareCodePayloadV1 = {
    v: 1,
    lan,
    wan: wan && isValidEndpoint(wan) ? wan : null,
    secret,
    name: String(name || '').slice(0, 40)
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function encodeRelayShareCode(input: {
  relay: PartyRelayEndpoint
  secret: string
  name?: string
}): string {
  const { relay, secret, name } = input
  if (!isValidRelayEndpoint(relay) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid party endpoint.')
  }
  const payload: ShareCodePayloadV2 = {
    v: 2,
    relay,
    secret,
    name: String(name || '').slice(0, 40)
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
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
const SHARE_COMPACT_SECRET_BYTES = 24
const SHARE_COMPACT_IPV4_TAG = 0

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

/** Compact replacement for `encodeShareCode`. Falls back to it verbatim when
 *  the inputs do not fit the packed layout. */
export function encodeShareCodeCompact(input: {
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
  if (!bytes || !lanPart || !wanPart) return encodeShareCode({ lan, wan: validWan, secret })
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_DIRECT]),
    lanPart,
    Buffer.from([validWan ? 1 : 0]),
    wanPart,
    bytes
  ]).toString('base64url')
}

/** Compact replacement for `encodeRelayShareCode`. Falls back to it verbatim
 *  when the inputs do not fit the packed layout. */
export function encodeRelayShareCodeCompact(input: {
  relay: PartyRelayEndpoint
  secret: string
}): string {
  const { relay, secret } = input
  if (!isValidRelayEndpoint(relay) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid party endpoint.')
  }
  const bytes = shareSecretBytes(secret)
  const host = relay.url.replace(/^https:\/\//i, '').replace(/\/+$/, '')
  const hostBytes = Buffer.from(host, 'utf8')
  const roomId = Buffer.from(relay.roomId.replace(/-/g, ''), 'hex')
  if (
    !bytes ||
    hostBytes.length < 1 ||
    hostBytes.length > 255 ||
    roomId.length !== 16 ||
    !/^https:\/\//i.test(relay.url)
  ) {
    return encodeRelayShareCode({ relay, secret })
  }
  return Buffer.concat([
    Buffer.from([SHARE_COMPACT_RELAY]),
    roomId,
    Buffer.from([hostBytes.length]),
    hostBytes,
    bytes
  ]).toString('base64url')
}

function decodeCompactShareCode(buf: Buffer): ShareCodePayload | null {
  if (buf[0] === SHARE_COMPACT_RELAY) {
    const urlAt = 1 + 16
    if (buf.length < urlAt + 1) return null
    const hex = buf.subarray(1, urlAt).toString('hex')
    const roomId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    const urlLen = buf[urlAt]
    const start = urlAt + 1
    if (buf.length !== start + urlLen + SHARE_COMPACT_SECRET_BYTES) return null
    const relay: PartyRelayEndpoint = {
      url: `https://${buf.subarray(start, start + urlLen).toString('utf8')}`,
      roomId
    }
    if (!isValidRelayEndpoint(relay)) return null
    return {
      v: 2,
      relay,
      secret: buf.subarray(start + urlLen).toString('base64url'),
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
  const payload: ShareCodePayloadV4 = {
    v: 4,
    relay,
    secret,
    name: String(name || '').slice(0, 40),
    admin: { id: admin.id.slice(0, 64), pub: admin.pub.slice(0, 64) },
    ...(join ? { join: String(join).slice(0, 64) } : {})
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeShareCode(code: unknown): ShareCodePayload | null {
  try {
    const raw = Buffer.from(String(code || ''), 'base64url')
    // Every JSON code (v1 through v4) starts with '{'. Anything else is a
    // packed code, or garbage, which decodeCompactShareCode rejects.
    if (raw.length > 0 && raw[0] !== 0x7b) return decodeCompactShareCode(raw)
    const payload = JSON.parse(raw.toString('utf8')) as {
      v?: unknown
      lan?: unknown
      wan?: unknown
      relay?: unknown
      secret?: unknown
      name?: unknown
      adminFriendId?: unknown
      admin?: { id?: unknown; pub?: unknown }
    }
    if (payload.v === 4) {
      if (
        !isValidRelayEndpoint(payload.relay) ||
        typeof payload.secret !== 'string' ||
        !payload.secret ||
        typeof payload.admin?.id !== 'string' ||
        !payload.admin.id ||
        typeof payload.admin?.pub !== 'string' ||
        !payload.admin.pub
      ) {
        return null
      }
      return payload as unknown as ShareCodePayloadV4
    }
    if (payload.v === 3) {
      if (
        !isValidRelayEndpoint(payload.relay) ||
        typeof payload.secret !== 'string' ||
        !payload.secret ||
        typeof payload.adminFriendId !== 'string' ||
        !payload.adminFriendId
      ) {
        return null
      }
      return payload as unknown as ShareCodePayloadV3
    }
    if (payload.v === 2) {
      if (
        !isValidRelayEndpoint(payload.relay) ||
        typeof payload.secret !== 'string' ||
        !payload.secret
      ) {
        return null
      }
      return payload as unknown as ShareCodePayloadV2
    }
    if (
      payload.v !== 1 ||
      !isValidEndpoint(payload.lan) ||
      typeof payload.secret !== 'string' ||
      !payload.secret
    ) {
      return null
    }
    if (payload.wan && !isValidEndpoint(payload.wan)) return null
    return payload as unknown as ShareCodePayloadV1
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
