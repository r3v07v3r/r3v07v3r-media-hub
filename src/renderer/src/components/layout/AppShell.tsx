import { useEffect } from 'react'
import { BackgroundEffects } from './BackgroundEffects'
import { TopUtilityBar } from '@renderer/components/topbar/TopUtilityBar'
import { SidebarNavigation } from '@renderer/components/sidebar/SidebarNavigation'
import { GlobalOverlays } from '@renderer/components/overlays/GlobalOverlays'
import { useAppState } from '@renderer/context/AppStateContext'
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

  // While a film plays, the video is an embedded native child window covering
  // this whole document — every pixel of the page is invisible, but the page
  // can still be HIT: the controls overlay is click-through while its controls
  // are hidden, and mpv's embedded child processes no mouse input, so a click
  // that slips through both would land on whatever invisible element happens
  // to be underneath and quietly navigate the app under the film. Refuse
  // pointer events for the duration instead (global.css's
  // [data-playback-covered='true'] rule).
  //
  // The watch-party hub is the exception: it deliberately hides the video to
  // show main-window UI, which must stay clickable — so the attribute follows
  // "covered", not "playing".
  const { playbackMedia, partyPanelOpen } = useAppState()
  const playbackCovered = Boolean(playbackMedia) && !partyPanelOpen
  useEffect(() => {
    document.documentElement.dataset.playbackCovered = playbackCovered ? 'true' : 'false'
  }, [playbackCovered])

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
