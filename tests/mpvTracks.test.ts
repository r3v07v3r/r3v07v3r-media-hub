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
  mpvSearchCandidates,
  mpvTrackIdForOrdinal,
  ordinalForMpvTrackId,
  tracksFromMpvTrackList,
  type MpvSpawnOptions,
  type MpvTrackListEntry
} from '../src/main/media-hub/mpv'
import { MAX_PLAYER_VOLUME } from '../src/shared/media-hub/player'

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

/** Which properties were written, in the order they went on the wire. */
function propertiesWritten(sent: string[]): string[] {
  return sent
    .map((line) => JSON.parse(line) as { command: unknown[] })
    .filter((msg) => msg.command[0] === 'set_property')
    .map((msg) => String(msg.command[1]))
}

function writesFor(sent: string[], property: string): unknown[] {
  return sent
    .map((line) => JSON.parse(line) as { command: unknown[] })
    .filter((msg) => msg.command[0] === 'set_property' && msg.command[1] === property)
    .map((msg) => msg.command[2])
}

/**
 * Runs start() far enough to capture the launch arguments, without a real mpv.
 *
 * The stub child reports 'exit' the moment start() subscribes, which clears
 * `this.child` and makes the IPC connect loop give up on its first attempt
 * instead of retrying a named pipe that will never exist for ten seconds. The
 * rejection that follows is the point at which the arguments have already been
 * built, so it is swallowed.
 */
