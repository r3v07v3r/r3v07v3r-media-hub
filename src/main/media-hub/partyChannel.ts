// Direct-mode (LAN/WAN) watch-party transport security, protocol v2.
//
// v1 encrypted every frame with one static key, sha256(secret), in both
// directions and with no freshness at all. Anyone who could watch the
// plaintext ws:// traffic could copy a member's encrypted 'hello' onto a new
// socket and be admitted without knowing the secret, replay any later frame,
// or reflect a host->member frame back at the host.
//
// v2 binds every connection to fresh randomness from BOTH ends and makes
// every frame single-use:
//
//   1. client -> host  {proto, v:2, type:'client-hello', nonce: Nc}   (plaintext)
//   2. host -> client  {proto, v:2, type:'server-hello', nonce: Nh}   (plaintext)
//   3. Both derive two per-connection keys with HKDF-SHA256 over the party
//      secret, salted with Nc||Nh, one per direction ('c2h' / 'h2c').
//   4. Every later frame is {seq, iv, ct, tag}. AES-256-GCM with the
//      direction's key; the AAD is "<proto>/v2|<direction>|<seq>". The
//      receiver requires seq to be exactly one more than the last frame it
//      accepted on that connection.
//
// So a hello captured from one connection does not decrypt on another (the
// host nonce differs), a frame cannot be replayed or reordered within a
// connection (seq), and a frame cannot be bounced back the other way
// (separate keys plus the direction label). The first sealed client frame
// must be the hello, which proves the client knows the secret; the host's
// sealed welcome proves the same in return.
//
// Kept free of Electron and `ws` so the tests can load it directly.

import crypto from 'node:crypto'

export const PARTY_DIRECT_PROTOCOL = 'r3party-direct'
export const PARTY_DIRECT_VERSION = 2
const NONCE_BYTES = 16
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const MAX_CIPHERTEXT_BASE64_CHARS = 128 * 1024

/** Close code the v2 host uses to turn away a client that speaks v1. */
export const PARTY_CLOSE_UPDATE_REQUIRED = 4426

export const PARTY_OUTDATED_PEER_MESSAGE =
  'That party is running an older version of the app. Everyone in a LAN/WAN party needs the latest version — ask the host to update, then try again.'

export type PartyDirection = 'c2h' | 'h2c'
export type PartyHandshakeKind = 'client-hello' | 'server-hello'

export function createNonce(): Buffer {
  return crypto.randomBytes(NONCE_BYTES)
}

export function encodeHandshake(kind: PartyHandshakeKind, nonce: Buffer): string {
  return JSON.stringify({
    proto: PARTY_DIRECT_PROTOCOL,
    v: PARTY_DIRECT_VERSION,
    type: kind,
    nonce: nonce.toString('base64url')
  })
}

/** Returns the peer's nonce, or null when `raw` is not a well-formed v2
 *  handshake of the expected kind. */
export function parseHandshake(raw: string, kind: PartyHandshakeKind): Buffer | null {
  if (typeof raw !== 'string' || raw.length > 512) return null
  try {
    const frame = JSON.parse(raw) as Record<string, unknown>
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
    if (frame.proto !== PARTY_DIRECT_PROTOCOL || frame.v !== PARTY_DIRECT_VERSION) return null
    if (frame.type !== kind || typeof frame.nonce !== 'string' || frame.nonce.length > 64) {
      return null
    }
    const nonce = Buffer.from(frame.nonce, 'base64url')
    return nonce.length === NONCE_BYTES ? nonce : null
  } catch {
    return null
  }
}

/** True for a v1 frame ({iv, ct, tag} with no seq) — i.e. a peer running an
 *  older version — so the caller can explain instead of failing silently. */
export function isLegacyPartyFrame(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length > MAX_CIPHERTEXT_BASE64_CHARS + 256) return false
  try {
    const frame = JSON.parse(raw) as Record<string, unknown>
    return (
      !!frame &&
      typeof frame === 'object' &&
      typeof frame.iv === 'string' &&
      typeof frame.ct === 'string' &&
      typeof frame.tag === 'string' &&
      frame.seq === undefined
    )
  } catch {
    return false
  }
}

export interface PartySessionKeys {
  c2h: Buffer
  h2c: Buffer
}

export function deriveSessionKeys(
  secret: string,
  clientNonce: Buffer,
  hostNonce: Buffer
): PartySessionKeys {
  const ikm = Buffer.from(String(secret), 'utf8')
  const salt = Buffer.concat([clientNonce, hostNonce])
  const derive = (direction: PartyDirection): Buffer =>
    Buffer.from(
      crypto.hkdfSync(
        'sha256',
        ikm,
        salt,
        `${PARTY_DIRECT_PROTOCOL}/v${PARTY_DIRECT_VERSION}/${direction}`,
        32
      )
    )
  return { c2h: derive('c2h'), h2c: derive('h2c') }
}

