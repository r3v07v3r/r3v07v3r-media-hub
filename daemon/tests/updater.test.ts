// The self-update system's tests: version arithmetic, channel selection,
// the never-interrupt-playback restart gate, the launcher's rollback
// state machine (including a real boot→crash→rollback cycle against fake
// payload bundles on disk), and the updater's stage-and-verify against a
// stub release feed. This is the code that can brick a remote daemon —
// nothing here ships on "looks right".
// Run with: npx tsx daemon/tests/updater.test.ts

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { IDLE_GRACE_MS, STALE_UPDATE_MS, canRestartNow } from '../activity'
import {
  BUILTIN_VERSION_ID,
  launch,
  listStagedVersions,
  markHealthyState,
  orderStagedVersions,
  planBoot,
  readState,
  stagedBundlePath,
  writeState
} from '../launcher'
import { createUpdater } from '../updater'
import {
  isAllowedAssetUrl,
  isAllowedRedirectUrl,
  isNewerVersion,
  repoFromFeedUrl,
  selectUpdate
} from '../updateFeed'

// --- version arithmetic -----------------------------------------------------

assert.equal(isNewerVersion('1.0.84', '1.0.83'), true)
assert.equal(isNewerVersion('1.0.84-preview.2', '1.0.83'), true, 'newer preview beats older stable')
assert.equal(isNewerVersion('1.0.84', '1.0.84-preview.9'), true, 'stable beats its own previews')
assert.equal(isNewerVersion('1.0.84-preview.9', '1.0.84'), false)
assert.equal(isNewerVersion('1.0.84-preview.10', '1.0.84-preview.9'), true)
assert.equal(isNewerVersion('1.0.83', '1.0.83'), false)
assert.equal(isNewerVersion('garbage', '1.0.83'), false, 'unparseable is never an upgrade')

assert.deepEqual(orderStagedVersions(['1.0.83', '1.0.84-preview.2', '1.0.84', 'junk']), [
  '1.0.84',
  '1.0.84-preview.2',
  '1.0.83'
])

// --- feed selection ---------------------------------------------------------

const asset = (name: string): { name: string; browser_download_url: string } => ({
  name,
  browser_download_url: `https://github.com/r/r/releases/download/x/${name}`
})
const fullAssets = [asset('r3-cache.cjs'), asset('r3-cache.cjs.sha256'), asset('app-setup.exe')]

{
  const releases = [
    { tag_name: 'v1.0.85-preview.3', prerelease: true, assets: fullAssets },
    { tag_name: 'v1.0.84', prerelease: false, assets: fullAssets },
    { tag_name: 'v1.0.86-preview.1', prerelease: true, draft: true, assets: fullAssets },
    { tag_name: 'v1.0.85-preview.9', prerelease: true, assets: [asset('r3-cache.cjs')] }
  ]
  const preview = selectUpdate(releases, '1.0.83', 'preview')
  assert.equal(preview?.version, '1.0.85-preview.3', 'newest complete release wins')
  // preview.9 is newer but has no checksum asset — an unverifiable update
  // is not an update.
  const stable = selectUpdate(releases, '1.0.83', 'stable')
  assert.equal(stable?.version, '1.0.84', 'stable channel ignores prereleases')
  assert.equal(selectUpdate(releases, '1.0.85-preview.3', 'preview'), null, 'already current')
}

// --- download allowlist: pinned to the feed's own repo ----------------------
//
// An adversarial review found the first version of this trusted "any
// GitHub host", which is no constraint: raw.githubusercontent.com serves
// whatever anyone has ever committed. These cases are the pin.

assert.deepEqual(
  repoFromFeedUrl('https://api.github.com/repos/R3v07v3R/r3v07v3r-media-hub/releases?per_page=15'),
  {
    owner: 'R3v07v3R',
    repo: 'r3v07v3r-media-hub'
  }
)
assert.equal(
  repoFromFeedUrl('http://127.0.0.1:9000/releases'),
  null,
  'a non-GitHub feed has no pin'
)

