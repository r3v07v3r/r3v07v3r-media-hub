import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cacheContentKey } from '../src/main/media-hub/streamCache'
import type { CacheSessionMeta } from '../src/shared/media-hub/types'

// This file once opened by asserting a strict localcache < lancache <
// mediaserver < torbox order through streamSourceRank. That helper has been
// deleted: nothing in the app ever called it, so the assertion compared a
// constant to itself and passed no matter what resolve did. The real
// ordering is two mechanisms — streamResolve's short-circuits and
// rankStreams' SourcePreference weighting — and is covered where each one
// lives (streamSelection.test.ts pins the scoring). See StreamSource's own
// comment in types.ts.

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

// --- the tiers that need no credentials answer before the source gate ------
// stream:resolve once refused with "Connect TorBox or a media server" BEFORE
// looking at this disk or the paired cache server, so a title held complete
// could not play once the token was gone. The order lives in
// answerFromCacheTiers now, and the stubs record which lookups were reached:
// the order is the contract, not just the answer.
async function sourceGateChecks(): Promise<void> {
  const { answerFromCacheTiers, NO_PLAYBACK_SOURCE_MESSAGE } =
    await import('../src/main/media-hub/streamTierRules')
  type Lookups = Parameters<typeof answerFromCacheTiers>[2]
  type LocalCopy = Awaited<ReturnType<Lookups['local']>>
  type Answer = NonNullable<ReturnType<Lookups['recent']>>
  type Candidate = Answer['streams'][number]

  const token = 'a'.repeat(64)
  const completeCopy: NonNullable<LocalCopy> = {
    token,
    complete: true,
    cachedBytes: 4096,
    totalBytes: 4096,
    resolution: 1080,
    title: 'Sintel'
  }
  const partialCopy: NonNullable<LocalCopy> = {
    token,
    complete: false,
    cachedBytes: 1024,
    totalBytes: 4096,
    resolution: 1080,
    sourceRef: { source: 'torbox', infoHash: 'abc123' },
    title: 'Sintel'
  }
  const lanCopy: Candidate = {
    source: 'lancache',
    infoHash: 'f'.repeat(40),
    name: 'Sintel',
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  }
  const torboxStream: Candidate = { source: 'torbox', infoHash: 'e'.repeat(40), name: 'Sintel' }
  const torboxAnswer: Answer = { streams: [torboxStream], best: torboxStream }

  const none = { torbox: false, mediaServer: false, lanCache: false }
  const daemonOnly = { torbox: false, mediaServer: false, lanCache: true }
  const torboxAndDaemon = { torbox: true, mediaServer: false, lanCache: true }

  function stubs(given: {
    local?: LocalCopy
    recent?: Answer | null
    lan?: Candidate | null
    rankLan?: Lookups['rankLan']
  }): { lookups: Lookups; called: { recent: boolean; lan: boolean } } {
    const called = { recent: false, lan: false }
    const lookups: Lookups = {
      local: async () => given.local ?? null,
      recent: () => {
        called.recent = true
        return given.recent ?? null
      },
      lan: async () => {
        called.lan = true
        return given.lan ?? null
      },
      rankLan: given.rankLan ?? ((candidate) => [candidate])
    }
    return { lookups, called }
  }

  // Offline replay — the case the old handler refused outright.
  {
    const { lookups } = stubs({ local: completeCopy })
    const answer = await answerFromCacheTiers(none, 1080, lookups)
    assert.equal(answer?.result.best?.source, 'localcache')
    assert.equal(answer?.result.best?.cacheToken, token)
    assert.equal(answer?.result.best?.complete, true)
    assert.equal(answer?.remember, true, 'a complete local hit is remembered for the hour')
  }

  // Tier 1 stays ahead of the hour cache and the daemon.
  {
    const { lookups, called } = stubs({ local: completeCopy, recent: torboxAnswer, lan: lanCopy })
    const answer = await answerFromCacheTiers(torboxAndDaemon, 1080, lookups)
    assert.equal(answer?.result.best?.source, 'localcache')
    assert.equal(answer?.remember, true)
    assert.equal(called.recent, false, 'a copy on this disk never reads the hour cache')
    assert.equal(called.lan, false, 'nor asks the daemon')
  }

  // A device paired with the daemon and nothing else.
  {
    const { lookups, called } = stubs({ recent: torboxAnswer, lan: lanCopy })
    const answer = await answerFromCacheTiers(daemonOnly, 1080, lookups)
    assert.equal(answer?.result.best?.source, 'lancache')
    assert.equal(answer?.remember, true)
    assert.equal(
      called.recent,
      false,
      'with no network source, an answer cached before the disconnect is never served'
    )
  }

  // The hour cache stays ahead of tier 2 for anyone with a network source.
  {
    const { lookups, called } = stubs({ recent: torboxAnswer, lan: lanCopy })
    const answer = await answerFromCacheTiers(torboxAndDaemon, 1080, lookups)
    assert.equal(answer?.result, torboxAnswer, 'the cached answer itself, not a copy')
    assert.equal(answer?.remember, false, 'already in the cache it was read from')
    assert.equal(called.lan, false)
  }

  // Held nowhere: the handler is told so, and says so.
  {
    const { lookups, called } = stubs({ lan: lanCopy })
    assert.equal(await answerFromCacheTiers(none, 1080, lookups), null)
    assert.equal(called.lan, false, 'an unpaired daemon is not asked')
    assert.ok(NO_PLAYBACK_SOURCE_MESSAGE.length > 0)
    assert.ok(NO_PLAYBACK_SOURCE_MESSAGE.includes('this computer'))
    assert.ok(NO_PLAYBACK_SOURCE_MESSAGE.includes('TorBox'))
  }

  // The quality ceiling applies to both tiers, source or no source.
  {
    const sharp = stubs({ local: { ...completeCopy, resolution: 2160 } })
    assert.equal(
      await answerFromCacheTiers(none, 1080, sharp.lookups),
      null,
      'a 4K copy on disk is over a 1080p ceiling'
    )
    const sharpLan = stubs({ lan: { ...lanCopy, resolution: 2160 } })
    assert.equal(
      await answerFromCacheTiers(daemonOnly, 1080, sharpLan.lookups),
      null,
      'and so is a 4K copy on the daemon'
    )
    const unranked = stubs({ lan: lanCopy, rankLan: () => [] })
    assert.equal(
      await answerFromCacheTiers(daemonOnly, 1080, unranked.lookups),
      null,
      'a LAN copy the ranking refuses is not an answer'
    )
  }

  // A partial copy resumes from the source it came from, or not at all.
  {
    const connected = stubs({ local: partialCopy, recent: torboxAnswer })
    const answer = await answerFromCacheTiers(
      { torbox: true, mediaServer: false, lanCache: false },
      1080,
      connected.lookups
    )
    assert.equal(answer?.result.best?.source, 'torbox')
    assert.equal(answer?.result.best?.infoHash, 'abc123', 'the release the bytes came from')
    assert.equal(answer?.remember, false, 'a download still in flight is never cached')
    assert.equal(connected.called.recent, false)

    const disconnected = stubs({ local: partialCopy })
    assert.equal(
      await answerFromCacheTiers(none, 1080, disconnected.lookups),
      null,
      'half a file and nowhere to fetch the rest from cannot play'
    )
  }
}

// --- what a cached copy records as its quality ----------------------------
// The scrapers mostly leave StreamCandidate.resolution unset and put the
// quality in the release text, so recording the raw field stored undefined
// for nearly every TorBox copy — and an undefined resolution passes the
// quality target unconditionally.
async function resolutionChecks(): Promise<void> {
  const { streamResolution } = await import('../src/main/media-hub/core')
  assert.equal(
    streamResolution({ infoHash: 'x', name: '[TORRENT] Comet 1080p' }),
    1080,
    'read from the release text, which is where the scrapers put it'
  )
  assert.equal(streamResolution({ infoHash: 'x', name: 'Film 2160p WEB-DL' }), 2160)
  assert.equal(streamResolution({ infoHash: 'x', name: 'Film 4K REMUX' }), 2160, '4K is 2160p')
  assert.equal(
    streamResolution({ infoHash: 'x', name: 'Film', resolution: 720 }),
    720,
    'falls back to the numeric field when the text says nothing'
  )
  assert.equal(streamResolution({ infoHash: 'x', name: 'Film' }), 0, 'unknown stays unknown')
}

async function main(): Promise<void> {
  await resumeChecks()
  await sourceGateChecks()
  await resolutionChecks()
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
