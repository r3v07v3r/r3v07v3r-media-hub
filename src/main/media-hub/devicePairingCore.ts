// Linking a phone to this desktop: the parts with no I/O in them.
//
// The desktop shows a QR code; the phone scans it and ends up signed in to
// the same services. What the QR carries is a TICKET, never the secrets:
// the desktop's LAN address, a random ticket id, and a random key. The
// desktop encrypts one snapshot of its credentials under that key and
// serves the ciphertext once, to whoever asks for that ticket id, then
// stops listening. So the network only ever sees ciphertext, the key only
// ever travels through the camera, and a ticket that has been used or has
// timed out opens nothing.
//
// What travels is chosen, not "everything in settings": see buildBundle for
// what is left behind and why. devicePairing.ts owns the server, the fetch
// and the IPC; this file is what the tests pin.

import crypto from 'node:crypto'

import type { MediaHubRawSettings } from './settingsStore'

export const PAIRING_SCHEME = 'r3hub:'
export const PAIRING_PATH_PREFIX = '/r3-pair/v1/'
/** How long a ticket stays redeemable. Long enough to find the phone and
 *  point it at the screen; short enough that a photo of the screen taken
 *  later is worth nothing. */
export const PAIRING_TTL_MS = 3 * 60_000
/** Wrong ticket ids a server tolerates before it gives up. A 128-bit id is
 *  not guessable, so misses mean something odd on the network, not a
 *  phone that fumbled. */
export const PAIRING_MAX_MISSES = 10
const MAX_HOSTS = 4
const MAX_FIELD_LENGTH = 4096

export interface PairingTicket {
  /** `ipv4:port`, one per LAN interface the desktop is reachable on. */
  hosts: string[]
  /** 16 random bytes. Names the ticket on the wire. */
  id: Buffer
  /** 32 random bytes. Never on the wire. */
  key: Buffer
}

function b64url(value: Buffer): string {
  return value.toString('base64url')
}

function fromB64url(value: string | null, bytes: number): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null
  const decoded = Buffer.from(value, 'base64url')
  return decoded.length === bytes ? decoded : null
}

export function newTicket(hosts: string[]): PairingTicket {
  return {
    hosts: hosts.slice(0, MAX_HOSTS),
    id: crypto.randomBytes(16),
    key: crypto.randomBytes(32)
  }
}

export function ticketLink(ticket: PairingTicket): string {
  const params = new URLSearchParams({
    v: '1',
    h: ticket.hosts.join(','),
    t: b64url(ticket.id),
    k: b64url(ticket.key)
  })
  return `r3hub://pair?${params.toString()}`
}

/**
 * A LAN `ipv4:port`, or null. Only private IPv4 ranges: the phone is about
 * to make a plain-HTTP request to whatever this names, and a link that
 * could point it at the internet (or at a hostname some resolver decides
 * about) is a link somebody could make for it.
 */
export function parsePairingHost(value: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value)
  if (!match) return null
  const octets = match.slice(1, 5).map(Number)
  const port = Number(match[5])
  if (octets.some((o) => o > 255) || port < 1 || port > 65535) return null
  const [a, b] = octets
  const isPrivate =
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  return isPrivate ? `${octets.join('.')}:${port}` : null
}

/** Reads a pairing link back into a ticket, or says why it can't. Accepts
 *  the `r3hub://pair?...` form and a bare query string, since a link can be
 *  pasted with or without its scheme. */
export function parseTicketLink(
  raw: string
): { ok: true; ticket: PairingTicket } | { ok: false; message: string } {
  const text = String(raw || '').trim()
  let query: string
  if (text.toLowerCase().startsWith('r3hub://pair?')) query = text.slice('r3hub://pair?'.length)
  else if (text.startsWith('?')) query = text.slice(1)
  else if (/^v=/.test(text)) query = text
  else return { ok: false, message: 'That is not a pairing link from R3 Media Hub.' }

  const params = new URLSearchParams(query)
  if (params.get('v') !== '1') {
    return { ok: false, message: 'This pairing link is from a newer version of the app.' }
  }
  const id = fromB64url(params.get('t'), 16)
  const key = fromB64url(params.get('k'), 32)
  const hosts = String(params.get('h') || '')
    .split(',')
    .slice(0, MAX_HOSTS)
    .map(parsePairingHost)
    .filter((h): h is string => h !== null)
  if (!id || !key || hosts.length === 0) {
    return { ok: false, message: 'This pairing link is incomplete. Scan the code again.' }
  }
  return { ok: true, ticket: { hosts, id, key } }
}

// ---- the sealed snapshot ---------------------------------------------------

export interface SealedBundle {
  v: 1
  iv: string
  data: string
}

/** AES-256-GCM, with the ticket id as associated data so a ciphertext
 *  cannot be replayed under a different ticket that happened to share a
 *  key. */