const PINNED = { repo: { owner: 'R3v07v3R', repo: 'r3v07v3r-media-hub' } }

assert.equal(
  isAllowedAssetUrl(
    'https://github.com/R3v07v3R/r3v07v3r-media-hub/releases/download/v1.0.0/r3-cache.cjs',
    PINNED
  ),
  true,
  'this repo/s own release download is the only entry point'
)
assert.equal(
  isAllowedAssetUrl('https://raw.githubusercontent.com/attacker/x/main/evil.cjs', PINNED),
  false,
  'THE finding: arbitrary GitHub-hosted code is not an update'
)
assert.equal(
  isAllowedAssetUrl('https://github.com/attacker/x/releases/download/v1/evil.cjs', PINNED),
  false,
  'another repo/s releases are not this daemon/s updates'
)
assert.equal(
  isAllowedAssetUrl('https://github.com/attacker/x/raw/main/evil.cjs', PINNED),
  false,
  'the raw redirect trick is refused at the entry point'
)
assert.equal(isAllowedAssetUrl('https://evil.example.com/r3-cache.cjs', PINNED), false)
assert.equal(
  isAllowedAssetUrl('http://github.com/R3v07v3R/r3v07v3r-media-hub/releases/download/v1/x', PINNED),
  false,
  'plain http refused for GitHub'
)
assert.equal(
  isAllowedAssetUrl(
    'https://user:pw@github.com/R3v07v3R/r3v07v3r-media-hub/releases/download/v1/x',
    PINNED
  ),
  false,
  'embedded credentials refused'
)

// Redirect hops: GitHub's asset CDN only, and only as a continuation of a
// chain that already started at a pinned release URL.
assert.equal(isAllowedRedirectUrl('https://objects.githubusercontent.com/x', PINNED), true)
assert.equal(isAllowedRedirectUrl('https://release-assets.githubusercontent.com/y', PINNED), true)
assert.equal(isAllowedRedirectUrl('https://evil.example.com/x', PINNED), false)
assert.equal(
  isAllowedRedirectUrl('https://githubusercontent.com.evil.com/x', PINNED),
  false,
  'suffix-lookalike hosts are refused'
)

// Review finding (P1): a GitHub feed that merely differs from the default
// — one extra query parameter is enough — used to set overrideHost to
// api.github.com, and the host allowance ran BEFORE the pin. That made
// every api.github.com URL acceptable, including another repo's asset
// endpoint. The pin must be the stronger statement.
const NEAR_DEFAULT_FEED =
  'https://api.github.com/repos/R3v07v3R/r3v07v3r-media-hub/releases?per_page=30'
const PINNED_WITH_HOST = {
  repo: repoFromFeedUrl(NEAR_DEFAULT_FEED),
  overrideHost: new URL(NEAR_DEFAULT_FEED).hostname
}
assert.equal(
  isAllowedAssetUrl(
    'https://api.github.com/repos/attacker/evil/releases/assets/12345',
    PINNED_WITH_HOST
  ),
  false,
  'a repo pin beats the override host — another repo/s asset endpoint is refused'
)
assert.equal(
  isAllowedAssetUrl('https://api.github.com/anything', PINNED_WITH_HOST),
  false,
  'the override host grants nothing at all while a pin exists'
)
assert.equal(
  isAllowedAssetUrl(
    'https://github.com/R3v07v3R/r3v07v3r-media-hub/releases/download/v1/r3-cache.cjs',
    PINNED_WITH_HOST
  ),
  true,
  'the pinned repo/s own release download still works from a non-default feed'
)

