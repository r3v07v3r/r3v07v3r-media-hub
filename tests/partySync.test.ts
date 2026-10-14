import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEAD_ZONE_SECONDS,
  HARD_SEEK_SECONDS,
  MAX_RATE_DELTA,
  SAMPLE_MAX_AGE_MS,
  expectedHostPosition,
  isSampleUsable,
  syncCorrection
} from '../src/shared/media-hub/partySync'

const sample = { mediaTime: 20, arrivedAt: 1_000, paused: false }

assert.equal(expectedHostPosition(sample, 3_500), 22.5)
assert.equal(expectedHostPosition({ ...sample, paused: true }, 3_500), 20)
assert.equal(expectedHostPosition(sample, 500), 20)

assert.equal(isSampleUsable(sample, 1_000 + SAMPLE_MAX_AGE_MS), true)
assert.equal(isSampleUsable(sample, 1_000 + SAMPLE_MAX_AGE_MS + 1), false)
assert.equal(isSampleUsable(sample, 999), false)
assert.equal(isSampleUsable({ ...sample, mediaTime: Number.NaN }, 1_000), false)

assert.deepEqual(syncCorrection(10, 10 + DEAD_ZONE_SECONDS / 2), { action: 'none' })
assert.deepEqual(syncCorrection(10, 10.5), { action: 'rate', rate: 1.04 })
assert.deepEqual(syncCorrection(10.5, 10), { action: 'rate', rate: 0.96 })
assert.deepEqual(syncCorrection(0, 100), { action: 'seek', position: 100 })
// Exactly at the hard-seek threshold is still steered, not seeked (the check
// is strictly greater-than), and the proportional term has saturated by then.
assert.deepEqual(syncCorrection(0, HARD_SEEK_SECONDS), {
  action: 'rate',
  rate: 1 + MAX_RATE_DELTA
})
// A hair past it flips to a seek. One threshold now, not one per playback
// mode — see HARD_SEEK_SECONDS.
assert.deepEqual(syncCorrection(0, HARD_SEEK_SECONDS + 0.01), {
  action: 'seek',
  position: HARD_SEEK_SECONDS + 0.01
})
assert.deepEqual(syncCorrection(Number.NaN, 10), { action: 'none' })
assert.deepEqual(syncCorrection(10, Number.POSITIVE_INFINITY), { action: 'none' })

// The host's invite code travels with party:status, so a party hosted from
// the player rail can still be shared from the main window once the player
// has closed, and a Rooms join request is handed the code instead of being
// told the host is in someone else's party. Read from the source: the
// handler needs Electron and sockets, and what matters is who gets the code.
const source = (file: string): string =>
  fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n')
const watchParty = source('src/main/media-hub/watchParty.ts')
const statusHandler = watchParty.slice(
  watchParty.indexOf('MEDIA_HUB_CHANNELS.partyStatus'),
  watchParty.indexOf('MEDIA_HUB_CHANNELS.partySetMemberControl')
)
assert.match(
  statusHandler,
  /current\.role === 'host' && current\.code\s*\?\s*\{ inviteCode: current\.code, beyondLan: current\.beyondLan, port: current\.port \}\s*:\s*\{\}/
)
assert.match(
  watchParty,
  /hostState\.code = code\n\s*hostState\.beyondLan = Boolean\(wan\) \|\| Boolean\(hostState\.relay\)/
)

const context = source('src/renderer/src/context/AppStateContext.tsx')
const refresh = context.slice(
  context.indexOf('const refreshPartyStatus'),
  context.indexOf('}, [])', context.indexOf('const refreshPartyStatus'))
)
assert.match(
  refresh,
  /next\.inParty && next\.role === 'host' && next\.inviteCode\) \{\n\s*setPartyHostCode\(next\.inviteCode\)/
)
// A host whose code has not arrived yet does not claim to be in someone
// else's party.
const hostDecline = context.indexOf("They're starting a watch party. Try again in a moment.")
const otherDecline = context.indexOf("They're already in someone else's watch party.")
assert.ok(hostDecline > 0 && hostDecline < otherDecline)

const rail = source('src/renderer/src/components/party/PlayerSessionRail.tsx')
assert.match(
  rail,
  /next\.role === 'host' && next\.inviteCode\) \{\n\s*setInvite\(\{ code: next\.inviteCode, hostId: next\.selfId \?\? '' \}\)/
)

console.log('party sync tests passed')
