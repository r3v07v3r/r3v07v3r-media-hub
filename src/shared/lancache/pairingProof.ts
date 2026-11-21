// The daemon's identity, and how a joining device checks it.
//
// Shared by the daemon and the app's main process (both node, neither
// electron), so the two sides cannot drift on the byte layout.
//
// The problem it solves: joining a cache server used to prove nothing about
// the SERVER. Anything on the LAN could answer mDNS, say it was r3-cache,
// "approve" the request on the spot and be handed the device's bearer token
// and TorBox key, all over plain http. Now:
//
//  - the daemon serves HTTPS with its own long-lived self-signed
//    certificate (daemon/tlsIdentity.ts), so nothing secret crosses the LAN
//    in the clear;
//  - the app pins that certificate's SHA-256 fingerprint the first time it
//    joins and never talks to the daemon through any other certificate
//    (src/main/media-hub/lanCacheTrust.ts) — a moved address, an API call,
//    a stream, the rooms hop, the TorBox key: all of it;
//  - and a join request carries a fresh nonce from the app, so both ends can
//    compute the same short VERIFICATION CODE from what each of them saw:
//    the certificate fingerprint, the issued token and that nonce. The
//    joining device shows its code; the daemon logs its own and shows it to
//    the administrator beside the request. Somebody in the middle presents
//    a different certificate, so the codes differ, and the administrator
//    who compares them before approving sees it.
//
// There is no pairing code any more (approval by the administrator replaced
// it), so there is no shared secret to run a PAKE over. The verification
// code is the out-of-band check that takes its place, exactly as numeric
// comparison does in Bluetooth pairing. It is bound to the app's nonce,
// which is only sent after the TLS handshake has fixed the certificate, so
// an attacker cannot grind a certificate to match a code in advance.

import crypto from 'node:crypto'

/** Bumped when the pairing / transport contract changes incompatibly. The
 *  app refuses daemons that do not report at least this. 2 = HTTPS with a
 *  pinned certificate, hashed expiring tokens, verification codes. */
export const LANCACHE_PROTOCOL_VERSION = 2

/** How long a bearer token is honoured. The app renews well before this
 *  while it is in use, so only an abandoned device ever reaches it. */
export const LANCACHE_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

/** SHA-256 of the certificate's DER, lowercase hex — the pin. */
export function certFingerprint(der: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(der).digest('hex')
}

export const FINGERPRINT_RE = /^[a-f0-9]{64}$/

/** Short, human-comparable form for consoles and settings. */
export function shortFingerprint(fingerprint: string): string {
  return (
    String(fingerprint ?? '')
      .slice(0, 16)
      .toUpperCase()
      .match(/.{1,4}/g)
      ?.join(':') ?? ''
  )
}

export function newNonce(): string {
  return crypto.randomBytes(32).toString('hex')
}

export const NONCE_RE = /^[a-f0-9]{64}$/

/**
 * The six-digit code both ends of a join show. Computed independently by
 * the app (from the certificate it actually connected to) and the daemon
 * (from its own certificate), so the two only match when nothing sat in
 * between. '' when any input is missing or malformed — a request without a
 * nonce simply has no code, and nothing displays one.
 */
export function joinVerificationCode(
  fingerprint: string,
  token: string,
  clientNonce: string
): string {
  if (!FINGERPRINT_RE.test(fingerprint) || !token || !NONCE_RE.test(clientNonce)) return ''
  const digest = crypto
    .createHmac('sha256', Buffer.from(clientNonce, 'hex'))
    .update(`r3-cache-join-v2|${fingerprint}|${token}`)
    .digest()
  const value = digest.readUInt32BE(0) % 1_000_000
  return String(value).padStart(6, '0')
}

/** For display: 123 456. */
export function formatVerificationCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}
