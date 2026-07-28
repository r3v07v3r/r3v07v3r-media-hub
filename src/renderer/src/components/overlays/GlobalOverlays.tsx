import { useAppState } from '@renderer/context/AppStateContext'
import { PlaybackOverlay } from './PlaybackOverlay'
import { AIResponsePanel } from './AIResponsePanel'
import { ContextMenu } from './ContextMenu'
import { NotificationLayer } from './NotificationLayer'
import { OfflineBanner } from './OfflineBanner'

export function GlobalOverlays() {
  const { playbackMedia } = useAppState()
  return (
    <>
      <OfflineBanner />
      <AIResponsePanel />
      <ContextMenu />
      {/* Keyed on the title's id so opening a new title (or "Restart") is a
          fresh mount — PlaybackOverlay's local playback state (status,
          currentTime, subtitle selection, etc.) then just starts from its
          natural initial values instead of being manually reset by an
          effect. */}
      <PlaybackOverlay key={playbackMedia?.id ?? 'none'} />
      <NotificationLayer />
    </>
  )
}
