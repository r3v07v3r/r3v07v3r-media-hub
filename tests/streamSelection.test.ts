import assert from 'node:assert/strict'
import { rankStreams } from '../src/main/media-hub/core'
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