function aad(direction: PartyDirection, seq: number): Buffer {
  return Buffer.from(`${PARTY_DIRECT_PROTOCOL}/v${PARTY_DIRECT_VERSION}|${direction}|${seq}`)
}

/** One end of an established v2 connection. Not reusable across
 *  connections: the keys and both counters belong to this socket alone. */
export class PartyDirectChannel {
  private sendSeq = 0
  private recvSeq = 0
  private readonly sendKey: Buffer
  private readonly recvKey: Buffer
  private readonly sendDirection: PartyDirection
  private readonly recvDirection: PartyDirection

  constructor(keys: PartySessionKeys, role: 'host' | 'client') {
    this.sendDirection = role === 'host' ? 'h2c' : 'c2h'
    this.recvDirection = role === 'host' ? 'c2h' : 'h2c'
    this.sendKey = keys[this.sendDirection]
    this.recvKey = keys[this.recvDirection]
  }

  seal(payload: unknown): string {
    this.sendSeq += 1
    const seq = this.sendSeq
    const iv = crypto.randomBytes(GCM_IV_BYTES)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, iv, {
      authTagLength: GCM_TAG_BYTES
    })
    cipher.setAAD(aad(this.sendDirection, seq))
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
    return JSON.stringify({
      seq,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    })
  }

  /** The decrypted payload, or null for anything malformed, forged, replayed,
   *  reordered or sent in the wrong direction. Fail-closed: a null leaves the
   *  receive counter untouched, and callers close the connection. */
  open(raw: string): unknown {
    try {
      if (typeof raw !== 'string' || raw.length > MAX_CIPHERTEXT_BASE64_CHARS + 256) return null
      const frame: unknown = JSON.parse(raw)
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
      const { seq, iv, ct, tag } = frame as Record<string, unknown>
      if (!Number.isSafeInteger(seq) || seq !== this.recvSeq + 1) return null
      if (typeof iv !== 'string' || typeof ct !== 'string' || typeof tag !== 'string') return null
      if (ct.length > MAX_CIPHERTEXT_BASE64_CHARS || iv.length > 32 || tag.length > 32) return null
      const ivBytes = Buffer.from(iv, 'base64')
      const tagBytes = Buffer.from(tag, 'base64')
      if (ivBytes.length !== GCM_IV_BYTES || tagBytes.length !== GCM_TAG_BYTES) return null
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, ivBytes, {
        authTagLength: GCM_TAG_BYTES
      })
      decipher.setAAD(aad(this.recvDirection, seq as number))
      decipher.setAuthTag(tagBytes)
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64')),
        decipher.final()
      ])
      const payload: unknown = JSON.parse(plaintext.toString('utf8'))
      this.recvSeq = seq as number
      return payload
    } catch {
      return null
    }
  }
}

/** Host side of one connection: feed it every raw frame in order. */
export class PartyHostHandshake {
  private channel: PartyDirectChannel | null = null
  constructor(
    private readonly secret: string,
    private readonly hostNonce: Buffer = createNonce()
  ) {}

  get established(): PartyDirectChannel | null {
    return this.channel
  }

  /** First frame from the client. Returns the server-hello to send back, or
   *  an outcome telling the caller why to close. */
  acceptClientHello(
    raw: string
  ): { ok: true; reply: string } | { ok: false; reason: 'legacy' | 'invalid' } {
    if (this.channel) return { ok: false, reason: 'invalid' }
    const clientNonce = parseHandshake(raw, 'client-hello')
    if (!clientNonce) return { ok: false, reason: isLegacyPartyFrame(raw) ? 'legacy' : 'invalid' }
    this.channel = new PartyDirectChannel(
      deriveSessionKeys(this.secret, clientNonce, this.hostNonce),
      'host'
    )
    return { ok: true, reply: encodeHandshake('server-hello', this.hostNonce) }
  }
}

/** Client side: create, send `hello()`, then pass the host's first frame to
 *  `acceptServerHello`. */
export class PartyClientHandshake {
  constructor(
    private readonly secret: string,
    private readonly clientNonce: Buffer = createNonce()
  ) {}

  hello(): string {
    return encodeHandshake('client-hello', this.clientNonce)
  }

  acceptServerHello(raw: string): PartyDirectChannel | null {
    const hostNonce = parseHandshake(raw, 'server-hello')
    if (!hostNonce) return null
    return new PartyDirectChannel(
      deriveSessionKeys(this.secret, this.clientNonce, hostNonce),
      'client'
    )
  }
}
