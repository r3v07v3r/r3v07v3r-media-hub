import { MediaDetailModal } from './MediaDetailModal'
import { PlaybackOverlay } from './PlaybackOverlay'
import { AIResponsePanel } from './AIResponsePanel'
import { ContextMenu } from './ContextMenu'
import { NotificationLayer } from './NotificationLayer'
import { OfflineBanner } from './OfflineBanner'

export function GlobalOverlays() {
  return (
    <>
      <OfflineBanner />
      <AIResponsePanel />
      <ContextMenu />
      <MediaDetailModal />
      <PlaybackOverlay />
      <NotificationLayer />
    </>
  )
}
