// Unit tests for the mpv track-list adapter (src/main/media-hub/mpv.ts).
// Run with: npx tsx tests/mpvTracks.test.ts   (or npm.cmd test)
//
// The ordinal conversion is the reason this file exists. `MediaTrack.ordinal`
// is 0-based per type (inherited from the ffprobe-era parseMediaTracks, and
// still what every renderer call site speaks), while mpv's aid/sid are 1-based
// per type. An off-by-one here does not throw — it silently selects the
// neighbouring track, which is exactly the class of bug that is miserable to
// notice in a movie with two similar audio tracks.

import assert from 'node:assert'
import {
  mpvTrackIdForOrdinal,
  ordinalForMpvTrackId,
  tracksFromMpvTrackList,
  type MpvTrackListEntry
} from '../src/main/media-hub/mpv'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

// Shaped exactly like a real `track-list` payload, taken from the multi-track
// fixture used to validate the engine swap (h264 video, English AAC marked
// default, French AC3, English SRT).
const SAMPLE: MpvTrackListEntry[] = [
  {
    id: 1,
    type: 'video',
    'src-id': 0,
    codec: 'h264',
    default: true,
    'demux-w': 1280,
    'demux-h': 720
  },
  {
    id: 1,
    type: 'audio',
    'src-id': 1,
    codec: 'aac',
    lang: 'eng',
    title: 'English AAC',
    default: true,
    'demux-channel-count': 2
  },
  {
    id: 2,
    type: 'audio',
    'src-id': 2,
    codec: 'ac3',
    lang: 'fre',
    title: 'French AC3',
    default: false,
    'demux-channel-count': 6
  },
  { id: 1, type: 'sub', 'src-id': 3, codec: 'subrip', lang: 'eng', default: false }
]

check('groups tracks by type, mapping mpv "sub" onto "subtitle"', () => {
  const tracks = tracksFromMpvTrackList(SAMPLE)
  assert.equal(tracks.video.length, 1)
  assert.equal(tracks.audio.length, 2)
  assert.equal(tracks.subtitle.length, 1)
  assert.equal(tracks.probed, true)
})

check('ordinals are 0-based and per type', () => {
  const tracks = tracksFromMpvTrackList(SAMPLE)
  assert.deepEqual(
    tracks.audio.map((t) => t.ordinal),
    [0, 1]
  )
  assert.equal(tracks.subtitle[0].ordinal, 0)
  assert.equal(tracks.video[0].ordinal, 0)
})

check('ordinal -> mpv id round-trips for every track in the list', () => {
  const tracks = tracksFromMpvTrackList(SAMPLE)
  for (const track of tracks.audio) {
    assert.equal(ordinalForMpvTrackId(mpvTrackIdForOrdinal(track.ordinal)), track.ordinal)
  }
  // The concrete case that matters: picking the second audio track in the menu
  // must set aid=2, not aid=1.
  assert.equal(mpvTrackIdForOrdinal(tracks.audio[1].ordinal), 2)
})

check('a negative ordinal means "no track", which mpv spells "no"', () => {
  assert.equal(mpvTrackIdForOrdinal(-1), 'no')
  assert.equal(mpvTrackIdForOrdinal(1.5), 'no')
})

check('mpv reporting a disabled or unresolved track maps back to -1', () => {
  assert.equal(ordinalForMpvTrackId(false), -1)
  assert.equal(ordinalForMpvTrackId('auto'), -1)
  assert.equal(ordinalForMpvTrackId(0), -1)
  assert.equal(ordinalForMpvTrackId(undefined), -1)
})

check('carries codec, language, title and default through', () => {
  const [english, french] = tracksFromMpvTrackList(SAMPLE).audio
  assert.equal(english.codec, 'aac')
  assert.equal(english.language, 'eng')
  assert.equal(english.title, 'English AAC')
  assert.equal(english.default, true)
  assert.equal(french.codec, 'ac3')
  assert.equal(french.default, false)
})

check('src-id becomes index; a track without one reports -1', () => {
  const tracks = tracksFromMpvTrackList([
    ...SAMPLE,
    // What sub-add produces for an external subtitle file: no container stream.
    { id: 2, type: 'sub', codec: 'subrip', lang: 'eng', title: 'External' }
  ])
  assert.equal(tracks.audio[1].index, 2)
  assert.equal(tracks.subtitle[1].index, -1)
})

check('labels match the formatting the old ffprobe path produced', () => {
  const tracks = tracksFromMpvTrackList(SAMPLE)
  assert.equal(tracks.audio[0].label, 'English AAC • ENG • 2ch • AAC')
  assert.equal(tracks.audio[1].label, 'French AC3 • FRE • 6ch • AC3')
  assert.equal(tracks.video[0].label, 'Video 1 • 1280×720 • H264')
  // No title tag -> a positional name, 1-based for humans.
  assert.equal(tracks.subtitle[0].label, 'Subtitle 1 • ENG • SUBRIP')
})

check('duration is carried only when it is a real positive number', () => {
  assert.equal(tracksFromMpvTrackList(SAMPLE, 1234.5).durationSeconds, 1234.5)
  assert.equal(tracksFromMpvTrackList(SAMPLE).durationSeconds, undefined)
  assert.equal(tracksFromMpvTrackList(SAMPLE, 0).durationSeconds, undefined)
  // mpv reports no duration at all for a live stream.
  assert.equal(tracksFromMpvTrackList(SAMPLE, Number.NaN).durationSeconds, undefined)
})

check('unknown track types and an empty list are handled', () => {
  const tracks = tracksFromMpvTrackList([{ id: 1, type: 'attachment', codec: 'ttf' }])
  assert.equal(tracks.video.length + tracks.audio.length + tracks.subtitle.length, 0)
  assert.equal(tracks.probed, true)
  assert.equal(tracksFromMpvTrackList().audio.length, 0)
})

console.log(`\n${pass} checks passed`)
