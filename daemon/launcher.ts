// The launcher: the small, stable half of self-updating.
//
// The daemon is two layers in one file. The PAYLOAD (main.ts's run()) is
// everything the daemon does, and updates freely. The LAUNCHER is this
// module: it decides WHICH version of the payload runs, watches whether
// that version actually came up, and rolls back to the last known-good
// one when it didn't. It ships embedded in the executable people install
// and must change as rarely as possible — every line here runs BEFORE the
// self-healing exists.
//
// Health protocol, the whole of it:
//  1. Before requiring a payload, record {version, attempts} in
//     versions/state.json. This is the tripwire.
//  2. The payload calls api.markHealthy() once it is genuinely up
//     (listening, first eviction pass done). That clears the tripwire and
//     remembers the version as good.
//  3. A payload that throws during boot — or that dies so hard the whole
//     process goes down and the service manager restarts us — leaves the
//     tripwire set. Seeing attempts >= MAX_BOOT_ATTEMPTS on the way up,
//     the launcher marks that version bad and falls back to the next
//     candidate: an older staged version, or the payload built into this
//     executable, which can never be deleted. "It always comes back
//     online" rests on that floor.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { parseVersion, compareVersions } from './updateFeed'

export const BUILTIN_VERSION_ID = 'builtin'
const MAX_BOOT_ATTEMPTS = 2
/**
 * How long a version must stay healthy before a later crash counts as bad
 * luck rather than a bad build.
 *
 * Without this the rollback machine only ever caught updates that failed
 * to START. An update that came up, reported healthy, and then died
 * reliably — a fetcher that throws on one malformed job, an OOM under the
 * unit's MemoryMax — reset its own attempt counter on every boot and was
 * retried forever, which is the commoner shape of a bad release and the
 * one that leaves a daemon effectively offline.
 */
const MIN_STABLE_MS = 10 * 60 * 1000
/** Backoff between in-loop boot attempts. A bare retry made every failure
 *  a hot loop that re-ran a full eviction pass thousands of times. */
const BOOT_RETRY_DELAY_MS = 5_000

export interface LauncherState {
  /** Tripwire: set immediately before booting a version. `healthyAt` is
   *  stamped when the payload reports healthy — the record is NOT cleared,
   *  because "it started" and "it kept running" are different claims and
   *  only the second one earns forgiveness (see MIN_STABLE_MS). */
  boot?: { version: string; attempts: number; healthyAt?: number }
  /** Versions that exhausted their boot attempts. Never booted again. */
  bad: string[]
  /** Versions that reached healthy at least once, newest last. */
  good: string[]
}

export interface PayloadApi {
  /** Bumps the protocol only when the launcher/payload contract changes
   *  incompatibly — an old launcher runs new payloads for years. */
  protocol: 1
  launcherVersion: string
  /** The version id this payload was selected as. */
  runningVersion: string
  /** Clears the boot tripwire — call once genuinely up. */
  markHealthy: () => void
}

/** What a payload module must export to be runnable. */
export interface PayloadModule {
  run: (api: PayloadApi) => Promise<'restart' | 'exit'>
}

export function versionsDir(dataDir: string): string {
  return path.join(dataDir, 'versions')
}

export function stagedBundlePath(dataDir: string, version: string): string {
  return path.join(versionsDir(dataDir), version, 'r3-cache.cjs')
}

function statePath(dataDir: string): string {
  return path.join(versionsDir(dataDir), 'state.json')
}

export function readState(dataDir: string): LauncherState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8')) as LauncherState
    return {
      boot: parsed.boot,
      bad: Array.isArray(parsed.bad) ? parsed.bad : [],
      good: Array.isArray(parsed.good) ? parsed.good : []
    }
  } catch {
    return { bad: [], good: [] }
  }
}

