// Linking a phone (src/main/media-hub/devicePairingCore.ts): the link
// format, the sealed snapshot, what travels and what stays behind.

import assert from 'node:assert/strict'

import {
  applyBundle,
  buildBundle,
  bundleContents,
  newTicket,
  openBundle,
  parsePairingHost,
  parseTicketLink,
  sealBundle,
  ticketLink
} from '../src/main/media-hub/devicePairingCore'
import type { MediaHubRawSettings } from '../src/main/media-hub/settingsStore'

// Stand-ins for safeStorage: visibly different from the plain value, so a
// test can tell a credential that went through encrypt from one that didn't.
const enc = (value: string): string => `enc:${value}`
const dec = (value: string | undefined): string =>
  value && value.startsWith('enc:') ? value.slice(4) : ''

const desktop: MediaHubRawSettings = {
  onboardingVersion: 2,
  torboxToken: enc('tb-token'),
  simklClientId: 'simkl-id',
  simklAccessToken: enc('simkl-token'),
  traktClientId: 'trakt-id',
  traktClientSecret: enc('trakt-secret'),
  traktAccessToken: enc('trakt-access'),
  traktRefreshToken: enc('trakt-refresh'),
  malClientId: 'mal-id',
  malClientSecret: enc('mal-secret'),
  malAccessToken: enc('mal-access'),
  malRefreshToken: enc('mal-refresh'),
  tmdbApiKey: enc('tmdb'),
  osApiKey: enc('os-key'),
  osUsername: enc('os-user'),
  osPassword: enc('os-pass'),
  osToken: enc('os-session'),
  lanCacheUrl: 'http://192.168.88.237:8945',
  lanCacheToken: enc('cache-device-token'),
  partySyncInviteKey: enc('invite'),
  roomIdentityKey: enc('identity'),
  friendId: 'friend-1',
  subtitleLanguage: 'en',
  partyDisplayName: 'Graham'
}

// ---- what travels ----------------------------------------------------------

const bundle = buildBundle(desktop, dec, 'DESKTOP')
assert.equal(bundle.torboxToken, 'tb-token')
assert.deepEqual(bundle.simkl, { clientId: 'simkl-id', accessToken: 'simkl-token' })
assert.deepEqual(bundle.trakt, { clientId: 'trakt-id', clientSecret: 'trakt-secret' })
assert.deepEqual(bundle.mal, { clientId: 'mal-id', clientSecret: 'mal-secret' })
assert.deepEqual(bundle.openSubtitles, {
  apiKey: 'os-key',
  username: 'os-user',
  password: 'os-pass'
})
assert.deepEqual(bundle.prefs, { subtitleLanguage: 'en', partyDisplayName: 'Graham' })

// Rotating tokens and per-install identity never leave, in any field.
const wire = JSON.stringify(bundle)
for (const secret of [
  'trakt-access',
  'trakt-refresh',
  'mal-access',
  'mal-refresh',
  'os-session',
  'cache-device-token',
  'invite',
  'identity',
  'friend-1',
  '8945'
]) {
  assert.ok(!wire.includes(secret), `${secret} must not be in the bundle`)
}

// A TorBox token from before onboarding v2 is not a connected account.
assert.equal(buildBundle({ ...desktop, onboardingVersion: 1 }, dec, 'X').torboxToken, undefined)
assert.deepEqual(bundleContents(buildBundle({}, dec, 'X')), [])

// ---- the sealed round trip -------------------------------------------------

const ticket = newTicket(['192.168.88.250:51000'])
const sealed = sealBundle(ticket, bundle)
assert.ok(!JSON.stringify(sealed).includes('tb-token'), 'the wire carries ciphertext only')
assert.deepEqual(openBundle(ticket, sealed), bundle)

// Another ticket's key, or the same key under another ticket id, opens nothing.
const other = newTicket(['192.168.88.250:51000'])
assert.equal(openBundle(other, sealed), null)
assert.equal(openBundle({ ...ticket, id: other.id }, sealed), null)
// One flipped byte anywhere in the ciphertext fails authentication.
const raw = Buffer.from(sealed.data, 'base64url')
raw[3] ^= 1
assert.equal(openBundle(ticket, { ...sealed, data: raw.toString('base64url') }), null)
assert.equal(openBundle(ticket, 'nonsense'), null)

// ---- the link --------------------------------------------------------------

const link = ticketLink(ticket)
assert.ok(link.startsWith('r3hub://pair?v=1&'))
const back = parseTicketLink(link)
assert.ok(back.ok)
assert.deepEqual(back.ticket.hosts, ticket.hosts)
assert.ok(back.ticket.id.equals(ticket.id) && back.ticket.key.equals(ticket.key))
// Pasted without its scheme still works.
assert.ok(parseTicketLink(link.slice('r3hub://pair'.length)).ok)

assert.equal(parseTicketLink('https://example.com').ok, false)
assert.equal(parseTicketLink(link.replace('v=1', 'v=2')).ok, false)
assert.equal(parseTicketLink(link.replace(/k=[^&]+/, 'k=short')).ok, false)

// The phone only ever fetches from a private IPv4 address and a real port.
assert.equal(parsePairingHost('192.168.1.5:8080'), '192.168.1.5:8080')
assert.equal(parsePairingHost('10.0.0.2:1'), '10.0.0.2:1')
assert.equal(parsePairingHost('8.8.8.8:80'), null)
assert.equal(parsePairingHost('evil.example:80'), null)
assert.equal(parsePairingHost('192.168.1.5'), null)
assert.equal(parsePairingHost('192.168.1.5:70000'), null)
assert.equal(parsePairingHost('192.168.1.300:80'), null)
const publicOnly = new URLSearchParams(link.split('?')[1])
publicOnly.set('h', '203.0.113.9:80')
assert.equal(parseTicketLink(`r3hub://pair?${publicOnly}`).ok, false)

// ---- applying it on the phone ----------------------------------------------

const phoneBefore: MediaHubRawSettings = {
  omdbApiKey: enc('phone-own-omdb'),
  traktAccessToken: enc('phone-own-trakt'),
  osToken: enc('stale-session')
}
const phone = applyBundle(phoneBefore, openBundle(ticket, sealed)!, enc)
assert.equal(dec(phone.torboxToken), 'tb-token')
assert.equal(phone.onboardingVersion, 2)
assert.equal(phone.simklClientId, 'simkl-id')
assert.equal(dec(phone.simklAccessToken), 'simkl-token')
assert.equal(dec(phone.traktClientSecret), 'trakt-secret')
assert.equal(dec(phone.osPassword), 'os-pass')
assert.equal(phone.subtitleLanguage, 'en')
// What the phone already had and the desktop didn't send is kept.
assert.equal(dec(phone.omdbApiKey), 'phone-own-omdb')
assert.equal(dec(phone.traktAccessToken), 'phone-own-trakt')
// A new OpenSubtitles login makes the old session meaningless.
assert.equal(phone.osToken, undefined)
// The input is not mutated.
assert.equal(phoneBefore.torboxToken, undefined)

console.log('devicePairing: ok')
