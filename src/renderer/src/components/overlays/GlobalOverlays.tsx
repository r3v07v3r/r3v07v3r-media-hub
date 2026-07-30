import { useAppState } from '@renderer/context/AppStateContext'
import { PlaybackOverlay } from './PlaybackOverlay'
import { AIResponsePanel } from './AIResponsePanel'
import { ContextMenu } from './ContextMenu'
import { NotificationLayer } from './NotificationLayer'
import { OfflineBanner } from './OfflineBanner'
import { ProfilePinPrompt } from '@renderer/components/profiles/ProfilePinPrompt'
import { PartyPanel } from '@renderer/components/party/PartyPanel'

export function GlobalOverlays() {
  const { playbackMedia } = useAppState()
  return (
    // data-motion-exempt: every one-shot mount/entrance animation in the
    // app (fadeIn, aiPanelIn, toastIn — see Overlays.module.css) lives
    // somewhere under here. global.css's motion-suspend rule pauses
    // decorative animation app-wide the instant a movie starts playing —
    // but that's also the exact moment PlaybackOverlay itself mounts, so
    // without this exemption its own entrance fadeIn got frozen at its
    // opacity:0 starting keyframe (the video kept playing underneath,
    // fully functional and clickable, just permanently invisible). One-
    // shot entrances need to always finish; only ambient/idle looping
    // animation was ever meant to pause.
    <div data-motion-exempt="true">
      <OfflineBanner />
      <AIResponsePanel />
      <ContextMenu />
      {/* Keyed on the title's id so opening a new title (or "Restart") is a
          fresh mount — PlaybackOverlay's local playback state (status,
          currentTime, subtitle selection, etc.) then just starts from its
          natural initial values instead of being manually reset by an
          effect. */}
      <PlaybackOverlay key={playbackMedia?.id ?? 'none'} />
      <PartyPanel />
      <NotificationLayer />
      <ProfilePinPrompt />
    </div>
  )
}
