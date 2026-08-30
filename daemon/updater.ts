// The updater: polls the release feed, stages verified new versions, and
// asks for a restart only at a moment that interrupts nobody.
//
// Stage and apply are deliberately separate. STAGING (download + verify +
// write to versions/<v>/) happens the moment a new release is seen — it
// touches nothing running. APPLYING (restart into the staged version) is
// gated by activity.ts's canRestartNow: never while a stream is open,
// never inside the idle grace window, preferring the household's quiet
// hours, with a 24h staleness cap so updates cannot be deferred forever.
// The launcher's tripwire-and-rollback handles the remaining risk: a
// staged version that fails to boot is abandoned for the last good one.

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { ActivityTracker } from './activity'
import { canRestartNow } from './activity'
import { readState, stagedBundlePath, versionsDir } from './launcher'
import {
  isAllowedAssetUrl,
  isAllowedRedirectUrl,
  repoFromFeedUrl,
  selectUpdate,
  type FeedRelease,
  type UpdateChannel,
  type UpdateUrlPolicy
} from './updateFeed'

const DEFAULT_FEED = 'https://api.github.com/repos/R3v07v3R/r3v07v3r-media-hub/releases?per_page=15'
/** 4h base + up to 2h jitter — a household of daemons must not hit the
 *  feed on synchronized clocks. */
const CHECK_BASE_MS = 4 * 60 * 60 * 1000
const CHECK_JITTER_MS = 2 * 60 * 60 * 1000
/** Dev/simulation timing overrides. Documented nowhere user-facing on
 *  purpose: production cadence is not configuration, it is design — but a
 *  live update rehearsal cannot wait five minutes per step. */
const FIRST_CHECK_DELAY_MS = Number(process.env.R3_CACHE_UPDATE_FIRST_MS) || 5 * 60 * 1000
/** How often a staged update re-asks "is now a quiet moment?". */
const APPLY_POLL_MS = Number(process.env.R3_CACHE_UPDATE_APPLY_MS) || 5 * 60 * 1000
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
const MAX_FEED_BYTES = 4 * 1024 * 1024
const MAX_REDIRECTS = 5

/** Long enough for the JSON reply to leave the socket before the process
 *  goes down. The alternative is the caller seeing a dropped connection
 *  and having to guess whether the update started. */
const RESTART_REPLY_GRACE_MS = 300

export interface UpdaterStatus {
  channel: UpdateChannel
  enabled: boolean
  checkedAt: number
  latestSeen: string
  staged: string
  stagedAt: number
  lastError: string
}

export interface UpdaterDeps {
  dataDir: string
  currentVersion: string
  channel: UpdateChannel
  enabled: boolean
  activity: ActivityTracker
  /** Resolves the payload's run() with 'restart' — the launcher loop then
   *  boots the newest staged version. */
  requestRestart: () => void
  log: (message: string) => void
  /** Test seams. */
  feedUrl?: string
  fetchImpl?: typeof fetch
  applyPollMs?: number
}

/** What an administrator's "update now" actually did. */
export interface ApplyNowResult {
  /** 'restarting' — the daemon is going down and coming back on the new
   *  build. 'waiting' — staged and armed, but somebody is watching, so it
   *  goes in as soon as they stop. 'current' — nothing newer to install.
   *  'disabled' — updates are switched off on this server. */
  outcome: 'restarting' | 'waiting' | 'current' | 'disabled'
  message: string
  status: UpdaterStatus
}

export interface Updater {
  start(): void
  stop(): void
  status(): UpdaterStatus
  /** One immediate check — also the test entrypoint. */
  checkOnce(): Promise<void>
  /**
   * The administrator asking for it NOW.
   *
   * Checks the feed straight away rather than waiting out the poll, then
   * applies as soon as it can. "As soon as it can" still means not while
   * somebody is watching: never interrupting playback is the rule the
   * whole updater is built around, and a button on a page is not a reason
   * to take a film away from somebody in another room. What the request
   * DOES override is the politeness — the half-hour idle grace and the
   * quiet-hours preference — because those exist to pick a good moment on
   * nobody's behalf, and here somebody has picked one.
   */
  applyNow(): Promise<ApplyNowResult>
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const feedUrl = deps.feedUrl ?? process.env.R3_CACHE_UPDATE_FEED ?? DEFAULT_FEED
  // The download pin is derived from the feed, so "which repo do we
  // trust" is stated once and cannot drift from "which repo do we poll".
  const policy: UpdateUrlPolicy = {
    repo: repoFromFeedUrl(feedUrl),
    overrideHost: feedUrl === DEFAULT_FEED ? undefined : new URL(feedUrl).hostname
  }

