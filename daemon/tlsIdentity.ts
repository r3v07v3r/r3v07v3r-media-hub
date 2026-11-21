// The daemon's TLS identity: one self-signed certificate, generated on
// first run and kept for the life of the data directory.
//
// It is never validated against a CA — nothing on a home LAN could be.
// What makes it worth something is pinning: the app learns the
// certificate's SHA-256 fingerprint during pairing, only after the daemon
// has proven it knows the console code bound to that fingerprint (see
// shared/lancache/pairingProof.ts), and from then on refuses any other
// certificate. Persisting it is therefore essential — a new certificate
// means every paired app must pair again, by design.
//
// node:crypto can make keys and signatures but not certificates, so the
// certificate is assembled here as minimal DER: X.509 v3, ECDSA P-256 /
// SHA-256, no extensions. Clients pin rather than verify, so names and
// usages would add nothing.

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { certFingerprint } from '../src/shared/lancache/pairingProof'

export interface TlsIdentity {
  key: string
  cert: string
  /** certFingerprint(DER) — what the app pins. */
  fingerprint: string
}

// --- minimal DER --------------------------------------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length
  let header: Buffer
  if (length < 0x80) header = Buffer.from([tag, length])
  else {
    const bytes: number[] = []
    for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
    header = Buffer.from([tag, 0x80 | bytes.length, ...bytes])
  }
  return Buffer.concat([header, content])
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f]
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift(0x80 | (rest & 0x7f))
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

function integer(value: Buffer): Buffer {
  let bytes = value
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1)
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

function utcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

function name(commonName: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName, 'utf8')))))
}

/** A fresh P-256 key and a self-signed certificate for it. */
export function createSelfSignedIdentity(commonName = 'r3-cache'): TlsIdentity {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'))
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // [0] EXPLICIT version v3
    integer(crypto.randomBytes(16)),
    ecdsaWithSha256,
    name(commonName),
    // UTCTime only reaches 2049; pinning ignores validity anyway.
    seq(utcTime(new Date(Date.UTC(2024, 0, 1))), utcTime(new Date(Date.UTC(2049, 11, 31)))),
    name(commonName),
    spki
  )
  // ECDSA signatures from node:crypto are already DER (r, s) — exactly what
  // the certificate's BIT STRING carries.
  const signature = crypto.sign('sha256', tbs, privateKey)
  const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))
  const cert = `-----BEGIN CERTIFICATE-----\n${der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----\n`
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert,
    fingerprint: certFingerprint(der)
  }
}

/** Loads the persisted identity, or creates and persists one (key 0600). */
export async function loadOrCreateTlsIdentity(dataDir: string): Promise<TlsIdentity> {
  const keyPath = path.join(dataDir, 'tls-key.pem')
  const certPath = path.join(dataDir, 'tls-cert.pem')
  try {
    const [key, cert] = await Promise.all([
      fsp.readFile(keyPath, 'utf8'),
      fsp.readFile(certPath, 'utf8')
    ])
    const parsed = new crypto.X509Certificate(cert)
    // A cert that does not match its key would fail every handshake; a
    // fresh identity (and a re-pair) is the only recovery anyway.
    if (parsed.checkPrivateKey(crypto.createPrivateKey(key))) {
      return { key, cert, fingerprint: certFingerprint(parsed.raw) }
    }
  } catch {
    // First run, or unreadable — generate below.
  }
  const identity = createSelfSignedIdentity()
  await fsp.writeFile(keyPath, identity.key, { mode: 0o600 })
  await fsp.writeFile(certPath, identity.cert, { mode: 0o644 })
  return identity
}
