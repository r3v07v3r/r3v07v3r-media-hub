'use client'

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '@renderer/context/AppStateContext'
import { useClock } from '@renderer/hooks/useClock'
import { useWeather } from '@renderer/hooks/useWeather'
import { Icon } from '@renderer/components/icons/Icon'
import { PartyButton } from '@renderer/components/party/PartyButton'
import { SyncNotificationButton } from './SyncNotificationButton'
import styles from './TopUtilityBar.module.css'

export function UserEnvironmentStatus() {
  const { profiles, activeProfileId, switchProfile } = useAppState()
  const { time, date } = useClock()
  const weather = useWeather()
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div className={styles.status}>
      <SyncNotificationButton />
      <PartyButton />

      <div className={styles.weather} aria-live="off">
        <Icon name="weather" className={styles.weatherIcon} />
        {weather.loading ? (
          <span className={styles.weatherSkeleton} aria-label="Loading weather" />
        ) : (
          <span className={styles.weatherTemp}>{Math.round(weather.tempC)}°</span>
        )}
      </div>

      <div className={styles.timeBlock}>
        <span className={styles.time}>{time}</span>
        <span className={styles.date}>{date}</span>
      </div>

      <div className={styles.separator} aria-hidden="true" />

      <div ref={rootRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className={styles.avatarButton}
          style={{
            background: `linear-gradient(135deg, ${activeProfile.avatarTint[0]}, ${activeProfile.avatarTint[1]})`
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Switch profile — currently ${activeProfile.name}`}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {activeProfile.avatarInitial}
        </button>
        {menuOpen && (
          <div className={`${styles.profileMenu} glass-panel`} role="menu">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === activeProfileId}
                aria-current={p.id === activeProfileId}
                className={styles.profileMenuItem}
                onClick={() => {
                  switchProfile(p.id)
                  setMenuOpen(false)
                }}
              >
                <span
                  className={styles.profileMenuAvatar}
                  style={{
                    background: `linear-gradient(135deg, ${p.avatarTint[0]}, ${p.avatarTint[1]})`
                  }}
                  aria-hidden="true"
                >
                  {p.avatarInitial}
                </span>
                {p.name}
                {p.id === activeProfileId && (
                  <Icon name="check" size={14} style={{ marginLeft: 'auto' }} />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