export function sealBundle(ticket: PairingTicket, bundle: PairingBundle): SealedBundle {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', ticket.key, iv)
  cipher.setAAD(ticket.id)
  const body = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()])
  return { v: 1, iv: b64url(iv), data: b64url(Buffer.concat([body, cipher.getAuthTag()])) }
}

export function openBundle(ticket: PairingTicket, sealed: unknown): PairingBundle | null {
  if (!sealed || typeof sealed !== 'object') return null
  const { v, iv, data } = sealed as Record<string, unknown>
  if (v !== 1 || typeof iv !== 'string' || typeof data !== 'string') return null
  const ivBytes = fromB64url(iv, 12)
  const raw = Buffer.from(data, 'base64url')
  if (!ivBytes || raw.length < 17) return null
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', ticket.key, ivBytes)
    decipher.setAAD(ticket.id)
    decipher.setAuthTag(raw.subarray(raw.length - 16))
    const plain = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final()
    ])
    return normalizeBundle(JSON.parse(plain.toString('utf8')))
  } catch {
    return null
  }
}

// ---- what travels ----------------------------------------------------------

export interface PairingBundle {
  v: 1
  /** The desktop's name, so the phone can say where its settings came from. */
  from: string
  torboxToken?: string
  simkl?: { clientId: string; accessToken: string }
  /** The app registration only. The phone signs in to Trakt itself. */
  trakt?: { clientId: string; clientSecret: string }
  /** Likewise for MyAnimeList. */
  mal?: { clientId: string; clientSecret: string }
  tmdbApiKey?: string
  omdbApiKey?: string
  subdlApiKey?: string
  openSubtitles?: { apiKey: string; username: string; password: string }
  prefs?: {
    subtitleLanguage?: string
    audioLanguage?: string
    watchRegion?: string
    partyDisplayName?: string
  }
}

/** The human names of what a bundle carries, for "Imported: …". */
export function bundleContents(bundle: PairingBundle): string[] {
  const names: string[] = []
  if (bundle.torboxToken) names.push('TorBox')
  if (bundle.simkl) names.push('Simkl')
  if (bundle.trakt) names.push('Trakt app')
  if (bundle.mal) names.push('MyAnimeList app')
  if (bundle.tmdbApiKey) names.push('TMDB')
  if (bundle.omdbApiKey) names.push('OMDb')
  if (bundle.subdlApiKey) names.push('SubDL')
  if (bundle.openSubtitles) names.push('OpenSubtitles')
  if (bundle.prefs && Object.keys(bundle.prefs).length > 0) names.push('Language preferences')
  return names
}

/**
 * One snapshot of what a new device needs, out of this device's settings.
 *
 * Left behind on purpose:
 * - Trakt and MAL access and refresh tokens. Both services rotate the
 *   refresh token on every use, so two devices holding one pair would sign
 *   each other out at the first refresh. The app registration travels; the
 *   phone runs the sign-in itself (traktClient.ts, malSync.ts).
 * - The r3-cache device token. The cache server approves DEVICES, by name;
 *   a phone using the desktop's token would be the desktop as far as the
 *   server's administrator can tell. The phone pairs on its own.
 * - The party invite key, the room identity and the friend id. Those are
 *   who this install IS in a room; a copy would be two people with one chip.
 * - OpenSubtitles' session token, which the phone mints from the login.
 */
export function buildBundle(
  settings: MediaHubRawSettings,
  decrypt: (value: string | undefined) => string,
  from: string
): PairingBundle {
  const bundle: PairingBundle = { v: 1, from }
  const torbox = settings.onboardingVersion === 2 ? decrypt(settings.torboxToken) : ''
  if (torbox) bundle.torboxToken = torbox

  const simklToken = decrypt(settings.simklAccessToken)
  if (settings.simklClientId && simklToken) {
    bundle.simkl = { clientId: settings.simklClientId, accessToken: simklToken }
  }
  const traktSecret = decrypt(settings.traktClientSecret)
  if (settings.traktClientId && traktSecret) {
    bundle.trakt = { clientId: settings.traktClientId, clientSecret: traktSecret }
  }
  const malSecret = decrypt(settings.malClientSecret)
  if (settings.malClientId) {
    bundle.mal = { clientId: settings.malClientId, clientSecret: malSecret }
  }
  const tmdb = decrypt(settings.tmdbApiKey)
  if (tmdb) bundle.tmdbApiKey = tmdb
  const omdb = decrypt(settings.omdbApiKey)
  if (omdb) bundle.omdbApiKey = omdb
  const subdl = decrypt(settings.subdlApiKey)
  if (subdl) bundle.subdlApiKey = subdl
  const os = {
    apiKey: decrypt(settings.osApiKey),
    username: decrypt(settings.osUsername),
    password: decrypt(settings.osPassword)
  }
  if (os.apiKey && os.username && os.password) bundle.openSubtitles = os

  const prefs: NonNullable<PairingBundle['prefs']> = {}
  for (const key of ['subtitleLanguage', 'audioLanguage', 'watchRegion'] as const) {
    const value = settings[key]
    if (typeof value === 'string' && value) prefs[key] = value
  }
  if (typeof settings.partyDisplayName === 'string' && settings.partyDisplayName) {
    prefs.partyDisplayName = settings.partyDisplayName
  }
  if (Object.keys(prefs).length > 0) bundle.prefs = prefs
  return bundle
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= MAX_FIELD_LENGTH ? trimmed : undefined
}