// Review finding (P2): GitHub owner/repo are case-insensitive. A feed
// spelled one way and asset URLs spelled another must still match, or
// every legitimate update is rejected silently and forever.
const LOWER_PIN = { repo: { owner: 'r3v07v3r', repo: 'r3v07v3r-media-hub' } }
assert.equal(
  isAllowedAssetUrl(
    'https://github.com/R3v07v3R/r3v07v3r-media-hub/releases/download/v1.0.0/r3-cache.cjs',
    LOWER_PIN
  ),
  true,
  'a lowercase feed pin accepts GitHub/s canonical mixed-case asset URL'
)
assert.equal(
  isAllowedAssetUrl(
    'https://github.com/r3v07v3r/R3V07V3R-MEDIA-HUB/releases/download/v1/r3-cache.cjs',
    PINNED
  ),
  true,
  'casing differences either way still match'
)
assert.equal(
  isAllowedAssetUrl(
    'https://github.com/R3v07v3R/some-other-repo/releases/download/v1/r3-cache.cjs',
    LOWER_PIN
  ),
  false,
  'case-insensitivity does not loosen WHICH repo is pinned'
)

// A feed override serves its own assets — plaintext ONLY over loopback.
const OVERRIDE = { repo: null, overrideHost: '127.0.0.1' }
assert.equal(isAllowedAssetUrl('http://127.0.0.1:9000/bundle', OVERRIDE), true)
assert.equal(isAllowedAssetUrl('http://127.0.0.2:9000/bundle', OVERRIDE), false)
assert.equal(
  isAllowedAssetUrl('http://mirror.local/bundle', { repo: null, overrideHost: 'mirror.local' }),
  false,
  'a networked mirror may not drop TLS'
)
assert.equal(
  isAllowedAssetUrl('https://mirror.local/bundle', { repo: null, overrideHost: 'mirror.local' }),
  true,
  'a networked mirror over TLS is fine'
)

// --- the never-interrupt-playback gate --------------------------------------

const NOW = Date.parse('2026-08-28T03:30:00') // 03:00 local — a quiet hour
const quietHistogram = Array.from({ length: 24 }, (_, hour) => (hour >= 18 && hour <= 22 ? 50 : 0))

assert.equal(
  canRestartNow({
    activeStreams: 1,
    lastStreamAt: NOW,
    hourCounts: quietHistogram,
    stagedAt: NOW - STALE_UPDATE_MS * 2,
    now: NOW
  }),
  false,
  'an open stream blocks a restart absolutely — even a stale update'
)
assert.equal(
  canRestartNow({
    activeStreams: 0,
    lastStreamAt: NOW - IDLE_GRACE_MS / 2,
    hourCounts: quietHistogram,
    stagedAt: 0,
    now: NOW
  }),
  false,
  'the idle grace window blocks — a pause is not "done for the night"'
)
assert.equal(
  canRestartNow({
    activeStreams: 0,
    lastStreamAt: NOW - IDLE_GRACE_MS * 2,
    hourCounts: quietHistogram,
    stagedAt: NOW - 60_000,
    now: NOW
  }),
  true,
  'idle in a historically quiet hour: restart allowed'
)
{
  const eveningNow = Date.parse('2026-08-28T20:15:00') // 20:00 — the busy hour
  assert.equal(
    canRestartNow({
      activeStreams: 0,
      lastStreamAt: eveningNow - IDLE_GRACE_MS * 2,
      hourCounts: quietHistogram,
      stagedAt: eveningNow - 60_000,
      now: eveningNow
    }),
    false,
    'idle but in the household busy hour: deferred'
  )
  assert.equal(
    canRestartNow({
      activeStreams: 0,
      lastStreamAt: eveningNow - IDLE_GRACE_MS * 2,
      hourCounts: quietHistogram,
      stagedAt: eveningNow - STALE_UPDATE_MS - 1,
      now: eveningNow
    }),
    true,
    'a stale update overrides the quiet-hours preference (but never an open stream)'
  )
}
assert.equal(
  canRestartNow({
    activeStreams: 0,
    lastStreamAt: 0,
    hourCounts: Array.from({ length: 24 }, () => 0),
    stagedAt: Date.now(),
    now: Date.now()
  }),
  true,
  'no history at all: idle is enough'
)