async function launchArgs(bounds?: MpvSpawnOptions['bounds']): Promise<string[]> {
  let captured: string[] = []
  const spawnImpl = ((_command: string, args: string[]) => {
    captured = args
    return {
      stderr: {
        on(): void {
          /* start() subscribes to stderr; this stub never emits any */
        }
      },
      once(event: string, handler: () => void): void {
        if (event === 'exit') handler()
      }
    }
  }) as unknown as NonNullable<MpvSpawnOptions['spawnImpl']>
  await new MpvPlayer().start('mpv.exe', { bounds, spawnImpl }).catch(() => {})
  return captured
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
  await checkAsync('mpv discovery does not synchronously scan PATH directories', async () => {
    // A stale UNC/removable-drive PATH entry makes `existsSync` block the
    // Electron main process on Windows. The player discovery path is hit at
    // startup and before first playback, so it must only inspect fixed local
    // candidates (or an explicitly supplied MPV_PATH).
    const originalPath = process.env.PATH
    const originalMpvPath = process.env.MPV_PATH
    process.env.PATH = '\\\\offline-server\\tools;C:\\another-missing-location'
    delete process.env.MPV_PATH
    try {
      const candidates = mpvSearchCandidates()
      assert.equal(
        candidates.some((candidate) => candidate?.includes('offline-server')),
        false,
        `mpv discovery unexpectedly scanned PATH: ${candidates.join(', ')}`
      )
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalMpvPath === undefined) delete process.env.MPV_PATH
      else process.env.MPV_PATH = originalMpvPath
    }
  })

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

  await checkAsync(
    'the window is the rectangle it is given, not the shape of the film',
    async () => {
      const args = await launchArgs({ x: 0, y: 0, width: 3440, height: 1440 })
      // Without this mpv defaults to keeping its WINDOW at the video's aspect
      // ratio, so it shrinks the size the geometry below just asked for and the
      // app shows through the strip left over — "fullscreen doesn't go quite
      // fullscreen, there is a gap on the right", on an ultrawide display.
      assert.ok(
        args.includes('--no-keepaspect-window'),
        `launch args do not disable window aspect locking: ${args.join(' ')}`
      )
      assert.ok(
        args.includes('--geometry=3440x1440+0+0'),
        `geometry was not the exact requested rectangle: ${args.join(' ')}`
      )
    }
  )

  await checkAsync('geometry is omitted entirely when there are no bounds to honour', async () => {
    const args = await launchArgs()
    assert.deepEqual(
      args.filter((arg) => arg.startsWith('--geometry')),
      []
    )
  })

  await checkAsync('a fullscreen film is mpv fullscreen, not a screen-sized window', async () => {
    const { player, sent } = fakePlayer()
    await player.setFullscreen(true)
    assert.deepEqual(
      writesFor(sent, 'fullscreen'),
      [true],
      // Asking for the screen's rectangle is not the same as asking for
      // fullscreen: mpv fits a merely-requested rectangle against the WORK
      // area, positions it relative to that area's origin, and shrinks what
      // does not fit with the request's aspect ratio preserved. Fullscreen
      // takes the monitor rect whole and skips all of it.
      `fullscreen was not written to mpv: ${sent.join(' ')}`
    )
  })

  await checkAsync('geometry is not written while mpv owns the rectangle', async () => {
    const { player, sent } = fakePlayer()
    await player.setFullscreen(true)
    await player.setBounds({ x: 0, y: 0, width: 3440, height: 1440 })
    assert.deepEqual(
      writesFor(sent, 'geometry'),
      [],
      // A geometry write landing during a fullscreen transition is at best
      // ignored and at worst becomes the rectangle mpv restores to on the way
      // out — and the app's window tracking emits a burst of them on every
      // transition.
      `a geometry write escaped while fullscreen: ${sent.join(' ')}`
    )

    await player.setFullscreen(false)
    await player.setBounds({ x: 0, y: 0, width: 1600, height: 900 })
    assert.deepEqual(
      writesFor(sent, 'geometry'),
      ['1600x900+0+0'],
      `tracking did not resume after leaving fullscreen: ${sent.join(' ')}`
    )
  })

  await checkAsync('a fullscreen film covers the screen it is playing on', async () => {
    const args = await launchArgs({ x: 0, y: 0, width: 3440, height: 1440 })
    // Which screen is decided from where mpv's window already is, and mpv's
    // window is positioned to the app's content area — so the film goes
    // fullscreen on the monitor the app is on, not on the primary.
    assert.ok(
      args.includes('--fs-screen=current'),
      `launch args do not pin the fullscreen screen: ${args.join(' ')}`
    )
  })

  await checkAsync('the volume ceiling the UI offers is one mpv will accept', async () => {
    const args = await launchArgs()
    // mpv rejects any `volume` above --volume-max and defaults that to 130%,
    // so a slider that runs to MAX_PLAYER_VOLUME without this arg goes dead
    // partway up: the two numbers have to be the same one.
    assert.ok(
      args.includes(`--volume-max=${MAX_PLAYER_VOLUME * 100}`),
      `launch args do not raise mpv's amplification ceiling: ${args.join(' ')}`
    )
  })

  await checkAsync('the volume keys reach the video window too', async () => {
    const { player, sent } = fakePlayer()
    await player.bindSafetyKeys()
    const bindings = sent
      .map((line) => JSON.parse(line) as { command: unknown[] })
      .filter((msg) => msg.command[0] === 'keybind')
      .map((msg) => `${String(msg.command[1])} ${String(msg.command[2])}`)
    // Without these, the volume keys would work only while the controls
    // overlay holds focus — and clicking the picture hands focus to mpv, so
    // the keys would stop working for the very reason someone reached for
    // them. Seeking already has this pair; volume needs the same.
    assert.ok(
      bindings.includes('UP script-message r3-volume-up'),
      `UP is not bound: ${bindings.join(', ')}`
    )
    assert.ok(
      bindings.includes('DOWN script-message r3-volume-down'),
      `DOWN is not bound: ${bindings.join(', ')}`
    )
  })

  await checkAsync('a retained player is put back in the window before it is given one', async () => {
    const { player, sent } = fakePlayer()
    // What the last session left behind. The mpv PROCESS outlives a session and
    // keeps its properties, and nothing tracks the app window between sessions
    // — so leaving fullscreen while stopped goes unheard.
    await player.setFullscreen(true)
    sent.length = 0

    // What starting a windowed title on that process has to do, in this order.
    await player.setFullscreen(false)
    await player.setBounds({ x: 0, y: 0, width: 1600, height: 900 })

    assert.deepEqual(
      propertiesWritten(sent),
      ['fullscreen', 'geometry'],
      // The other order loses the rectangle: geometry writes are dropped while
      // mpv still believes it is fullscreen, so the next title's window would
      // be created from the last session's bounds — screen-sized, over a
      // windowed app, for as long as the load takes.
      `stale fullscreen was not cleared before the rectangle: ${sent.join(' ')}`
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
