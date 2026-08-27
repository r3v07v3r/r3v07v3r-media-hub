// The upgrade-path migration for connected-service settings
// (shared/ipc-types.ts's withServiceDefaults).
//
// electron-store's own `defaults` only ever applies when the store KEY
// ITSELF is entirely absent — never when it exists but is missing a nested
// field a later release added. Without this merge, an install that saved
// its settings before a new service ID existed has a `services` object
// short one key FOREVER: reads silently drop the new card, and writes get
// rejected outright by a shape check requiring every current ID to be
// present. This pins down both halves of that failure and the fix.

import assert from 'node:assert/strict'

import {
  DEFAULT_SERVICE_SETTINGS,
  withServiceDefaults,
  type ServiceSettings
} from '../src/shared/ipc-types'

// A pre-Prowlarr install's stored object — exactly what electron-store
// hands back on an upgraded machine: four keys, no fifth.
const legacy = {
  jellyfin: { baseUrl: 'http://jellyfin.local', apiKey: 'jf-key', enabled: true },
  sonarr: { baseUrl: 'http://sonarr.local', apiKey: 'sonarr-key', enabled: true },
  radarr: { baseUrl: '', apiKey: '', enabled: false },
  qbittorrent: { baseUrl: '', apiKey: '', enabled: false }
} as unknown as Partial<ServiceSettings>

const merged = withServiceDefaults(legacy)

// The missing key is filled from the default template, not left absent —
// this is what makes the settings card render at all instead of the
// service silently vanishing from the list.
assert.deepEqual(merged.prowlarr, DEFAULT_SERVICE_SETTINGS.prowlarr)

// Every field that WAS already there survives untouched — a migration must
// not cost anyone their saved Jellyfin URL to gain a Prowlarr slot.
assert.deepEqual(merged.jellyfin, legacy.jellyfin)
assert.deepEqual(merged.sonarr, legacy.sonarr)

// The merged object now has every key this app currently knows about,
// which is exactly what the shape check downstream requires to accept a
// save — the second half of the bug this fixes.
assert.deepEqual(Object.keys(merged).sort(), Object.keys(DEFAULT_SERVICE_SETTINGS).sort())

// A real prowlarr entry already present is never overwritten by the
// default just because OTHER keys are also being filled in.
const partial = {
  ...legacy,
  prowlarr: { baseUrl: 'http://prowlarr.local', apiKey: 'p-key', enabled: true }
}
assert.deepEqual(withServiceDefaults(partial).prowlarr, partial.prowlarr)

// A completely empty/missing store (a fresh install) resolves to exactly
// the default template — the ordinary, already-working case this change
// must not disturb.
assert.deepEqual(withServiceDefaults(undefined), DEFAULT_SERVICE_SETTINGS)
assert.deepEqual(withServiceDefaults({}), DEFAULT_SERVICE_SETTINGS)

console.log('service settings migration tests passed')