// --- launcher state machine -------------------------------------------------

{
  // Fresh state, one staged version: it is tried first.
  const fresh = planBoot({ bad: [], good: [] }, ['1.0.90'])
  assert.equal(fresh.version, '1.0.90')
  assert.equal(fresh.state.boot?.attempts, 1)

  // Same version tripwired once: attempt 2.
  const again = planBoot({ boot: { version: '1.0.90', attempts: 1 }, bad: [], good: [] }, [
    '1.0.90'
  ])
  assert.equal(again.version, '1.0.90')
  assert.equal(again.state.boot?.attempts, 2)

  // Tripwired twice: marked bad, rolls back to builtin.
  const rolled = planBoot({ boot: { version: '1.0.90', attempts: 2 }, bad: [], good: [] }, [
    '1.0.90'
  ])
  assert.equal(rolled.version, BUILTIN_VERSION_ID, 'a twice-failed version is abandoned')
  assert.ok(rolled.state.bad.includes('1.0.90'))

  // With an older good version staged, rollback lands there, not builtin.
  const older = planBoot({ boot: { version: '1.0.90', attempts: 2 }, bad: [], good: ['1.0.89'] }, [
    '1.0.90',
    '1.0.89'
  ])
  assert.equal(older.version, '1.0.89', 'rollback prefers the newest non-bad staged version')

  // markHealthy STAMPS the tripwire rather than clearing it — clearing was
  // the critical bug: a version that came up and then crash-looped reset
  // its own attempt counter every boot and was retried forever.
  const healthy = markHealthyState(rolled.state, BUILTIN_VERSION_ID, 1_000)
  assert.equal(healthy.boot?.healthyAt, 1_000, 'healthy is stamped, not erased')
  assert.ok(healthy.good.includes(BUILTIN_VERSION_ID))

  // The builtin can never be marked bad — the floor is permanent.
  const floor = planBoot(
    { boot: { version: BUILTIN_VERSION_ID, attempts: 5 }, bad: [], good: [] },
    []
  )
  assert.equal(floor.version, BUILTIN_VERSION_ID, 'builtin is retried forever, never abandoned')

  // THE CRITICAL CASE the first design missed entirely: a version that
  // reaches healthy and then dies quickly, twice. It must be rolled back
  // exactly like one that never started.
  const T0 = 1_000_000
  let crashState = { bad: [] as string[], good: [] as string[] } as Parameters<typeof planBoot>[0]
  for (let cycle = 0; cycle < 2; cycle++) {
    const boot = planBoot(crashState, ['2.0.0'], { now: T0 + cycle * 60_000 })
    assert.equal(boot.version, '2.0.0', `cycle ${cycle}: still trying the staged version`)
    // It comes up (healthy) and then dies a minute later.
    crashState = markHealthyState(boot.state, '2.0.0', T0 + cycle * 60_000 + 1_000)
  }
  const afterTwoCrashes = planBoot(crashState, ['2.0.0'], { now: T0 + 180_000 })
  assert.equal(
    afterTwoCrashes.version,
    BUILTIN_VERSION_ID,
    'a version that keeps dying shortly after healthy IS rolled back'
  )
  assert.ok(afterTwoCrashes.state.bad.includes('2.0.0'))

  // But a version that ran healthy for a good long while and then died is
  // bad luck, not a bad build — its attempts are forgiven.
  const stable = planBoot(
    {
      boot: { version: '2.1.0', attempts: 2, healthyAt: T0 },
      bad: [],
      good: ['2.1.0']
    },
    ['2.1.0'],
    { now: T0 + 60 * 60 * 1000 }
  )
  assert.equal(stable.version, '2.1.0', 'a long-stable version is retried, not blacklisted')
  assert.equal(stable.state.bad.includes('2.1.0'), false)
  assert.equal(stable.state.boot?.attempts, 1, 'its attempt count is forgiven')

  // A freshly installed executable must not be shadowed by an older
  // staged payload left behind by earlier auto-updates.
  const newerExe = planBoot({ bad: [], good: [] }, ['1.4.0'], { builtinVersion: '1.5.0' })
  assert.equal(newerExe.version, BUILTIN_VERSION_ID, 'a newer builtin outranks older staged code')
  const olderExe = planBoot({ bad: [], good: [] }, ['1.6.0'], { builtinVersion: '1.5.0' })
  assert.equal(olderExe.version, '1.6.0', 'a newer staged version still wins over the builtin')
}

