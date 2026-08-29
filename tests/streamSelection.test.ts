import assert from 'node:assert/strict'
import { rankStreams, streamSeeders } from '../src/main/media-hub/core'
import type { StreamCandidate } from '../src/shared/media-hub/types'

const streams: StreamCandidate[] = [
  { infoHash: '4k', name: 'Movie 2160p WEB-DL 18 GB', cached: true, compatible: true },
  { infoHash: 'large', name: 'Movie 1080p WEB-DL 9 GB', cached: true, compatible: true },
  { infoHash: 'fit', name: 'Movie 1080p WEB-DL 4.5 GB', cached: true, compatible: true },
  { infoHash: 'small', name: 'Movie 720p WEB-DL 1.5 GB', cached: true, compatible: true }
]

assert.equal(
  rankStreams(streams, 'en', { maxResolution: 1080, maxSizeGb: 5 })[0].infoHash,
  'fit',
  'screen and download-size limits are both applied'
)
assert.equal(
  rankStreams(streams, 'en', { maxResolution: 720, maxSizeGb: 2 })[0].infoHash,
  'small',
  'a slow-connection profile selects the smaller 720p release'
)
assert.equal(
  rankStreams(streams, 'en', { maxResolution: 480, maxSizeGb: 0 }).length,
  0,
  'an explicit maximum is never silently exceeded'
)

// --- media server as a second source ---------------------------------------

const localAndRemote: StreamCandidate[] = [
  { infoHash: 'remote4k', name: 'Movie 2160p WEB-DL 18 GB', cached: true, compatible: true },
  {
    source: 'mediaserver',
    itemId: 'jf-1',
    mediaSourceId: 'ms-1',
    name: 'Movie.2019.1080p.BluRay.x264.mkv',
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  }
]

assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'balanced')[0].source,
  'mediaserver',
  'balanced prefers a local 1080p over a remote 2160p — one tier is worth the instant start'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'prefer-quality')[0].infoHash,
  'remote4k',
  'prefer-quality ignores locality and takes the higher resolution'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'prefer-local')[0].source,
  'mediaserver',
  'prefer-local takes the server copy'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {})[0].source,
  'mediaserver',
  'balanced is the default when no preference is supplied'
)

// A local copy is still subject to the person's explicit limits.
assert.equal(
  rankStreams(localAndRemote, 'en', { maxResolution: 720 }, 'prefer-local').length,
  0,
  'an explicit resolution ceiling drops the local copy too'
)

// Locality must never outrank language — the same rule the remote path has.
const localWrongLanguage: StreamCandidate[] = [
  {
    source: 'mediaserver',
    itemId: 'jf-2',
    mediaSourceId: 'ms-2',
    name: 'Film.2019.TRUEFRENCH.1080p.BluRay.mkv',
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  },
  { infoHash: 'remote-en', name: 'Film 2019 1080p WEB-DL', cached: true, compatible: true }
]
assert.equal(
  rankStreams(localWrongLanguage, 'en', {}, 'balanced')[0].infoHash,
  'remote-en',
  'a local copy in the wrong language still loses to a correct-language remote'
)

// The streaming penalty models internet-pull latency, which a LAN file
// does not have — a local remux must not be demoted the way a remote one is.
const remuxes: StreamCandidate[] = [
  {
    source: 'mediaserver',
    itemId: 'jf-3',
    mediaSourceId: 'ms-3',
    name: 'Film.2019.2160p.REMUX.TrueHD.Atmos.mkv',
    resolution: 2160,
    cached: true,
    compatible: true,
    exact: true
  },
  { infoHash: 'remote-x264', name: 'Film 2019 1080p WEB-DL x264', cached: true, compatible: true }
]
assert.equal(
  rankStreams(remuxes, 'en', {}, 'balanced')[0].source,
  'mediaserver',
  'a local remux is not penalised — it is exactly what an on-site server is for'
)
assert.equal(
  rankStreams(
    [
      {
        infoHash: 'remote-remux',
        name: 'Film 2019 2160p REMUX TrueHD Atmos',
        cached: true,
        compatible: true
      },
      {
        infoHash: 'remote-x264',
        name: 'Film 2019 1080p WEB-DL x264',
        cached: true,
        compatible: true
      }
    ],
    'en',
    {}
  )[0].infoHash,
  'remote-x264',
  'a REMOTE remux is still penalised, exactly as before'
)

