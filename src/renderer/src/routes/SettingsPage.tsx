import { useAppState } from '@renderer/context/AppStateContext'
import { Icon } from '@renderer/components/icons/Icon'
import { MediaServicesSection } from './MediaServicesSection'
import styles from './Settings.module.css'

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange
}: {
  icon: string
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowIcon} aria-hidden="true">
        <Icon name={icon} size={17} />
      </div>
      <div className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowDescription}>{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.switchThumb} />
      </button>
    </div>
  )
}

export default function SettingsPage() {
  const {
    performancePanelVisible,
    setPerformancePanelVisible,
    isOffline,
    setIsOffline,
    profiles,
    activeProfileId,
    setActiveProfileId
  } = useAppState()

  return (
    <div className={styles.wrap}>
      <h1 className={styles.heading}>Settings</h1>

      <section className={`${styles.section} glass-panel`} aria-labelledby="settings-perf">
        <h2 id="settings-perf" className={styles.sectionTitle}>
          Performance &amp; Display
        </h2>
        <ToggleRow
          icon="cpu"
          title="System performance panel"
          description="Show live CPU, GPU, RAM, and network gauges on the Home dashboard."
          checked={performancePanelVisible}
          onChange={setPerformancePanelVisible}
        />
      </section>

      <section className={`${styles.section} glass-panel`} aria-labelledby="settings-network">
        <h2 id="settings-network" className={styles.sectionTitle}>
          Network
        </h2>
        <ToggleRow
          icon={isOffline ? 'wifi-off' : 'wifi'}
          title="Simulate offline mode"
          description="Preview how R3 behaves without a network connection."
          checked={isOffline}
          onChange={setIsOffline}
        />
      </section>

      <MediaServicesSection />

      <section className={`${styles.section} glass-panel`} aria-labelledby="settings-profiles">
        <h2 id="settings-profiles" className={styles.sectionTitle}>
          Profiles
        </h2>
        <div className={styles.profileGrid}>
          {profiles.map((p) => {
            const active = p.id === activeProfileId
            return (
              <button
                key={p.id}
                type="button"
                className={`${styles.profileCard} ${active ? styles.profileCardActive : ''}`}
                onClick={() => setActiveProfileId(p.id)}
                aria-pressed={active}
              >
                <span
                  className={styles.profileAvatar}
                  style={{
                    background: `linear-gradient(135deg, ${p.avatarTint[0]}, ${p.avatarTint[1]})`
                  }}
                >
                  {p.avatarInitial}
                </span>
                <span className={styles.profileName}>{p.name}</span>
                {p.isKid && <span className={styles.profileBadge}>Kids</span>}
                {active && (
                  <span className={styles.profileCheck} aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
