import { BackgroundEffects } from './BackgroundEffects'
import { TopUtilityBar } from '@renderer/components/topbar/TopUtilityBar'
import { SidebarNavigation } from '@renderer/components/sidebar/SidebarNavigation'
import { GlobalOverlays } from '@renderer/components/overlays/GlobalOverlays'
import styles from './AppShell.module.css'

export function AppShell({ children }: { children: React.ReactNode }) {
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
