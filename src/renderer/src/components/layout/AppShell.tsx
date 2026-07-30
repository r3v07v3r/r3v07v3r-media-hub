import { useEffect } from 'react'
import { BackgroundEffects } from './BackgroundEffects'
import { TopUtilityBar } from '@renderer/components/topbar/TopUtilityBar'
import { SidebarNavigation } from '@renderer/components/sidebar/SidebarNavigation'
import { GlobalOverlays } from '@renderer/components/overlays/GlobalOverlays'
import { useMotionSuspended } from '@renderer/hooks/useMotionSuspended'
import { useMotionUserDisabled } from '@renderer/hooks/useMotionUserDisabled'
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