  let checkTimer: NodeJS.Timeout | null = null
  let applyTimer: NodeJS.Timeout | null = null
  let stopped = false
  /** Set once an administrator has asked for the update by hand. It is not
   *  cleared: having asked once, they should not have to ask again because
   *  somebody started a film in the meantime. */
  let requested = false
  const status: UpdaterStatus = {
    channel: deps.channel,
    enabled: deps.enabled,
    checkedAt: 0,
    latestSeen: '',
    staged: '',
    stagedAt: 0,
    lastError: ''
  }

  /**
   * Reads a response body with the cap enforced WHILE STREAMING.
   *
   * The first version buffered the whole body and checked its length
   * afterwards, which is not a cap at all — a hostile host could stream
   * gigabytes and exhaust memory before the check ran. Content-Length is
   * honoured up front when offered, and the running total aborts the read
   * the moment it exceeds the limit either way.
   */
  async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('download larger than expected')
    }
    if (!response.body) throw new Error('download had no body')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('download larger than expected')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }

  /**
   * Fetches an update asset, re-validating EVERY redirect hop.
   *
   * redirect:'follow' checked only the first URL, which made the pin
   * bypassable by any redirect an allowed host could be induced to issue.
   * Manual redirects mean the chain must start at a repo-pinned release
   * download and may only continue onto GitHub's asset CDN.
   */
  async function download(url: string, maxBytes: number): Promise<Buffer> {
    if (!isAllowedAssetUrl(url, policy)) {
      throw new Error(`update asset URL not allowed: ${new URL(url).hostname}`)
    }
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetchImpl(current, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'r3-cache' },
        redirect: 'manual'
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('update redirect had no destination')
        current = new URL(location, current).toString()
        if (!isAllowedRedirectUrl(current, policy)) {
          throw new Error(`update redirected off-allowlist: ${new URL(current).hostname}`)
        }
        continue
      }
      if (!response.ok) throw new Error(`download failed (${response.status})`)
      return readCapped(response, maxBytes)
    }
    throw new Error('update redirected too many times')
  }

  async function checkOnce(): Promise<void> {
    try {
      const response = await fetchImpl(feedUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'r3-cache' }
      })
      if (!response.ok) throw new Error(`feed answered ${response.status}`)
      // Capped like any other download — a feed is an untrusted body too.
      const releases = JSON.parse(
        (await readCapped(response, MAX_FEED_BYTES)).toString('utf8')
      ) as FeedRelease[]
      status.checkedAt = Date.now()

      const candidate = selectUpdate(releases, deps.currentVersion, deps.channel)
      if (!candidate) {
        status.lastError = ''
        return
      }
      status.latestSeen = candidate.version
      // A version the launcher has already blacklisted must never be
      // staged or applied again. Without this the two halves disagreed
      // forever: the launcher rolled a version back, the updater saw it
      // was still the newest release and still on disk, and requested a
      // restart into it at every idle moment — a daemon that restarted
      // itself indefinitely and never converged.
      if (readState(deps.dataDir).bad.includes(candidate.version)) {
        status.lastError = `${candidate.version} was rolled back here; waiting for a newer release`
        return
      }
      if (status.staged === candidate.version) return
      const alreadyStaged = await fsp
        .stat(stagedBundlePath(deps.dataDir, candidate.version))
        .then(() => true)
        .catch(() => false)
      if (alreadyStaged) {
        noteStaged(candidate.version)
        return
      }

      deps.log(`update ${candidate.version} found (running ${deps.currentVersion}) — staging`)
      const [bundle, checksumFile] = await Promise.all([
        download(candidate.bundleUrl, MAX_BUNDLE_BYTES),
        download(candidate.checksumUrl, 4096)
      ])

      // The checksum file is "<hex>  <filename>" (shasum convention); only
      // the hex matters. A mismatch is a hard stop — an update that fails
      // verification is not retried with less rigour, it is not an update.
      const expected = /^[a-f0-9]{64}/i.exec(checksumFile.toString('utf8').trim())?.[0]
      const actual = crypto.createHash('sha256').update(bundle).digest('hex')
      if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
        throw new Error(`checksum mismatch for ${candidate.version}`)
      }

      const dir = path.join(versionsDir(deps.dataDir), candidate.version)
      await fsp.mkdir(dir, { recursive: true })
      const finalPath = stagedBundlePath(deps.dataDir, candidate.version)
      const tmp = `${finalPath}.${process.pid}.tmp`
      await fsp.writeFile(tmp, bundle)
      await fsp.rename(tmp, finalPath)
      deps.log(`staged   ${candidate.version} (${bundle.length} bytes, checksum verified)`)
      noteStaged(candidate.version)
      status.lastError = ''
    } catch (error) {
      status.lastError = (error as Error).message
      deps.log(`update check failed: ${status.lastError}`)
    }
  }

  function noteStaged(version: string): void {
    status.staged = version
    if (!status.stagedAt) {
      // Dated from the bundle on disk, not from this process. Reading the
      // clock here restarted the 24h staleness cap on every restart, so a
      // daemon that restarts often could defer an update forever.
      try {
        status.stagedAt = fs.statSync(stagedBundlePath(deps.dataDir, version)).mtimeMs
      } catch {
        status.stagedAt = Date.now()
      }
    }
    armApplyPoll()
  }

  function armApplyPoll(): void {
    if (applyTimer || stopped || !status.staged) return
    applyTimer = setInterval(() => {
      const snapshot = deps.activity.snapshot()
      // Asked for explicitly, the only remaining bar is an open stream.
      // The idle grace and the quiet hour are there to choose a moment
      // when nobody has chosen one; somebody has.
      const ok = requested
        ? snapshot.activeStreams === 0
        : canRestartNow({
            activeStreams: snapshot.activeStreams,
            lastStreamAt: snapshot.lastStreamAt,
            hourCounts: snapshot.hourCounts,
            stagedAt: status.stagedAt,
            now: Date.now()
          })
      if (!ok) return
      deps.log(`applying ${status.staged} — nobody is watching`)
      stop()
      deps.requestRestart()
    }, deps.applyPollMs ?? APPLY_POLL_MS)
    applyTimer.unref?.()
  }

  function scheduleNextCheck(): void {
    if (stopped) return
    const delay = CHECK_BASE_MS + Math.floor(Math.random() * CHECK_JITTER_MS)
    checkTimer = setTimeout(() => {
      void checkOnce().finally(scheduleNextCheck)
    }, delay)
    checkTimer.unref?.()
  }

  function stop(): void {
    stopped = true
    if (checkTimer) clearTimeout(checkTimer)
    if (applyTimer) clearInterval(applyTimer)
    checkTimer = null
    applyTimer = null
  }

  return {
    start() {
      if (!deps.enabled) return
      checkTimer = setTimeout(() => {
        void checkOnce().finally(scheduleNextCheck)
      }, FIRST_CHECK_DELAY_MS)
      checkTimer.unref?.()
    },
    stop,
    status: () => ({ ...status }),
    checkOnce,
    async applyNow() {
      if (!deps.enabled) {
        return {
          outcome: 'disabled' as const,
          message: 'Updates are switched off on this server.',
          status: { ...status }
        }
      }
      requested = true
      // Straight to the feed. Without this the button would only be able
      // to install what an earlier poll happened to have found, which for
      // a release cut minutes ago is nothing at all — and "update now"
      // answering "already current" about a version published this
      // afternoon is the kind of wrong that erodes trust in the button.
      await checkOnce()
      if (!status.staged) {
        return {
          outcome: 'current' as const,
          message: status.lastError
            ? `Could not check for updates: ${status.lastError}`
            : 'Already running the newest build.',
          status: { ...status }
        }
      }
      armApplyPoll()
      if (deps.activity.snapshot().activeStreams > 0) {
        return {
          outcome: 'waiting' as const,
          message: `${status.staged} is ready and will install as soon as nobody is watching.`,
          status: { ...status }
        }
      }
      deps.log(`applying ${status.staged} — asked for by the administrator`)
      // The reply goes out BEFORE the restart is requested, or the caller
      // is left holding a socket that dies mid-response and cannot tell a
      // successful update from a crash.
      const result = {
        outcome: 'restarting' as const,
        message: `Installing ${status.staged}. The server will be back in a moment.`,
        status: { ...status }
      }
      setTimeout(() => {
        stop()
        deps.requestRestart()
      }, RESTART_REPLY_GRACE_MS).unref?.()
      return result
    }
  }
}
