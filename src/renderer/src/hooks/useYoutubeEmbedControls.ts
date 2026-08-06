import { useEffect, useRef, useState, type RefObject } from 'react'

const YT_ORIGIN = 'https://www.youtube-nocookie.com'

export interface YoutubeEmbedControls {
  /** True once the embed has responded at least once — before this, play/
   *  pause/seek calls are harmless no-ops (the player just isn't there yet). */
  ready: boolean
  playing: boolean
  currentTime: number
  duration: number
  togglePlay: () => void
  seek: (seconds: number) => void
}

interface YoutubeInfoDelivery {
  currentTime?: number
  playerState?: number
  progressState?: { duration?: number }
}

/**
 * Hand-rolled YouTube IFrame postMessage protocol, not Google's official
 * `iframe_api` loader script — this app's CSP is `script-src 'self'`
 * (see index.html), so loading https://www.youtube.com/iframe_api isn't
 * an option without weakening that policy, and doing this instead avoids
 * needing to. youtube-nocookie.com (already the only allowed `frame-src`)
 * accepts the identical command/telemetry postMessage protocol once its
 * src includes `enablejsapi=1` — the official wrapper is just a JS
 * convenience layer over the same messages sent here directly.
 *
 * Verified live against a real embed before wiring this into the app:
 * sending {event:'listening', id} is what starts the player pushing
 * {event:'infoDelivery'} messages back; most of those per-tick messages
 * only carry `currentTime` + `progressState.duration` (no `playerState`),
 * but every state TRANSITION (play/pause/buffer) delivers a fuller
 * payload that does include `playerState` (1 playing, 2 paused, 3
 * buffering, 0 ended, -1 unstarted, 5 cued) — so `playing` is only
 * updated when a message actually carries that field, never reset to a
 * guess on the frequent duration/time-only ticks.
 */
export function useYoutubeEmbedControls(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  active: boolean
): YoutubeEmbedControls {
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const handshakeTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  function post(func: string, args: unknown[] = []): void {
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      YT_ORIGIN
    )
  }

  useEffect(() => {
    if (!active) {
      // Reset before the "active" branch's own listeners get a chance to
      // attach again on a later re-activation — same "clear stale state
      // when a prop/value changes" pattern MediaDetailPage's own effects
      // (see its primary catalog:meta fetch) already use this exact
      // disable comment for.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(false)
      setPlaying(false)
      setCurrentTime(0)
      setDuration(0)
      return
    }

    function onMessage(e: MessageEvent): void {
      if (e.origin !== YT_ORIGIN) return
      let data: { event?: string; info?: YoutubeInfoDelivery }
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      } catch {
        return
      }
      if (data?.event !== 'infoDelivery' || !data.info) return
      setReady(true)
      if (handshakeTimer.current) {
        clearInterval(handshakeTimer.current)
        handshakeTimer.current = null
      }
      if (typeof data.info.currentTime === 'number') setCurrentTime(data.info.currentTime)
      const d = data.info.progressState?.duration
      if (typeof d === 'number' && d > 0) setDuration(d)
      if (typeof data.info.playerState === 'number') setPlaying(data.info.playerState === 1)
    }
    window.addEventListener('message', onMessage)

    // Retried on an interval, not sent once — the iframe's own document
    // may not have finished loading the player yet on this effect's first
    // run; repeating until the first infoDelivery arrives (which clears
    // this timer above) makes the handshake resilient to that race.
    handshakeTimer.current = setInterval(() => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 1 }),
        YT_ORIGIN
      )
    }, 250)

    return () => {
      window.removeEventListener('message', onMessage)
      if (handshakeTimer.current) clearInterval(handshakeTimer.current)
      handshakeTimer.current = null
    }
  }, [active, iframeRef])

  return {
    ready,
    playing,
    currentTime,
    duration,
    togglePlay: () => post(playing ? 'pauseVideo' : 'playVideo'),
    seek: (seconds: number) => post('seekTo', [seconds, true])
  }
}
