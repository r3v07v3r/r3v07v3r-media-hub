// Resume position, periodic saves, and the watched threshold for the player
// overlay window.
//
// Ported from PlaybackOverlay's tracking effects with the segment arithmetic
// removed. Every position here is absolute, straight from mpv's `time-pos`.
// The old code had to compute `streamStartOffsetRef.current + video.currentTime`
// at every one of these call sites, because in compatibility mode the <video>
// element's clock restarted at 0 for each transcode segment — and getting that
// wrong silently saved the wrong resume point.
//
// The thresholds themselves are unchanged and still enforced in main
// (database.ts): under 20s in is never stored, and past 90% clears the bookmark
// instead of saving one. Those are covered by tests/playbackPosition.test.ts.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { PlayerSessionMedia } from '@shared/media-hub/player'

/** How often to persist position during continuous playback. */
const RESUME_SAVE_INTERVAL_MS = 20_000
/** Fraction of the runtime past which a title counts as watched. Deliberately
 *  not "reached the end": by the time the credits finish and `eof-reached`
 *  fires, the person has usually already closed the player, and continue-
 *  watching needs to be correct at that moment rather than after it. */
const WATCHED_FRACTION = 0.8

interface Options {
  media: PlayerSessionMedia | null
  timePos: number
  duration: number
  playing: boolean
  /** Current volume as the player's 0-2 multiplier. Saved WITH the resume
   *  bookmark rather than as a setting of its own, which is what makes it a
   *  property of the interrupted watch: a title that was left partway
   *  through comes back at the loudness it was left at, while one started
   *  fresh starts at the ordinary 100% main resets it to. */
  volume: number
  /** Raised so the main window can mark this watched — it holds the full
   *  MediaItem the tracking payload needs. */
  onMarkWatched: () => void
}

export interface PlayerTracking {
  /** Resume position fetched for this title, or null once applied/absent. */
  resumeSeconds: number | null
  consumeResume: () => void
  /** Volume stored with that bookmark, or null when there is none to
   *  restore — which is the common case and means "leave it at the 100%
   *  the title started at". */
  resumeVolume: number | null
  consumeResumeVolume: () => void
  /** Whether this title has already crossed the watched threshold — passed to
   *  stop-playback so the backend knows it can delete the local stream cache
   *  rather than keeping it for a likely resume. */
  markedWatched: () => boolean
  savePositionNow: () => void
}

export function usePlayerTracking({
  media,
  timePos,
  duration,
  playing,
  volume,
  onMarkWatched
}: Options): PlayerTracking {
  // Mirrored into refs so the unmount/interval closures read the LATEST values
  // rather than whatever was current when they were created. Updated in an
  // effect rather than during render — a ref written mid-render is exactly the
  // tearing hazard React's own lint rule is about.
  const positionRef = useRef({ time: 0, duration: 0 })
  const volumeRef = useRef(volume)
  const mediaRef = useRef(media)
  const onMarkWatchedRef = useRef(onMarkWatched)
  useEffect(() => {
    positionRef.current = { time: timePos, duration }
    volumeRef.current = volume
    mediaRef.current = media
    onMarkWatchedRef.current = onMarkWatched
  }, [timePos, duration, volume, media, onMarkWatched])
  const markedWatchedRef = useRef(false)
  // Carries the episode key alongside the value rather than being reset when
  // the episode changes. Resetting would mean a setState in an effect purely to
  // clear stale data; tagging it makes the staleness self-evident, so a resume
  // position fetched for the previous episode simply never matches and is never
  // applied. Only ever SET from the async fetch callback, which is where state
  // is supposed to be set from.
  const [resume, setResume] = useState<{ key: string; seconds: number } | null>(null)
  // Separate from `resume` above rather than a field on it, because the two
  // are applied at different moments: the seek waits for a duration to clamp
  // against, the volume needs nothing and goes on immediately.
  const [resumeVolume, setResumeVolume] = useState<{ key: string; volume: number } | null>(null)

  // Identity of the specific episode being tracked. The player window is not
  // remounted per episode (the same session can move from one to the next), so
  // this is what resets the per-episode state instead.
  const trackingKey = media
    ? `${media.id}:${media.seasonNumber ?? 'movie'}:${media.episodeNumber ?? 'movie'}`
    : ''

  const savePositionNow = useCallback(() => {
    const current = mediaRef.current
    const { time, duration: total } = positionRef.current
    if (!current || !time) return
    window.api?.mediaHub?.tracking
      .savePosition({
        id: current.id,
        playback: { season: current.seasonNumber, episode: current.episodeNumber },
        positionSeconds: time,
        durationSeconds: total || undefined,
        volume: volumeRef.current
      })
      .catch(() => {})
  }, [])

  // Fetch the saved position for this episode. Re-runs on episode change, not
  // just on mount.
  useEffect(() => {
    if (!media) return
    markedWatchedRef.current = false
    const key = trackingKey
    let cancelled = false
    window.api?.mediaHub?.tracking
      .getPosition({
        id: media.id,
        playback: { season: media.seasonNumber, episode: media.episodeNumber }
      })
      .then((result) => {
        if (cancelled) return
        const seconds = Number(result?.positionSeconds)
        if (Number.isFinite(seconds) && seconds > 0) setResume({ key, seconds })
        // Only a stored value is ever applied. Nothing stored means nothing to
        // do — main already put this title at 100% before the overlay was even
        // told which title it is (playerBridge's startPlayerSession).
        const storedVolume = Number(result?.volume)
        if (Number.isFinite(storedVolume) && storedVolume > 0) {
          setResumeVolume({ key, volume: storedVolume })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the episode, not the object identity
  }, [trackingKey])

  // Periodic save while actually playing. Paused playback saves once on the
  // pause itself (see the caller), not every 20s forever.
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(savePositionNow, RESUME_SAVE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [playing, savePositionNow])

  // Save on teardown — this covers closing the player, switching titles, and
  // the window being destroyed, which the periodic timer alone would miss.
  useEffect(() => {
    return () => savePositionNow()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one save per episode, on the way out
  }, [trackingKey])

  // The watched threshold.
  useEffect(() => {
    if (markedWatchedRef.current || !duration || !timePos) return
    if (timePos / duration < WATCHED_FRACTION) return
    markedWatchedRef.current = true
    onMarkWatchedRef.current()
  }, [timePos, duration])

  return {
    // Only surfaced while it still belongs to the episode being played.
    resumeSeconds: resume && resume.key === trackingKey ? resume.seconds : null,
    consumeResume: () => setResume(null),
    resumeVolume: resumeVolume && resumeVolume.key === trackingKey ? resumeVolume.volume : null,
    consumeResumeVolume: () => setResumeVolume(null),
    markedWatched: () => markedWatchedRef.current,
    savePositionNow
  }
}
