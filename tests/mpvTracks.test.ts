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

type FakePlayer = { player: MpvPlayer; sent: string[]; emit(event: string): void }

/** An MpvPlayer wired to a stub socket that records what was written and
 *  auto-answers every request, so awaited command() calls resolve. `emit`
 *  delivers an mpv event the way the real socket would. */
function fakePlayer(replyError = 'success'): FakePlayer {
  const sent: string[] = []
  const player = new MpvPlayer()
  const receive = (message: object): void =>
    (player as unknown as { onData(chunk: string): void }).onData(`${JSON.stringify(message)}\n`)
  ;(player as unknown as { socket: unknown }).socket = {
    write(line: string) {
      sent.push(line)
      const { request_id: requestId } = JSON.parse(line) as { request_id: number }
      queueMicrotask(() => receive({ request_id: requestId, error: replyError, data: null }))
      return true
    },
    destroy() {
      /* the stub owns no resources */
    }
  }
  return { player, sent, emit: (event) => receive({ event }) }
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
async function launchArgs(wid?: MpvSpawnOptions['wid']): Promise<string[]> {
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
  await new MpvPlayer().start('mpv.exe', { wid, spawnImpl }).catch(() => {})
  return captured
}

/**
 * Starts a load without awaiting it, so the writes can be inspected while
 * loadFile is still waiting on `file-loaded`. The returned `finish` delivers
 * that event and awaits the load — call it (in a `finally`) before the check
 * ends. Left pending, loadFile's 60-second file-loaded timer keeps the process
 * alive a full minute after the last assertion.
 */
function startLoad(
  { player, emit }: FakePlayer,
  options: Parameters<MpvPlayer['loadFile']>[1]
): () => Promise<void> {
  const load = player.loadFile('https://example.com/a.mkv', options)
  // Marks an early rejection as handled; `finish` still rethrows it.
  load.catch(() => {})
  return async () => {
    emit('file-loaded')
    await load
  }
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
    const fake = fakePlayer()
    const finish = startLoad(fake, { startSeconds: 90 })
    try {
      await settle()
      const starts = writesFor(fake.sent, 'start')
      assert.deepEqual(starts, ['90'], `start was written as ${JSON.stringify(starts)}`)
      assert.equal(typeof starts[0], 'string')
    } finally {
      await finish()
    }
  })

  await checkAsync('loadFile omits start entirely when there is nowhere to resume', async () => {
    for (const options of [{}, { startSeconds: 0 }, { startSeconds: Number.NaN }]) {
      const fake = fakePlayer()
      const finish = startLoad(fake, options)
      try {
        await settle()
        assert.deepEqual(
          writesFor(fake.sent, 'start'),
          [],
          `wrote start for ${JSON.stringify(options)}`
        )
      } finally {
        await finish()
      }
    }
  })

  await checkAsync('loadFile passes language preferences through as strings', async () => {
    const fake = fakePlayer()
    const finish = startLoad(fake, { audioLanguage: 'en', subtitleLanguage: 'fr' })
    try {
      await settle()
      assert.deepEqual(writesFor(fake.sent, 'alang'), ['en'])
      assert.deepEqual(writesFor(fake.sent, 'slang'), ['fr'])
    } finally {
      await finish()
    }
  })

  await checkAsync('loadFile refuses a URL that fails the SSRF guard', async () => {
    const { player } = fakePlayer()
    await assert.rejects(
      () => player.loadFile('file:///C:/Windows/win.ini'),
      /valid HTTPS media URL/
    )
  })

  await checkAsync('a window id embeds the player as a child of that window', async () => {
    const args = await launchArgs('5901740')
    assert.ok(
      args.includes('--wid=5901740'),
      `launch args do not embed into the supplied window: ${args.join(' ')}`
    )
    // The floating-window era's screen-placement args must stay gone: the
    // child is placed by mpvEmbed's SetWindowPos in client coordinates, and a
    // stray --geometry/--fs-screen would hand mpv screen-level opinions it no
    // longer owns (mpv fullscreen and window geometry both belonged to the
    // window mpv no longer has).
    for (const stale of ['--geometry', '--fs-screen', '--no-keepaspect-window', '--no-border']) {
      assert.deepEqual(
        args.filter((arg) => arg.startsWith(stale)),
        [],
        `stale floating-window arg survived: ${stale}`
      )
    }
  })

  await checkAsync('the window id is omitted when none is supplied', async () => {
    const args = await launchArgs()
    assert.deepEqual(
      args.filter((arg) => arg.startsWith('--wid')),
      []
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
    // The keyboard backstop keeps its full set even though the embedded child
    // should never hold focus (see MpvPlayer.bindSafetyKeys) — if an event
    // ever does land there, every key must still mean what it means in the
    // overlay. Seeking already has its pair; volume needs the same.
    assert.ok(
      bindings.includes('UP script-message r3-volume-up'),
      `UP is not bound: ${bindings.join(', ')}`
    )
    assert.ok(
      bindings.includes('DOWN script-message r3-volume-down'),
      `DOWN is not bound: ${bindings.join(', ')}`
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

  // --- Hang watchdog (MpvPlayer.checkForHang) -------------------------------
  // A player whose socket swallows every request, with a stub child whose
  // kill() is recorded: the shape of mpv stuck in a blocking read, which is
  // what left a frozen picture over the whole app (see HANG_MS in mpv.ts).

  type Silent = {
    player: MpvPlayer
    killed: () => boolean
    hung: () => number
    receive: (message: object) => void
  }
  function silentPlayer(): Silent {
    const player = new MpvPlayer()
    let killed = false
    let hung = 0
    const inner = player as unknown as {
      socket: unknown
      child: unknown
      onHung: () => void
      onData(chunk: string): void
    }
    inner.socket = {
      write: () => true,
      destroy: () => undefined
    }
    inner.child = {
      killed: false,
      kill: () => {
        killed = true
        return true
      },
      once: (_event: string, handler: () => void) => setImmediate(handler)
    }
    inner.onHung = () => {
      hung++
    }
    return {
      player,
      killed: () => killed,
      hung: () => hung,
      receive: (message) => inner.onData(`${JSON.stringify(message)}\n`)
    }
  }
  await checkAsync('a request unanswered for ten silent seconds kills the player', async () => {
    const { player, killed, hung } = silentPlayer()
    const now = Date.now()
    const seek = player.command('seek', 100, 'absolute')
    assert.strictEqual(player.checkForHang(now + 5_000), false, 'five seconds is not a hang')
    assert.strictEqual(player.checkForHang(now + 10_500), true, 'ten seconds is')
    await assert.rejects(seek, /shut down/)
    await settle()
    assert.ok(killed(), 'the process was not killed')
    assert.strictEqual(hung(), 1, 'onHung should have been told exactly once')
  })

  await checkAsync('a player that is still talking is never killed', async () => {
    const { player, killed, receive } = silentPlayer()
    const now = Date.now()
    void player.command('seek', 100, 'absolute').catch(() => {})
    // mpv emits time-pos several times a second while it plays; one such
    // event after the request means the core is alive, however slow this
    // particular command is.
    receive({ event: 'property-change', id: 999, data: 101 })
    assert.strictEqual(player.checkForHang(now + 30_000), false)
    assert.ok(!killed())
    await player.kill()
  })

  await checkAsync('nothing is judged while a file is opening', async () => {
    const { player, killed } = silentPlayer()
    const now = Date.now()
    // loadFile sends `loadfile` and then waits on file-loaded, during which
    // mpv blocks on the network by design. The hang check stands down.
    const load = player.loadFile('https://example.com/x.mkv')
    await settle()
    assert.strictEqual(player.checkForHang(now + 30_000), false)
    assert.ok(!killed())
    await player.kill()
    await load.catch(() => {})
  })

  await checkAsync('an idle player with nothing outstanding is left alone', async () => {
    const { player, killed } = silentPlayer()
    assert.strictEqual(player.checkForHang(Date.now() + 60_000), false)
    assert.ok(!killed())
  })

  console.log(`
${pass} checks passed`)
}

void main()
