import { useEffect } from 'react'
import { BackgroundEffects } from './BackgroundEffects'
import { TopUtilityBar } from '@renderer/components/topbar/TopUtilityBar'
import { SidebarNavigation } from '@renderer/components/sidebar/SidebarNavigation'
import { GlobalOverlays } from '@renderer/components/overlays/GlobalOverlays'
import { useMotionSuspended } from '@renderer/hooks/useMotionSuspended'
import { useMotionUserDisabled } from '@renderer/hooks/useMotionUserDisabled'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './AppShell.module.css'

export function AppShell({ children }: { children: React.ReactNode }) {
  // A single global switch for every decorative CSS animation in the app
  // (sidebar highlights, background blobs, shimmer, halo pulses, ...) —
  // see global.css's `[data-motion-suspended='true'] *` rule. Cheaper and
  // far less invasive than teaching every individual component's CSS
  // module about visibility/playback state; this is the one place that
  // needs to know, and a data attribute is all the rest need to react to.
  const motionSuspended = useMotionSuspended()
  useEffect(() => {
    document.documentElement.dataset.motionSuspended = motionSuspended ? 'true' : 'false'
  }, [motionSuspended])

  // Same idea, driven by the standing Settings > More Options toggle
  // instead of the automatic hidden/playing check above — see
  // useMotionUserDisabled's own comment.
  const motionUserDisabled = useMotionUserDisabled()
  useEffect(() => {
    document.documentElement.dataset.motionUserDisabled = motionUserDisabled ? 'true' : 'false'
  }, [motionUserDisabled])

  // Drives the app's own retreat while the control centre is open — the
  // interface tilts and pulls back as the cube rolls forward over it, so the
  // two read as one movement in depth rather than a panel appearing on top of
  // a static page.
  //
  // An attribute on <html> rather than a prop threaded through the layout,
  // matching the two motion flags above: the three elements that move are
  // siblings in this grid, and none of them owns the state.
  //
  // Deliberately NOT applied to .shell itself, which would be the obvious
  // place. A transform on an ancestor becomes the containing block for every
  // position:fixed descendant — and GlobalOverlays (which hosts the control
  // centre) is inside .shell, so transforming it collapses the very overlay
  // this is reacting to. The three children move instead.
  const { controlCentreOpen } = useAppState()
  useEffect(() => {
    document.documentElement.dataset.controlCentre = controlCentreOpen ? 'true' : 'false'
  }, [controlCentreOpen])

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <BackgroundEffects />
      <div className={styles.topbar}>
        <TopUtilityBar />
      </div>
      <div className={`${styles.sidebar} thin-scroll`}>
        <SidebarNavigation />
      </div>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        {children}
      </main>
      <GlobalOverlays />
    </div>
  )
}
