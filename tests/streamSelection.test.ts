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

console.log('ok  stream selection resolution and size limits')
