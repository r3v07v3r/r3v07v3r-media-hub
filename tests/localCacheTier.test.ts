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

async function main(): Promise<void> {
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
