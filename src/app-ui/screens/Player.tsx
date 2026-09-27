import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  PlayerCommand,
  PlayerSessionSnapshot,
  PlayerStatePatch
} from '@shared/media-hub/player'
import { usePlayerTracking } from '../../renderer/src/hooks/usePlayerTracking'
import { api, overlayApi } from '../lib/api'
import { nativeHost } from '../lib/nativeHost'
import { nowPlaying } from '../lib/nowPlaying'
import StatusNote from '../components/StatusNote'
import './Player.css'

/** How long the controls stay up after the last touch or key while playing. */
const CONTROLS_IDLE_MS = 4000

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * The phone/TV player. The video itself is the Android app's libmpv, drawn
 * UNDER this page (android/.../PlayerHost.kt); this screen is transparent
 * and only draws the controls, over the overlay-scope connection the
 * desktop's controls window uses (see main/media-hub/playerWindow.ts's HOST
 * MODE). Resume position and the watched threshold are the desktop overlay's
 * own hook, reused as is.
 *
 * Leaving the screen, by the back button or Back, stops playback; the backend
 * ending the session (end of file, an error) leaves the screen.
 */
export default function Player() {
  const navigate = useNavigate()
  const overlay = overlayApi()
  const [state, setState] = useState<PlayerStatePatch>({})
  const [session, setSession] = useState<PlayerSessionSnapshot | null>(null)
  const [controlsShown, setControlsShown] = useState(true)
  const [seeking, setSeeking] = useState<number | null>(null)
  const idleTimer = useRef<number | undefined>(undefined)

  const timePos = state.timePos ?? 0
  const duration = state.duration ?? 0
  const paused = state.paused ?? false
  const volume = state.volume ?? 1
  const media = session?.media ?? null

  const command = useCallback(
    (next: PlayerCommand) => {
      overlay?.player.command(next).catch(() => {})
    },
    [overlay]
  )

  // Transparent page + screen held on, for as long as this screen is up.
  useEffect(() => {
    document.documentElement.classList.add('video-under')
    nativeHost()?.setPlayerActive(true)
    return () => {
      document.documentElement.classList.remove('video-under')
      nativeHost()?.setPlayerActive(false)
    }
  }, [])

  // State: pulled once (the session exists before this screen mounts), then
  // pushed as patches. A patch's absent key means unchanged.
  useEffect(() => {
    if (!overlay) return
    let live = true
    overlay.player
      .snapshot()
      .then(({ session: s, state: st }) => {
        if (!live) return
        setSession(s)
        setState((previous) => ({ ...previous, ...st }))
      })
      .catch(() => {})
    const offState = overlay.player.onState((patch) =>
      setState((previous) => ({ ...previous, ...patch }))
    )
    const offSession = overlay.player.onSession(setSession)
    const offClosed = overlay.player.onHostClosed(() => navigate(-1))
    return () => {
      live = false
      offState()
      offSession()
      offClosed()
    }
  }, [overlay, navigate])

  const tracking = usePlayerTracking({
    media,
    timePos,
    duration,
    playing: !paused,
    volume,
    onMarkWatched: useCallback(() => {
      const current = nowPlaying()
      if (!current) return
      api()
        ?.tracking.markWatched({
          item: {
            id: current.item.id,
            type: current.kind,
            title: current.item.title,
            poster: current.item.poster,
            year: current.item.year
          },
          playback: { season: current.season, episode: current.episode }
        })
        .catch(() => {})
    }, [])
  })

  // Resume where it was left, once there is a duration to clamp against.
  useEffect(() => {
    if (tracking.resumeSeconds === null || !duration) return
    command({ type: 'seek', seconds: Math.min(tracking.resumeSeconds, Math.max(0, duration - 5)) })
    tracking.consumeResume()
  }, [tracking, duration, command])
  useEffect(() => {
    if (tracking.resumeVolume === null) return
    command({ type: 'set-volume', volume: tracking.resumeVolume })
    tracking.consumeResumeVolume()
  }, [tracking, command])

  // Leaving stops playback. Read through a ref so the unmount sees the
  // latest answer, not the one from the first render.
  const markedWatched = useRef(tracking.markedWatched)
  useEffect(() => {
    markedWatched.current = tracking.markedWatched
  }, [tracking.markedWatched])
  useEffect(() => {
    return () => {
      api()
        ?.playback.stop({ watched: markedWatched.current() })
        .catch(() => {})
    }
  }, [])

  // Controls fade while playing and come back on any touch or key.
  const wake = useCallback(() => {
    setControlsShown(true)
    window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setControlsShown(false), CONTROLS_IDLE_MS)
  }, [])
  useEffect(() => {
    // An effect only arms the timer; the state change happens in the timeout.
    if (paused) {
      window.clearTimeout(idleTimer.current)
      return
    }
    idleTimer.current = window.setTimeout(() => setControlsShown(false), CONTROLS_IDLE_MS)
    return () => window.clearTimeout(idleTimer.current)
  }, [paused])
  useEffect(() => {
    window.addEventListener('keydown', wake)
    return () => window.removeEventListener('keydown', wake)
  }, [wake])

  const shown = controlsShown || paused
  const position = seeking ?? timePos
  const tracks = state.tracks
  const title = media
    ? media.seasonNumber != null
      ? `${media.title} · S${media.seasonNumber}E${media.episodeNumber ?? 1}`
      : media.title
    : ''

  if (!overlay) return <StatusNote tone="error">Not connected to a backend.</StatusNote>

  return (
    <div
      className={`player-screen${shown ? '' : ' player-screen--idle'}`}
      onPointerDown={wake}
      aria-label="Player"
    >
      <div className="player-screen__top">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back">
          ‹ Back
        </button>
        <span className="player-screen__title">{title}</span>
      </div>

      {(state.bufferingForCache || !duration) && (
        <div className="player-screen__buffering" role="status">
          Loading…
        </div>
      )}

      <div className="player-screen__bottom">
        <div className="player-screen__seek">
          <span>{clock(position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={Math.min(position, duration || position)}
            aria-label="Position"
            onChange={(event) => setSeeking(Number(event.target.value))}
            onPointerUp={() => {
              if (seeking !== null) command({ type: 'seek', seconds: seeking })
              setSeeking(null)
            }}
            onKeyUp={() => {
              if (seeking !== null) command({ type: 'seek', seconds: seeking })
              setSeeking(null)
            }}
          />
          <span>{clock(duration)}</span>
        </div>
        <div className="player-screen__buttons">
          <button
            type="button"
            onClick={() => command({ type: 'seek', seconds: Math.max(0, timePos - 10) })}
            aria-label="Back 10 seconds"
          >
            −10
          </button>
          <button
            type="button"
            className="player-screen__play"
            onClick={() => {
              command({ type: 'toggle-pause' })
              if (!paused) tracking.savePositionNow()
            }}
            aria-label={paused ? 'Play' : 'Pause'}
          >
            {paused ? '▶' : '❚❚'}
          </button>
          <button
            type="button"
            onClick={() => command({ type: 'seek', seconds: timePos + 30 })}
            aria-label="Forward 30 seconds"
          >
            +30
          </button>
          {tracks && tracks.audio.length > 1 && (
            <select
              aria-label="Audio"
              value={state.audioOrdinal ?? tracks.audio[0]?.ordinal}
              onChange={(event) =>
                command({ type: 'set-audio-track', ordinal: Number(event.target.value) })
              }
            >
              {tracks.audio.map((track) => (
                <option key={track.ordinal} value={track.ordinal}>
                  {track.label}
                </option>
              ))}
            </select>
          )}
          {tracks && tracks.subtitle.length > 0 && (
            <select
              aria-label="Subtitles"
              value={state.subtitleOrdinal ?? -1}
              onChange={(event) =>
                command({ type: 'set-subtitle-track', ordinal: Number(event.target.value) })
              }
            >
              <option value={-1}>Subtitles off</option>
              {tracks.subtitle.map((track) => (
                <option key={track.ordinal} value={track.ordinal}>
                  {track.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  )
}