/** The bundle as it came off the wire, reduced to the shape above: unknown
 *  keys dropped, every field a sane string or absent. What decrypted is
 *  authentic (GCM), but it is still input from another machine. */
export function normalizeBundle(value: unknown): PairingBundle | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.v !== 1) return null
  const pair = <A extends string, B extends string>(
    v: unknown,
    a: A,
    b: B,
    bOptional = false
  ): Record<A | B, string> | undefined => {
    if (!v || typeof v !== 'object') return undefined
    const o = v as Record<string, unknown>
    const first = str(o[a])
    const second = str(o[b]) ?? (bOptional ? '' : undefined)
    return first !== undefined && second !== undefined
      ? ({ [a]: first, [b]: second } as Record<A | B, string>)
      : undefined
  }
  const bundle: PairingBundle = { v: 1, from: str(raw.from) ?? 'another device' }
  const torbox = str(raw.torboxToken)
  if (torbox) bundle.torboxToken = torbox
  const simkl = pair(raw.simkl, 'clientId', 'accessToken')
  if (simkl) bundle.simkl = simkl
  const trakt = pair(raw.trakt, 'clientId', 'clientSecret')
  if (trakt) bundle.trakt = trakt
  const mal = pair(raw.mal, 'clientId', 'clientSecret', true)
  if (mal) bundle.mal = mal
  for (const key of ['tmdbApiKey', 'omdbApiKey', 'subdlApiKey'] as const) {
    const v = str(raw[key])
    if (v) bundle[key] = v
  }
  if (raw.openSubtitles && typeof raw.openSubtitles === 'object') {
    const o = raw.openSubtitles as Record<string, unknown>
    const apiKey = str(o.apiKey)
    const username = str(o.username)
    const password = str(o.password)
    if (apiKey && username && password) bundle.openSubtitles = { apiKey, username, password }
  }
  if (raw.prefs && typeof raw.prefs === 'object') {
    const o = raw.prefs as Record<string, unknown>
    const prefs: NonNullable<PairingBundle['prefs']> = {}
    for (const key of [
      'subtitleLanguage',
      'audioLanguage',
      'watchRegion',
      'partyDisplayName'
    ] as const) {
      const v = str(o[key])
      if (v && v.length <= 64) prefs[key] = v
    }
    if (Object.keys(prefs).length > 0) bundle.prefs = prefs
  }
  return bundle
}

/**
 * Writes a bundle into this device's settings. Only what the bundle
 * carries is touched: nothing already set here is cleared, so pairing
 * never signs a phone out of something it had and the desktop doesn't.
 * Credentials go through `encrypt`, like every other credential write.
 */
export function applyBundle(
  settings: MediaHubRawSettings,
  bundle: PairingBundle,
  encrypt: (value: string) => string
): MediaHubRawSettings {
  const next: MediaHubRawSettings = { ...settings }
  if (bundle.torboxToken) {
    next.torboxToken = encrypt(bundle.torboxToken)
    next.onboardingVersion = 2
  }
  if (bundle.simkl) {
    next.simklClientId = bundle.simkl.clientId
    next.simklAccessToken = encrypt(bundle.simkl.accessToken)
  }
  if (bundle.trakt) {
    next.traktClientId = bundle.trakt.clientId
    next.traktClientSecret = encrypt(bundle.trakt.clientSecret)
  }
  if (bundle.mal) {
    next.malClientId = bundle.mal.clientId
    if (bundle.mal.clientSecret) next.malClientSecret = encrypt(bundle.mal.clientSecret)
  }
  if (bundle.tmdbApiKey) next.tmdbApiKey = encrypt(bundle.tmdbApiKey)
  if (bundle.omdbApiKey) next.omdbApiKey = encrypt(bundle.omdbApiKey)
  if (bundle.subdlApiKey) next.subdlApiKey = encrypt(bundle.subdlApiKey)
  if (bundle.openSubtitles) {
    next.osApiKey = encrypt(bundle.openSubtitles.apiKey)
    next.osUsername = encrypt(bundle.openSubtitles.username)
    next.osPassword = encrypt(bundle.openSubtitles.password)
    delete next.osToken
  }
  if (bundle.prefs) {
    for (const [key, value] of Object.entries(bundle.prefs)) {
      if (value) next[key] = value
    }
  }
  return next
}