export function writeState(dataDir: string, state: LauncherState): void {
  // Deliberately synchronous and simple: this file is tiny, written a
  // handful of times per process lifetime, and correctness of the
  // tripwire ordering (persisted BEFORE the risky require) matters more
  // than write latency.
  fs.mkdirSync(versionsDir(dataDir), { recursive: true })
  const tmp = `${statePath(dataDir)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, statePath(dataDir))
}

/** Staged versions present on disk, newest first. Pure given its input. */
export function orderStagedVersions(versionIds: readonly string[]): string[] {
  return versionIds
    .map((id) => ({ id, parsed: parseVersion(id) }))
    .filter(
      (entry): entry is { id: string; parsed: NonNullable<ReturnType<typeof parseVersion>> } =>
        Boolean(entry.parsed)
    )
    .sort((a, b) => compareVersions(b.parsed, a.parsed))
    .map((entry) => entry.id)
}

export function listStagedVersions(dataDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(versionsDir(dataDir), { withFileTypes: true })
  } catch {
    return []
  }
  const present = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(stagedBundlePath(dataDir, name)))
  return orderStagedVersions(present)
}

/**
 * The boot decision, pure so it is testable: which version to try, given
 * what is staged, what has failed, and what the tripwire says about the
 * previous boot.
 *
 * Also returns the updated state to persist BEFORE booting. A version
 * whose tripwire shows attempts >= MAX_BOOT_ATTEMPTS is moved to `bad`
 * here — this is the rollback.
 */
export interface PlanBootOptions {
  now?: number
  /** The version compiled into the running executable, so a freshly
   *  installed newer build is not shadowed by an older staged one. */
  builtinVersion?: string
}

export function planBoot(
  state: LauncherState,
  staged: readonly string[],
  options: PlanBootOptions = {}
): { version: string; state: LauncherState } {
  const now = options.now ?? Date.now()
  const bad = new Set(state.bad)

  let boot = state.boot
  if (boot) {
    if (boot.healthyAt !== undefined && now - boot.healthyAt >= MIN_STABLE_MS) {
      // It ran healthy for long enough to have proved itself; whatever
      // killed it is not "this build cannot run". Forgive the attempts.
      boot = undefined
    } else if (boot.attempts >= MAX_BOOT_ATTEMPTS) {
      // Never started, or started and died again almost immediately.
      bad.add(boot.version)
      boot = undefined
    }
  }

  const usable = staged.filter((version) => !bad.has(version))
  // The builtin is a peer, not only a floor: an executable the person just
  // installed must not be shadowed by an older payload left in versions/.
  const newest = usable[0]
  const builtinWins =
    !newest ||
    (options.builtinVersion !== undefined &&
      (() => {
        const a = parseVersion(options.builtinVersion)
        const b = parseVersion(newest)
        return a !== null && b !== null && compareVersions(a, b) > 0
      })())
  const version = builtinWins ? BUILTIN_VERSION_ID : newest

  const attempts = boot?.version === version ? boot.attempts + 1 : 1

  return {
    version,
    state: {
      boot: { version, attempts },
      bad: [...bad].filter((entry) => entry !== BUILTIN_VERSION_ID),
      good: state.good
    }
  }
}

export function markHealthyState(
  state: LauncherState,
  version: string,
  now = Date.now()
): LauncherState {
  // Deliberately keeps the boot record. Clearing it here was the bug that
  // made post-healthy crash loops invisible: the attempt counter reset on
  // every boot, so `attempts >= MAX_BOOT_ATTEMPTS` was unreachable for any
  // version that managed to start at all.
  return {
    boot: {
      version,
      attempts: state.boot?.version === version ? state.boot.attempts : 1,
      healthyAt: now
    },
    bad: state.bad,
    good: [...state.good.filter((entry) => entry !== version), version].slice(-5)
  }
}

/** Staged versions older than the last few known-good are disk noise;
 *  called by the payload's updater after a successful boot. Never removes
 *  the running version or anything not strictly older than it. */
export function pruneKeepList(staged: readonly string[], runningVersion: string): string[] {
  const keep = new Set(staged.slice(0, 3))
  keep.add(runningVersion)
  return staged.filter((version) => !keep.has(version))
}

export interface LauncherOptions {
  dataDir: string
  launcherVersion: string
  /** Test seam only — production always uses BOOT_RETRY_DELAY_MS. */
  retryDelayMs?: number
  /** The payload compiled into this very bundle — the floor that can
   *  never be deleted out from under us. */
  builtinRun: PayloadModule['run']
  log: (message: string) => void
}

/**
 * The forever-loop. Each iteration boots one version and waits for it to
 * finish; 'restart' loops (picking up anything newly staged), 'exit'
 * returns. A synchronous boot failure is caught HERE and retried against
 * the next candidate immediately; a hard crash is the service manager's
 * restart plus the tripwire.
 */
export async function launch(options: LauncherOptions): Promise<void> {
  const { dataDir, log } = options
  // Seeded from what is ALREADY on disk so a rollback that happened months
  // ago is not re-announced as news on every boot — the journal is the only
  // signal an operator has for "did an update just fail".
  const announced = new Set(readState(dataDir).bad)

  for (;;) {
    const staged = listStagedVersions(dataDir)
    const planned = planBoot(readState(dataDir), staged, {
      builtinVersion: options.launcherVersion
    })
    writeState(dataDir, planned.state)

    for (const entry of planned.state.bad) {
      if (announced.has(entry)) continue
      announced.add(entry)
      log(`rolled back: ${entry} failed to boot, marked bad`)
    }

    let payload: PayloadModule['run']
    if (planned.version === BUILTIN_VERSION_ID) {
      payload = options.builtinRun
    } else {
      try {
        const require = createRequire(path.join(versionsDir(dataDir), 'noop.js'))
        const loaded = require(stagedBundlePath(dataDir, planned.version)) as Partial<PayloadModule>
        if (typeof loaded.run !== 'function') {
          throw new Error('staged bundle exports no run()')
        }
        payload = loaded.run
      } catch (error) {
        log(`staged ${planned.version} unloadable (${(error as Error).message})`)
        await delay(options.retryDelayMs ?? BOOT_RETRY_DELAY_MS)
        continue
      }
    }

    log(`booting ${planned.version} (attempt ${planned.state.boot?.attempts ?? 1})`)
    const api: PayloadApi = {
      protocol: 1,
      launcherVersion: options.launcherVersion,
      runningVersion: planned.version,
      markHealthy: () => {
        writeState(dataDir, markHealthyState(readState(dataDir), planned.version))
        log(`healthy  ${planned.version}`)
      }
    }

    let outcome: 'restart' | 'exit'
    try {
      outcome = await payload(api)
    } catch (error) {
      // Another instance already owns the port. That is not this version
      // failing — counting it would let a second process (which install.ts
      // itself tells people to start) blacklist
      // every staged version in the RUNNING daemon's shared state file.
      // Stand down instead, leaving the tripwire as it was found.
      if ((error as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
        log('another r3-cache is already running on this port — exiting')
        writeState(dataDir, readState(dataDir))
        return
      }
      log(`payload ${planned.version} crashed: ${(error as Error).message}`)
      await delay(options.retryDelayMs ?? BOOT_RETRY_DELAY_MS)
      continue
    }
    if (outcome === 'exit') return

    // A successful run is the moment to tidy: bundles older than the few
    // most recent are disk noise in a directory whose whole point is to be
    // budget-managed.
    for (const stale of pruneKeepList(listStagedVersions(dataDir), planned.version)) {
      try {
        fs.rmSync(path.join(versionsDir(dataDir), stale), { recursive: true, force: true })
        log(`pruned   ${stale}`)
      } catch {
        // Disk hygiene is best-effort; never worth failing a restart over.
      }
    }
    log('restarting for update')
  }
}

/** Deliberately NOT unref'd. During a boot retry there is no server
 *  holding the event loop open, so an unref'd timer let the process exit
 *  silently mid-backoff — the daemon giving up instead of rolling back,
 *  which is the one outcome this whole design exists to prevent. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
