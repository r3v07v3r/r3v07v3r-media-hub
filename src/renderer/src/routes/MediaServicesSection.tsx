import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SERVICE_SETTINGS,
  ServiceConfig,
  ServiceId,
  ServiceSettings
} from '@shared/ipc-types'
import { testConnection as testJellyfin } from '@renderer/lib/api/jellyfin'
import { sonarrClient, radarrClient } from '@renderer/lib/api/servarr'
import { testConnection as testQbittorrent } from '@renderer/lib/api/qbittorrent'
import { testConnection as testProwlarr } from '@renderer/lib/api/prowlarr'
import { testConnection as testBazarr } from '@renderer/lib/api/bazarr'
import { SERVICE_LABELS, ConnectionTestResult } from '@renderer/lib/api/types'
import styles from './Settings.module.css'

const TESTERS: Record<ServiceId, (config: ServiceConfig) => Promise<ConnectionTestResult>> = {
  jellyfin: testJellyfin,
  sonarr: sonarrClient.testConnection,
  radarr: radarrClient.testConnection,
  qbittorrent: testQbittorrent,
  prowlarr: testProwlarr,
  bazarr: testBazarr
}

const SECRET_LABEL: Record<ServiceId, string> = {
  jellyfin: 'API Key',
  sonarr: 'API Key',
  radarr: 'API Key',
  qbittorrent: 'Username:Password',
  prowlarr: 'API Key',
  bazarr: 'API Key'
}

type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string }

function ServiceCard({
  id,
  config,
  onChange
}: {
  id: ServiceId
  config: ServiceConfig
  onChange: (next: ServiceConfig) => void
}) {
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  async function handleTest() {
    setTest({ status: 'testing' })
    const result = await TESTERS[id](config)
    setTest({ status: result.ok ? 'ok' : 'error', message: result.message })
  }

  return (
    <section className={`${styles.section} ${styles.serviceCard} glass-panel`}>
      <div className={styles.serviceHead}>
        <h3 className={styles.serviceName}>{SERVICE_LABELS[id]}</h3>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label={`Enable ${SERVICE_LABELS[id]}`}
          className={`${styles.switch} ${config.enabled ? styles.switchOn : ''}`}
          onClick={() => onChange({ ...config, enabled: !config.enabled })}
        >
          <span className={styles.switchThumb} />
        </button>
      </div>
      {id === 'jellyfin' && (
        // Turning Jellyfin on now has playback consequences, not just
        // metadata ones: it becomes a source the player will pull video
        // from, which means allowing the player to reach this address on
        // the local network. Worth saying plainly next to the switch that
        // does it.
        <p className={styles.serviceNote}>
          When enabled, this server is used for playback: titles it already has play from your
          network instead of being downloaded. Turning it off removes it as a source immediately.
        </p>
      )}
      <div className={styles.serviceFields}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Server URL</span>
          <input
            className={styles.fieldInput}
            type="text"
            placeholder="http://192.168.1.10:8096"
            value={config.baseUrl}
            onChange={(e) => onChange({ ...config, baseUrl: e.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{SECRET_LABEL[id]}</span>
          <input
            className={styles.fieldInput}
            type="password"
            placeholder={id === 'qbittorrent' ? 'admin:password' : '••••••••'}
            value={config.apiKey}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
          />
        </label>
      </div>
      <div className={styles.serviceActions}>
        <button
          type="button"
          className={styles.testButton}
          onClick={handleTest}
          disabled={test.status === 'testing'}
        >
          {test.status === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <span
          className={`${styles.statusMessage} ${
            test.status === 'ok'
              ? styles.statusOk
              : test.status === 'error'
                ? styles.statusError
                : styles.statusIdle
          }`}
        >
          {test.status === 'idle' && 'Not tested yet'}
          {test.status === 'testing' && 'Contacting server…'}
          {(test.status === 'ok' || test.status === 'error') && test.message}
        </span>
      </div>
    </section>
  )
}

/**
 * Real service configuration for Jellyfin/Sonarr/Radarr/qBittorrent —
 * persisted via electron-store in the main process (window.api.settings),
 * never localStorage. Every field starts blank/disabled; nothing here
 * pretends to have a live connection until a person fills it in and it's
 * verified with "Test connection" (spec: graceful mock-data fallback,
 * never silently faking a live connection).
 */
export function MediaServicesSection() {
  const [settings, setSettings] = useState<ServiceSettings>(DEFAULT_SERVICE_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  /** Which services this panel changed — see handleSave. */
  const edited = useRef<Set<ServiceId>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    // Always resolves asynchronously (even the "no bridge" path) rather
    // than calling setState synchronously in the effect body, which can
    // trigger an extra cascading render right after mount.
    Promise.resolve().then(async () => {
      if (!window.api?.settings) {
        setLoaded(true)
        return
      }
      const s = await window.api.settings.get()
      setSettings(s)
      setLoaded(true)
    })
  }, [])

  function updateService(id: ServiceId, next: ServiceConfig) {
    edited.current.add(id)
    setSettings((prev) => ({ ...prev, [id]: next }))
    setDirty(true)
  }

  async function handleSave() {
    if (!window.api?.settings) return
    setSaving(true)
    // Merged onto the latest, for the same reason the Pipeline panel does
    // it: both edit the same settings object, both are mounted at once,
    // and whichever saved last would otherwise revert the other.
    const latest = await window.api.settings.get()
    const merged = { ...latest }
    for (const id of edited.current) merged[id] = settings[id]
    const saved = await window.api.settings.set(merged)
    setSettings(saved)
    edited.current.clear()
    setSaving(false)
    setDirty(false)
  }

  if (!loaded) return null

  const bridgeMissing = !window.api?.settings

  return (
    <>
      {bridgeMissing && (
        <p className={styles.serviceNotice}>
          Running outside the Electron shell — settings can&apos;t be saved or tested here.
        </p>
      )}
      {(Object.keys(settings) as ServiceId[]).map((id) => (
        <ServiceCard
          key={id}
          id={id}
          config={settings[id]}
          onChange={(next) => updateService(id, next)}
        />
      ))}
      <div className={`${styles.serviceSaveCard} glass-panel`}>
        <div>
          {/* It used to say "Service changes", which named itself and
              explained nothing — it reads as a card ABOUT something rather
              than as the Save control for the cards beside it. It says what
              it acts on and what saving does now. */}
          <strong>Server details</strong>
          <span>
            {dirty
              ? 'Unsaved edits to the servers above. Saving stores them and starts using them.'
              : 'Every address and key above is saved.'}
          </span>
        </div>
        <button
          type="button"
          className={styles.saveButton}
          onClick={handleSave}
          disabled={!dirty || saving || bridgeMissing}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </>
  )
}
