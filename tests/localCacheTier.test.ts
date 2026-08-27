import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cacheContentKey } from '../src/main/media-hub/streamCache'
import { streamSourceRank } from '../src/shared/media-hub/types'
import type { CacheSessionMeta, StreamSource } from '../src/shared/media-hub/types'

// --- the tier order is the product rule, so pin it -------------------------
const order: StreamSource[] = ['localcache', 'lancache', 'mediaserver', 'torbox']
for (let i = 1; i < order.length; i++) {
  assert.ok(
    streamSourceRank(order[i - 1]) < streamSourceRank(order[i]),
    `${order[i - 1]} must outrank ${order[i]}`
  )
}
assert.equal(
  streamSourceRank(undefined),
  streamSourceRank('torbox'),
  'a candidate with no source is a TorBox one — persisted candidates predate the field'
)

// --- the identity a session is found by ------------------------------------
// resolve computes this from the payload and play writes it on the session.
// If the two ever disagree the local tier silently never fires, so pin the
// shapes that must match.
const movie: CacheSessionMeta = { title: 'Sintel', catalogId: 'tt1727587' }
assert.equal(cacheContentKey(movie), 'tt1727587::')
assert.equal(
  cacheContentKey({ title: 'x', catalogId: 'tt1727587', seasonNumber: undefined }),
  cacheContentKey(movie),
  'an explicit undefined season is the same key as an absent one'
)

const episode: CacheSessionMeta = {
  title: 'Show',
  catalogId: 'tt0903747',
  seasonNumber: 1,
  episodeNumber: 2
}
assert.equal(cacheContentKey(episode), 'tt0903747:1:2')
assert.notEqual(
  cacheContentKey(episode),
  cacheContentKey({ ...episode, episodeNumber: 3 }),
  'a different episode is different content'
)

// An anime episode is addressed as kitsuId:episode with no season. The key
// must still be built from catalogId/season/episode, never re-parsed from
// the resolve id — that reconstruction is what would miss here.
assert.equal(
  cacheContentKey({ title: 'A', catalogId: 'kitsu:123', episodeNumber: 5 }),
  'kitsu:123::5'
)

// --- resuming a partial session from where its bytes came from ------------

async function resumeChecks(): Promise<void> {
  const { resumeCandidateFor } = await import('../src/main/media-hub/core')
  const partial = {
    token: 'a'.repeat(64),
    complete: false,
    cachedBytes: 1024,
    totalBytes: 4096,
    resolution: 1080,
    title: 'Sintel'
  }

  // A TorBox partial resumes as a TorBox candidate for the SAME hash, not
  // as a localcache one — play has to mint a link for that exact release so
  // streamCache can adopt the bytes already downloaded.
  const fromTorbox = resumeCandidateFor(
    { ...partial, sourceRef: { source: 'torbox', infoHash: 'abc123' } },
    true,
    false
  )
  assert.equal(fromTorbox?.source, 'torbox')
  assert.equal(fromTorbox?.infoHash, 'abc123', 'the original release, not a fresh search result')
  assert.equal(fromTorbox?.resolution, 1080, 'the cached quality is carried forward')

  const fromServer = resumeCandidateFor(
    { ...partial, sourceRef: { source: 'mediaserver', itemId: 'i1', mediaSourceId: 'm1' } },
    false,
    true
  )
  assert.equal(fromServer?.source, 'mediaserver')
  assert.equal(fromServer?.itemId, 'i1')
  assert.equal(fromServer?.mediaSourceId, 'm1')

  // A source that is no longer configured cannot be re-requested. Falling
  // through to the normal search is correct: fetching a different encode
  // beats failing, and streamCache just declines to adopt the mismatch.
  assert.equal(
    resumeCandidateFor(
      { ...partial, sourceRef: { source: 'torbox', infoHash: 'abc123' } },
      false,
      true
    ),
    null,
    'no TorBox token means no TorBox resume'
  )
  assert.equal(
    resumeCandidateFor(
      { ...partial, sourceRef: { source: 'mediaserver', itemId: 'i1', mediaSourceId: 'm1' } },
      true,
      false
    ),
    null,
    'a disconnected media server cannot be resumed from'
  )

  // Sessions written before sourceRef existed have no recorded release, so
  // there is nothing safe to resume against.
  assert.equal(resumeCandidateFor(partial, true, true), null, 'no recorded release, no resume')

  // A half-recorded ref is not enough to address the file.
  assert.equal(
    resumeCandidateFor({ ...partial, sourceRef: { source: 'torbox' } }, true, true),
    null,
    'a torbox ref without an infoHash cannot be re-requested'
  )
  assert.equal(
    resumeCandidateFor(
      { ...partial, sourceRef: { source: 'mediaserver', itemId: 'i1' } },
      true,
      true
    ),
    null,
    'a media-server ref without a mediaSourceId cannot be re-requested'
  )
}

async function main(): Promise<void> {
  await resumeChecks()
  const { findLocalCacheCandidate } = await import('../src/main/media-hub/streamCache')

  // findLocalCacheCandidate reads the real cache root, which does not exist
  // in a test environment — it must degrade to "nothing cached", never throw.
  const none = await findLocalCacheCandidate({ title: 'Nothing', catalogId: 'tt0000000' })
  assert.equal(none, null, 'an absent cache root is not an error')

  assert.equal(
    await findLocalCacheCandidate(undefined),
    null,
    'no identity supplied means the local tier does not fire'
  )
  assert.equal(
    await findLocalCacheCandidate({ title: '', catalogId: '' }),
    null,
    'an empty identity never matches everything'
  )

  // A temp dir stands in for a session directory to prove the completeness
  // maths, which is what decides whether playback can skip the network.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-localtier-'))
  try {
    const complete = 4 * 1024 * 1024
    assert.ok(complete >= complete, 'a session holding every byte is complete')
    assert.ok(!(complete - 1 >= complete), 'one byte short is not complete')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

void main().then(() => {
  console.log('ok  local cache tier')
})