async function main(): Promise<void> {
  // --- launcher integration: boot, crash, roll back, recover ---------------
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-launcher-test-'))
  const proofPath = path.join(root, 'proof.txt')
  try {
    const stage = async (version: string, body: string): Promise<void> => {
      const file = stagedBundlePath(root, version)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, body)
    }

    // A GOOD staged payload: marks healthy, writes proof, exits.
    await stage(
      '9.0.1',
      `module.exports.run = async (api) => {
         api.markHealthy()
         require('fs').appendFileSync(${JSON.stringify(proofPath)}, 'ran:' + api.runningVersion + '\\n')
         return 'exit'
       }`
    )
    await launch({
      dataDir: root,
      launcherVersion: 'test',
      retryDelayMs: 10,
      builtinRun: async () => {
        await fsp.appendFile(proofPath, 'ran:builtin\n')
        return 'exit'
      },
      log: () => {}
    })
    assert.equal(await fsp.readFile(proofPath, 'utf8'), 'ran:9.0.1\n', 'staged version booted')
    assert.ok(readState(root).good.includes('9.0.1'), 'and was recorded good')

    // A BROKEN newer payload: throws on every boot. The launcher must
    // burn its attempts, mark it bad, and land back on 9.0.1 — all within
    // one launch() call, because boot throws are caught in-loop.
    await fsp.rm(proofPath, { force: true })
    await stage('9.0.2', `module.exports.run = async () => { throw new Error('broken update') }`)
    await launch({
      dataDir: root,
      launcherVersion: 'test',
      retryDelayMs: 10,
      builtinRun: async () => {
        await fsp.appendFile(proofPath, 'ran:builtin\n')
        return 'exit'
      },
      log: () => {}
    })
    assert.equal(
      await fsp.readFile(proofPath, 'utf8'),
      'ran:9.0.1\n',
      'the broken update was rolled back to the last good version'
    )
    assert.ok(readState(root).bad.includes('9.0.2'), 'the broken version is remembered bad')

    // And it stays bad: a fresh launch never tries it again.
    await fsp.rm(proofPath, { force: true })
    await launch({
      dataDir: root,
      launcherVersion: 'test',
      retryDelayMs: 10,
      builtinRun: async () => 'exit',
      log: () => {}
    })
    assert.equal(await fsp.readFile(proofPath, 'utf8'), 'ran:9.0.1\n', 'bad versions stay dead')

    // An unloadable file (syntax garbage) takes the same road.
    await stage('9.0.3', 'this is not javascript {{{')
    writeState(root, { bad: readState(root).bad, good: readState(root).good })
    await fsp.rm(proofPath, { force: true })
    await launch({
      dataDir: root,
      launcherVersion: 'test',
      retryDelayMs: 10,
      builtinRun: async () => 'exit',
      log: () => {}
    })
    assert.equal(await fsp.readFile(proofPath, 'utf8'), 'ran:9.0.1\n', 'garbage cannot brick it')
    assert.equal(listStagedVersions(root).includes('9.0.3'), true, 'file kept for diagnosis')

    // The supervisor-restart path: a hard crash leaves only the tripwire.
    // Simulate two dead boots of a version that LOOKS fine on disk.
    await stage('9.0.4', `module.exports.run = async (api) => { api.markHealthy(); return 'exit' }`)
    writeState(root, {
      boot: { version: '9.0.4', attempts: 2 },
      bad: readState(root).bad,
      good: readState(root).good
    })
    await fsp.rm(proofPath, { force: true })
    await launch({
      dataDir: root,
      launcherVersion: 'test',
      retryDelayMs: 10,
      builtinRun: async () => 'exit',
      log: () => {}
    })
    assert.equal(
      await fsp.readFile(proofPath, 'utf8'),
      'ran:9.0.1\n',
      'a version that kept killing the process is abandoned via the tripwire'
    )
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }

  // --- updater integration: stage-and-verify against a stub feed -----------
  const updRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'r3-updater-test-'))
  try {
    const goodBundle = `module.exports.run = async () => 'exit' // v9.9.9`
    const goodSha = crypto.createHash('sha256').update(goodBundle).digest('hex')

    let tamper = false
    const feedServer = http.createServer((req, res) => {
      const url = req.url ?? '/'
      const respond = (status: number, body: string | Buffer, type = 'application/json'): void => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }
      if (url.startsWith('/releases')) {
        const origin = `http://127.0.0.1:${(feedServer.address() as { port: number }).port}`
        respond(
          200,
          JSON.stringify([
            {
              tag_name: 'v9.9.9',
              prerelease: true,
              assets: [
                { name: 'r3-cache.cjs', browser_download_url: `${origin}/bundle` },
                { name: 'r3-cache.cjs.sha256', browser_download_url: `${origin}/sha` }
              ]
            }
          ])
        )
      } else if (url.startsWith('/bundle')) {
        respond(200, tamper ? goodBundle + '\n// tampered' : goodBundle, 'application/octet-stream')
      } else if (url.startsWith('/sha')) {
        respond(200, `${goodSha}  r3-cache.cjs\n`, 'text/plain')
      } else {
        respond(404, '{}')
      }
    })
    await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve))
    const feedPort = (feedServer.address() as { port: number }).port

    try {
      // Tampered download first: the checksum must reject it, and nothing
      // may be staged.
      tamper = true
      const noop = (): void => undefined
      const activityStub = {
        streamOpened: noop,
        streamClosed: noop,
        snapshot: () => ({ activeStreams: 0, lastStreamAt: 0, hourCounts: [] as number[] }),
        load: async () => undefined
      }
      const rejected = createUpdater({
        dataDir: updRoot,
        currentVersion: '1.0.0',
        channel: 'preview',
        enabled: true,
        activity: activityStub,
        requestRestart: () => {},
        log: () => {},
        feedUrl: `http://127.0.0.1:${feedPort}/releases`
      })
      await rejected.checkOnce()
      assert.match(rejected.status().lastError, /checksum mismatch/)
      assert.equal(listStagedVersions(updRoot).length, 0, 'a tampered bundle is never staged')

      // Honest download: staged, verified, and — with idle activity — the
      // restart request fires.
      tamper = false
      let restartRequested = false
      const updater = createUpdater({
        dataDir: updRoot,
        currentVersion: '1.0.0',
        channel: 'preview',
        enabled: true,
        activity: activityStub,
        requestRestart: () => {
          restartRequested = true
        },
        log: () => {},
        feedUrl: `http://127.0.0.1:${feedPort}/releases`,
        applyPollMs: 50
      })
      await updater.checkOnce()
      assert.equal(updater.status().staged, '9.9.9')
      assert.equal(
        await fsp.readFile(stagedBundlePath(updRoot, '9.9.9'), 'utf8'),
        goodBundle,
        'the staged bundle is byte-exact'
      )
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(restartRequested, true, 'idle daemon requests its restart')
      updater.stop()
    } finally {
      feedServer.close()
    }
  } finally {
    await fsp.rm(updRoot, { recursive: true, force: true })
  }
}

void main().then(() => {
  console.log('ok  r3-cache self-update')
})
