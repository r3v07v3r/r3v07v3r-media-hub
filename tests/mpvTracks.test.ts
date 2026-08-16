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
  MpvPlayer,
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

// --- loadFile's property writes -------------------------------------------
// Regression guard for the bug that made every title fail to play. `start` is
// one of mpv's *time*-typed options, and over JSON IPC those accept a string
// ("0", "90", "00:01:30") and reject a number with MPV_ERROR_PROPERTY_ERROR —
// whose message, "error accessing property", names neither the property nor the
// reason. loadFile wrote it as a number on every call, so nothing ever loaded
// and that opaque line was the only evidence.
//
// Driven through a fake socket rather than a real mpv: what matters is the
// exact bytes put on the wire, which is where the bug was.

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}
      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

/** An MpvPlayer wired to a stub socket that records what was written and
 *  auto-answers every request, so awaited command() calls resolve. */
function fakePlayer(replyError = 'success'): { player: MpvPlayer; sent: string[] } {
  const sent: string[] = []
  const player = new MpvPlayer()
  ;(player as unknown as { socket: unknown }).socket = {
    write(line: string) {
      sent.push(line)
      const { request_id: requestId } = JSON.parse(line) as { request_id: number }
      queueMicrotask(() =>
        (player as unknown as { onData(chunk: string): void }).onData(
          `${JSON.stringify({ request_id: requestId, error: replyError, data: null })}
`
        )
      )
      return true
    },
    destroy() {
      /* the stub owns no resources */
    }
  }
  return { player, sent }
}

function writesFor(sent: string[], property: string): unknown[] {
  return sent
    .map((line) => JSON.parse(line) as { command: unknown[] })
    .filter((msg) => msg.command[0] === 'set_property' && msg.command[1] === property)
    .map((msg) => msg.command[2])
}

/** Starts a load without awaiting it — `file-loaded` never arrives on a fake
 *  socket, so the returned promise is expected to reject on its own timeout
 *  long after the assertions are done. Swallowed so it cannot surface as an
 *  unhandled rejection and fail the run. */
function startLoad(player: MpvPlayer, options: Parameters<MpvPlayer['loadFile']>[1]): void {
  void player.loadFile('https://example.com/a.mkv', options).catch(() => {})
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

async function main(): Promise<void> {
  await checkAsync('loadFile writes a non-zero start as a STRING, never a number', async () => {
    const { player, sent } = fakePlayer()
    startLoad(player, { startSeconds: 90 })
    await settle()
    const starts = writesFor(sent, 'start')
    assert.deepEqual(starts, ['90'], `start was written as ${JSON.stringify(starts)}`)
    assert.equal(typeof starts[0], 'string')
  })

  await checkAsync('loadFile omits start entirely when there is nowhere to resume', async () => {
    for (const options of [{}, { startSeconds: 0 }, { startSeconds: Number.NaN }]) {
      const { player, sent } = fakePlayer()
      startLoad(player, options)
      await settle()
      assert.deepEqual(writesFor(sent, 'start'), [], `wrote start for ${JSON.stringify(options)}`)
    }
  })

  await checkAsync('loadFile passes language preferences through as strings', async () => {
    const { player, sent } = fakePlayer()
    startLoad(player, { audioLanguage: 'en', subtitleLanguage: 'fr' })
    await settle()
    assert.deepEqual(writesFor(sent, 'alang'), ['en'])
    assert.deepEqual(writesFor(sent, 'slang'), ['fr'])
  })

  await checkAsync('loadFile refuses a URL that fails the SSRF guard', async () => {
    const { player } = fakePlayer()
    await assert.rejects(
      () => player.loadFile('file:///C:/Windows/win.ini'),
      /valid HTTPS media URL/
    )
  })

  await checkAsync('a rejected command names which call failed', async () => {
    const { player } = fakePlayer('error accessing property')
    // The bare mpv string is useless alone — this is precisely why the original
    // failure needed a reproduction harness to locate at all.
    await assert.rejects(
      () => player.set('start', 0),
      /error accessing property \(mpv: set_property start 0\)/
    )
  })

  console.log(`
${pass} checks passed`)
}

void main()
