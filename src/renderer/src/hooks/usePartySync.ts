// Watch-party playback sync for the player-overlay window.
//
// Ported from PlaybackOverlay's party effects. The protocol, the quorum rules
// and partySync.ts's control law are unchanged — what changed is the actuators
// and, in one place, a threshold:
//
//   video.currentTime + streamStartOffsetRef  ->  mpv's time-pos, already absolute
//   video.playbackRate                        ->  mpv's speed
//   video.pause()/play()                      ->  the pause property
//   video.buffered                            ->  demuxer-cache-duration
//
// The offset arithmetic is gone entirely. Every position the old code handled
// was relative to the current transcode segment, so each call site had to add
// `streamStartOffsetRef.current` back on — and a party position is exactly the
// kind of number that is silently wrong if one site forgets.
//
// HARD_SEEK_SECONDS collapses to a single threshold. Its `compatibility: 6`
// variant existed because a seek used to restart ffmpeg, so it had to be
// reserved for genuine desync rather than spent on the keyframe-snap difference
// between members streaming their own independently-resolved files. Seeks are
// in-place now, and `-noaccurate_seek` is gone with the transcode, so neither
// reason survives.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { PartyStatusResult } from '@shared/media-hub/types'
import type { PlayerCommand } from '@shared/media-hub/player'
import {
  expectedHostPosition,
  isSampleUsable,
  syncCorrection,
  type HostPositionSample
} from '@shared/media-hub/partySync'

/** How long the host waits for everyone before releasing a synced seek anyway —
 *  one stuck peer must not hold the party hostage. */
const SYNC_TIMEOUT_MS = 20_000
/** Applied identically on every peer including the host, so this message itself
 *  has time to cross the network before anyone starts playing. Without it the
 *  host (zero network hop to itself) visibly starts first. */
const SYNC_PLAY_DELAY_MS = 1500
const HOST_HEARTBEAT_MS = 5000

export type PartySyncNotice = 'synced' | 'correcting' | 'delayed' | null

interface Options {
  timePos: number
  duration: number
  paused: boolean
  cacheAheadSeconds: number
  bufferSeconds: number
  // Return value ignored here — see PlayerWindowContext's `command` for what it resolves to.
  command: (command: PlayerCommand) => Promise<unknown>
}

export interface PartySync {
  status: PartyStatusResult | null
  isHost: boolean
  /** In a party and NOT allowed to drive playback — the UI locks its controls. */
  following: boolean
  canControl: boolean
  notice: PartySyncNotice
  /** Names the host is still waiting on for the in-flight synced seek. */
  waitingNames: string[] | null
  syncing: boolean
  /** Party-aware seek: a host-coordinated handshake when hosting, a plain
   *  broadcast otherwise. Every seek in the player goes through this. */
  seekTo: (seconds: number) => void
  /** Party-aware play/pause. */
  togglePlay: () => void
  /** Party-aware play/pause for a caller that already knows the state it wants.
   *  Unlike togglePlay it never consults the last observed `paused`, so it
   *  cannot broadcast an action derived from a reading that has not caught up
   *  yet — see the note on togglePlay. */
  setPaused: (paused: boolean) => void
}

