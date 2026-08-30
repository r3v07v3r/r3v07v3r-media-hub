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
}

export type ShareCodePayload = ShareCodePayloadV1 | ShareCodePayloadV2 | ShareCodePayloadV3

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

/** Encodes a room invite. Same validation discipline as the party codes
 *  above; the only addition is the admin identity. */
export function encodeRoomShareCode(input: {
  relay: PartyRelayEndpoint
  secret: string
  name: string
  adminFriendId: string
}): string {
  const { relay, secret, name, adminFriendId } = input
  if (!isValidRelayEndpoint(relay) || typeof secret !== 'string' || !secret) {
    throw new Error('Invalid room endpoint.')
  }
  if (typeof adminFriendId !== 'string' || !adminFriendId) {
    throw new Error('A room code names its admin.')
  }
  const payload: ShareCodePayloadV3 = {
    v: 3,
    relay,
    secret,
    name: String(name || '').slice(0, 40),
    adminFriendId: adminFriendId.slice(0, 64)
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeShareCode(code: unknown): ShareCodePayload | null {
  try {
    const payload = JSON.parse(Buffer.from(String(code || ''), 'base64url').toString('utf8')) as {
      v?: unknown
      lan?: unknown
      wan?: unknown
      relay?: unknown
      secret?: unknown
      name?: unknown
      adminFriendId?: unknown
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