console.log('ok  stream selection resolution and size limits')

// --- seeders, for uncached candidates only ---------------------------------
// Both add-ons advertise a `👤 N` run in the text streamText already builds
// (confirmed live 2026-08-29). Until this landed, nothing read it — including
// the `queued` path, which submits the winner to TorBox to start caching, so
// the app could commit an account to a torrent nobody was seeding.
{
  const uncached = (infoHash: string, seeders: number | null, resolution = 1080): StreamCandidate =>
    ({
      infoHash,
      name: `Film ${resolution}p`,
      title: seeders === null ? 'Film.mkv 💾 4.0 GB' : `Film.mkv 👤 ${seeders} 💾 4.0 GB`,
      cached: false,
      compatible: true,
      exact: true
    }) as StreamCandidate

  assert.equal(streamSeeders(uncached('a', 284)), 284, 'reads the advertised count')
  assert.equal(streamSeeders(uncached('a', 0)), 0, 'zero is a real answer')
  assert.equal(streamSeeders(uncached('a', null)), null, 'a release that says nothing reports null')
  assert.equal(
    streamSeeders({ infoHash: 'a', title: 'Film 👤 2,081 💾 4.0 GB' } as StreamCandidate),
    2081,
    'thousands separators, as Torrentio writes them'
  )

  // Within a tier, the better-seeded release wins.
  assert.equal(
    rankStreams([uncached('dead', 2), uncached('alive', 400)], 'en', {}, 'balanced')[0].infoHash,
    'alive',
    'a well-seeded release beats a barely-seeded one of the same quality'
  )

  // ABSENCE IS NEUTRAL, which is neither zero nor no-bonus. Comet omits the
  // count on about half its results, so an unknown must not lose to a release
  // advertising a single seeder — but it must still lose to a healthy one.
  assert.equal(
    rankStreams([uncached('silent', null), uncached('barely', 1)], 'en', {}, 'balanced')[0]
      .infoHash,
    'silent',
    'an unknown seeder count beats a release advertising almost none'
  )
  assert.equal(
    rankStreams([uncached('silent', null), uncached('healthy', 400)], 'en', {}, 'balanced')[0]
      .infoHash,
    'healthy',
    'and still loses to a well-seeded one'
  )
  // A set where nothing reports a count is shifted by a constant, so the
  // ordering is exactly what it was before this term existed.
  assert.deepEqual(
    rankStreams([uncached('sd', null, 1080), uncached('hd', null, 2160)], 'en', {}, 'balanced').map(
      (s) => s.infoHash
    ),
    ['hd', 'sd'],
    'an all-unknown set is ordered by everything else, undisturbed'
  )

  // Never flips a resolution tier: the term is capped below one step.
  assert.equal(
    rankStreams([uncached('hd', 2081, 2160), uncached('sd', 5000, 1080)], 'en', {}, 'balanced')[0]
      .infoHash,
    'hd',
    'seeders order within a tier and never override the resolution the person asked for'
  )

  // A cached candidate needs no peers at all — and Comet's `👤 0` results are
  // largely debrid-cached, which are the MOST playable, not the least.
  const cachedNoSeeders = {
    infoHash: 'cached',
    name: 'Film 1080p',
    title: 'Film.mkv 👤 0 💾 4.0 GB',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([cachedNoSeeders, uncached('seeded', 5000)], 'en', {}, 'balanced')[0].infoHash,
    'cached',
    'cached beats well-seeded-but-uncached; seeders never apply to a cached copy'
  )
}
console.log('ok  seeder ranking')
