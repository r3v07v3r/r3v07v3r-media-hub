import { AIResponsePanel } from './AIResponsePanel'
import { ContextMenu } from './ContextMenu'
import { NotificationLayer } from './NotificationLayer'
import { SyncReviewPanel } from './SyncReviewPanel'
import { ProfilePinPrompt } from '@renderer/components/profiles/ProfilePinPrompt'
import { SessionHub } from '@renderer/components/party/SessionHub'
import { PartyLoadingOverlay } from '@renderer/components/party/PartyLoadingOverlay'
import { PlaybackPreparationOverlay } from './PlaybackPreparationOverlay'

export function GlobalOverlays() {
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
      <AIResponsePanel />
      <ContextMenu />
      <PlaybackPreparationOverlay />
      {/* The player itself is no longer here. mpv renders into a native child
          window that composites above web content, so its controls live in
          their own transparent window (see main/media-hub/playerWindow.ts) —
          which also means the per-title `key` remount that used to reset the
          player's local state is now that window's own concern, and the mpv
          handle is no longer tied to any React lifecycle at all. */}
      <SessionHub />
      <PartyLoadingOverlay />
      <NotificationLayer />
      <SyncReviewPanel />
      <ProfilePinPrompt />
    </div>
  )
}