export function usePartySync({
  timePos,
  duration,
  paused,
  cacheAheadSeconds,
  bufferSeconds,
  command
}: Options): PartySync {
  const [status, setStatus] = useState<PartyStatusResult | null>(null)
  const [notice, setNotice] = useState<PartySyncNotice>(null)
  const [waitingNames, setWaitingNames] = useState<string[] | null>(null)
  const [activeSyncRequestId, setActiveSyncRequestId] = useState<string | null>(null)

  const isHost = status?.inParty === true && status.role === 'host'
  const canControl = isHost || status?.allowMemberControl === true
  const following = status?.inParty === true && !isHost

  // Live values for the 1Hz steering loop and the heartbeat, which must read
  // the latest without being re-armed on every frame of playback.
  const live = useRef({ timePos, duration, paused, cacheAheadSeconds, bufferSeconds })
  const activeSyncRef = useRef<string | null>(activeSyncRequestId)
  const readyIdsRef = useRef<Set<string>>(new Set())
  const hostFixRef = useRef<HostPositionSample | null>(null)
  const statusRef = useRef(status)
  const commandRef = useRef(command)
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    live.current = { timePos, duration, paused, cacheAheadSeconds, bufferSeconds }
    activeSyncRef.current = activeSyncRequestId
    statusRef.current = status
    commandRef.current = command
  }, [
    timePos,
    duration,
    paused,
    cacheAheadSeconds,
    bufferSeconds,
    activeSyncRequestId,
    status,
    command
  ])

  const send = useCallback(
    (
      action: Parameters<NonNullable<typeof window.api>['mediaHub']['party']['playbackAction']>[0]
    ) => {
      window.api?.mediaHub?.party.playbackAction(action).catch(() => {})
    },
    []
  )

  const run = useCallback((playerCommand: PlayerCommand) => {
    void commandRef.current(playerCommand)
  }, [])

  const clearSyncSeek = useCallback(() => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current)
      syncTimeoutRef.current = null
    }
    setActiveSyncRequestId(null)
    activeSyncRef.current = null
    setWaitingNames(null)
    readyIdsRef.current = new Set()
  }, [])

  // The overlay is its own renderer process, so it subscribes to party status
  // itself rather than receiving it from the main window's context.
  useEffect(() => {
    const api = window.api?.mediaHub?.party
    if (!api) return
    api
      .status()
      .then(setStatus)
      .catch(() => {})
    return api.onEvent(() => {
      api
        .status()
        .then(setStatus)
        .catch(() => {})
    })
  }, [])

  // Host only: re-evaluates the ready-set and, once everyone is accounted for
  // (or `force`, from the safety timeout), releases the party together.
  const checkSeekReady = useCallback(
    (requestId: string, force = false) => {
      // A stale invocation for an already-superseded request must not
      // re-broadcast 'seek-waiting' after 'seek-go' already released everyone.
      if (activeSyncRef.current !== requestId) return
      const members = statusRef.current?.members ?? []
      // `watching !== false` rather than `=== true`: undefined means a member
      // has not reported yet, and excluding them could release a seek before
      // someone who IS watching has buffered.
      const waiting = members.filter((m) => m.watching !== false && !readyIdsRef.current.has(m.id))
      if (waiting.length > 0 && !force) {
        setWaitingNames(waiting.map((m) => m.name))
        send({ type: 'seek-waiting', requestId, waitingIds: waiting.map((m) => m.id) })
        return
      }
      send({ type: 'seek-go', requestId })
      clearSyncSeek()
      setTimeout(() => run({ type: 'play' }), SYNC_PLAY_DELAY_MS)
    },
    [send, clearSyncSeek, run]
  )

  // The host tracks its own readiness locally with no network round trip; a
  // follower has to tell the host, since only the host aggregates the set.
  const reportReady = useCallback(
    (requestId: string) => {
      if (isHost) {
        readyIdsRef.current.add(statusRef.current?.selfId || '')
        checkSeekReady(requestId)
      } else {
        send({ type: 'ready', requestId })
      }
    },
    [isHost, checkSeekReady, send]
  )

  // Waits for THIS device's own buffer to reach the configured target after a
  // synced seek, then reports ready. Deliberately separate from any auto-play:
  // during a sync wait nobody resumes until 'seek-go' says so.
  //
  // The old version needed a special case here — in compatibility mode
  // `video.buffered` still described the PREVIOUS segment for a moment after a
  // seek, so an immediate check reported ready against stale data and the
  // device then had nothing to play. demuxer-cache-duration is always about the
  // stream actually loaded, so the special case is gone.
  useEffect(() => {
    if (!activeSyncRequestId) return
    let settled = false
    const tryReport = (force = false): void => {
      if (settled) return
      const {
        cacheAheadSeconds: ahead,
        bufferSeconds: target,
        timePos: pos,
        duration: total
      } = live.current
      const fullyBuffered = total > 0 && pos + ahead >= total - 0.25
      if (!force && !fullyBuffered && ahead < target) return
      settled = true
      reportReady(activeSyncRequestId)
    }
    const poll = setInterval(() => tryReport(), 250)
    const maxWait = setTimeout(() => tryReport(true), SYNC_TIMEOUT_MS)
    tryReport()
    return () => {
      settled = true
      clearInterval(poll)
      clearTimeout(maxWait)
    }
  }, [activeSyncRequestId, reportReady])

  const seekTo = useCallback(
    (target: number) => {
      const current = statusRef.current
      if (isHost && current?.inParty) {
        const requestId = crypto.randomUUID()
        run({ type: 'pause' })
        clearSyncSeek()
        run({ type: 'seek', seconds: target })
        setActiveSyncRequestId(requestId)
        activeSyncRef.current = requestId
        setWaitingNames(
          (current.members ?? [])
            .filter((m) => m.id !== current.selfId && m.watching !== false)
            .map((m) => m.name)
        )
        send({ type: 'seek-sync', position: target, requestId })
        syncTimeoutRef.current = setTimeout(() => checkSeekReady(requestId, true), SYNC_TIMEOUT_MS)
      } else {
        run({ type: 'seek', seconds: target })
        if (isHost || canControl) send({ type: 'seek', position: target })
      }
    },
    [isHost, canControl, run, send, clearSyncSeek, checkSeekReady]
  )

  // Note what this has to do that a solo player would not: mpv is told to
  // *toggle*, but peers must be told the resulting state, and that is derived
  // from the last observed `paused`. The two can disagree if the observed value
  // has not caught up — after a first toggle whose state push is still in
  // flight, `next` is computed from the pre-toggle reading and peers are sent
  // the action that has already happened. setPaused below exists for callers
  // that can say what they want instead of asking for the opposite of a
  // reading.
  const togglePlay = useCallback(() => {
    if (following && !canControl) return
    const next = live.current.paused ? 'play' : 'pause'
    run({ type: 'toggle-pause' })
    if (statusRef.current?.inParty && (isHost || canControl)) send({ type: next })
  }, [following, canControl, isHost, run, send])

  const setPaused = useCallback(
    (nextPaused: boolean) => {
      if (following && !canControl) return
      const next = nextPaused ? 'pause' : 'play'
      // An explicit play/pause rather than a toggle, so this cannot race mpv's
      // own read-modify-write either: two of these in flight land on the same
      // state, where two toggles would cancel out.
      run({ type: next })
      if (statusRef.current?.inParty && (isHost || canControl)) send({ type: next })
    },
    [following, canControl, isHost, run, send]
  )

  // Applying incoming actions. Normally only a follower receives these, but with
  // "anyone can control playback" on, any member's action reaches everyone —
  // so this runs for the host too in that case. The wire protocol never echoes
  // a sender its own broadcast.
  useEffect(() => {
    if (!status?.inParty) return
    if (status.role === 'host' && !status.allowMemberControl) return
    const api = window.api?.mediaHub?.party
    if (!api) return
    return api.onEvent((event) => {
      if (event.type !== 'message') return
      const msg = event.message as {
        type?: string
        position?: number
        paused?: boolean
        requestId?: string
        waitingIds?: string[]
      }
      if (msg.type === 'play') run({ type: 'play' })
      else if (msg.type === 'pause') run({ type: 'pause' })
      else if (msg.type === 'seek') run({ type: 'seek', seconds: Number(msg.position) || 0 })
      else if (msg.type === 'position') {
        // Recorded, not applied. Acting only on arrival leaves a follower
        // uncorrected between heartbeats and compares a value that is already
        // one network hop stale — a systematic backward pull. The steering loop
        // extrapolates from this instead (see partySync.ts).
        hostFixRef.current = {
          mediaTime: Number(msg.position) || 0,
          arrivedAt: performance.now(),
          paused: msg.paused === true
        }
      } else if (msg.type === 'seek-sync' && msg.requestId) {
        run({ type: 'pause' })
        clearSyncSeek()
        run({ type: 'seek', seconds: Number(msg.position) || 0 })
        setActiveSyncRequestId(msg.requestId)
        activeSyncRef.current = msg.requestId
      } else if (msg.type === 'seek-waiting' && msg.requestId === activeSyncRef.current) {
        setWaitingNames(
          (msg.waitingIds || [])
            .map((id) => status.members?.find((m) => m.id === id)?.name)
            .filter((name): name is string => Boolean(name))
        )
      } else if (msg.type === 'seek-go' && msg.requestId === activeSyncRef.current) {
        clearSyncSeek()
        setTimeout(() => run({ type: 'play' }), SYNC_PLAY_DELAY_MS)
      }
    })
  }, [status, run, clearSyncSeek])

  // Host heartbeat. Sent even while paused, so followers can tell "the host is
  // paused" from "the host went away".
  useEffect(() => {
    if (!isHost || !status?.inParty) return
    const timer = setInterval(() => {
      send({ type: 'position', position: live.current.timePos, paused: live.current.paused })
    }, HOST_HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, [isHost, status?.inParty, send])

  // Follower steering: converges on where the host is RIGHT NOW, extrapolated
  // from its last fix. On its own timer rather than only when a heartbeat lands
  // — that is the whole point of extrapolating.
  useEffect(() => {
    if (!following) return
    const tick = setInterval(() => {
      if (live.current.paused) return
      // A synced seek owns positioning while it is in flight.
      if (activeSyncRef.current) return
      const now = performance.now()
      const fix = hostFixRef.current
      if (!isSampleUsable(fix, now)) {
        // No trustworthy fix — coast rather than steer toward a stale one.
        run({ type: 'set-speed', speed: 1 })
        setNotice('delayed')
        return
      }
      if (fix!.paused) {
        run({ type: 'set-speed', speed: 1 })
        setNotice('synced')
        return
      }
      const expected = expectedHostPosition(fix!, now)
      const correction = syncCorrection(live.current.timePos, expected)
      if (correction.action === 'seek') {
        setNotice('correcting')
        run({ type: 'set-speed', speed: 1 })
        // The fix keeps advancing while the seek lands, so aim at where the
        // host will be, not where it was when we decided to move.
        run({ type: 'seek', seconds: expectedHostPosition(fix!, performance.now()) })
      } else if (correction.action === 'rate') {
        setNotice('correcting')
        run({ type: 'set-speed', speed: correction.rate })
      } else {
        run({ type: 'set-speed', speed: 1 })
        setNotice('synced')
      }
    }, 1000)
    return () => {
      clearInterval(tick)
      // Never leave the player off-speed after the party ends.
      void commandRef.current({ type: 'set-speed', speed: 1 })
    }
  }, [following, run])

  // Presence: tells the host whether this device actually has a player open, so
  // the seek quorum knows who it can legitimately wait on. Being IN a party and
  // WATCHING it are different things.
  useEffect(() => {
    send({ type: 'watching', watching: true })
    return () => send({ type: 'watching', watching: false })
  }, [send])

  return {
    status,
    isHost,
    following,
    canControl,
    notice,
    waitingNames,
    syncing: activeSyncRequestId !== null,
    seekTo,
    togglePlay,
    setPaused
  }
}
