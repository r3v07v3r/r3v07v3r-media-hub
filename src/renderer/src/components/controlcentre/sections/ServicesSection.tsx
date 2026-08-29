'use client'

// Services — what each configured service is doing right now, and the
// controls that already exist for it.
//
// TWO RULES SHAPE THIS WHOLE SECTION.
//
// Only services with a real integration appear. Bazarr, Jellyseerr,
// SABnzbd and NZBGet have none in this app, so there is no card for them —
// a greyed-out brand implies a capability that is not there and invites
// somebody to file a bug about a feature nobody wrote. Subtitles are done
// by the app directly (SubDL / OpenSubtitles), so there is nothing to draw
// for Bazarr even in principle.
//
// And only figures the APIs actually report are shown. Uptime is the
// obvious omission: none of Sonarr, Radarr, Prowlarr, qBittorrent or
// Jellyfin reports it, so displaying it would mean inventing it. Setting
// up a service is Settings' job; this is where you see whether it is
// working.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SERVICE_SETTINGS,
  type ServiceConfig,
  type ServiceId,
  type ServiceSettings
} from '@shared/ipc-types'
import { Icon } from '@renderer/components/icons/Icon'
import { testConnection as testJellyfin } from '@renderer/lib/api/jellyfin'
import { sonarrClient, radarrClient } from '@renderer/lib/api/servarr'
import {
  deleteTorrent,
  getTorrents,
  pauseTorrent,
  resumeTorrent,
  testConnection as testQbittorrent,
  type QbTorrent
} from '@renderer/lib/api/qbittorrent'
import { getIndexerStatus, testConnection as testProwlarr } from '@renderer/lib/api/prowlarr'
import { SERVICE_LABELS, type ConnectionTestResult } from '@renderer/lib/api/types'
import styles from './CachingSection.module.css'
import own from './ServicesSection.module.css'

const TESTERS: Record<ServiceId, (config: ServiceConfig) => Promise<ConnectionTestResult>> = {
  jellyfin: testJellyfin,
  sonarr: sonarrClient.testConnection,
  radarr: radarrClient.testConnection,
  qbittorrent: testQbittorrent,
  prowlarr: testProwlarr
}

/** What each service is FOR, in the pipeline's terms. The cards are sorted
 *  by this order so they read down the path a play actually takes rather
 *  than alphabetically. */
const ROLE: Record<ServiceId, string> = {
  prowlarr: 'Finds releases',
  sonarr: 'Manages series',
  radarr: 'Manages films',
  qbittorrent: 'Downloads',
  jellyfin: 'Serves your library'
}

const ORDER: ServiceId[] = ['prowlarr', 'sonarr', 'radarr', 'qbittorrent', 'jellyfin']

const REFRESH_MS = 20_000

interface Live {
  /** null while the first check is still running. */
  connected: boolean | null
  detail: string
  /** Whatever the service reports that is worth a number. */
  metric?: { label: string; value: string }
  torrents?: QbTorrent[]
}

function speed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${bytesPerSecond} B/s`
  if (bytesPerSecond < 1024 ** 2) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
}

export function ServicesSection() {
  const [settings, setSettings] = useState<ServiceSettings | null>(null)
  const [live, setLive] = useState<Partial<Record<ServiceId, Live>>>({})
  const [busy, setBusy] = useState('')
  /** Guards against a refresh landing after the component is gone, and
   *  against two refreshes overlapping when one service is slow. */
  const runningRef = useRef(false)

  useEffect(() => {
    void Promise.resolve().then(async () => {
      if (!window.api?.settings) {
        setSettings(DEFAULT_SERVICE_SETTINGS)
        return
      }
      setSettings(await window.api.settings.get())
    })
  }, [])

  const probe = useCallback(async (current: ServiceSettings) => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      // Every service is asked at once. Sequentially, one unreachable box
      // with a slow TCP timeout would hold up the whole panel.
      await Promise.all(
        ORDER.filter((id) => current[id].enabled && current[id].baseUrl).map(async (id) => {
          const config = current[id]
          try {
            const result = await TESTERS[id](config)
            const next: Live = { connected: result.ok, detail: result.message ?? '' }

            if (result.ok && (id === 'sonarr' || id === 'radarr')) {
              const queue = await (id === 'sonarr' ? sonarrClient : radarrClient).getQueue(config)
              if (queue.ok && queue.data) {
                next.metric = { label: 'In queue', value: String(queue.data.length) }
              }
            }
            if (result.ok && id === 'prowlarr') {
              const failing = await getIndexerStatus(config)
              if (failing.ok && failing.data) {
                next.metric = {
                  label: 'Failing indexers',
                  value: String(failing.data.length)
                }
              }
            }
            if (result.ok && id === 'qbittorrent') {
              const torrents = await getTorrents(config)
              if (torrents.ok && torrents.data) {
                next.torrents = torrents.data
                next.metric = { label: 'Torrents', value: String(torrents.data.length) }
              }
            }
            setLive((prev) => ({ ...prev, [id]: next }))
          } catch (error) {
            // Each service is isolated. A client that throws rather than
            // returning a failed ClientResult — a malformed base URL, a
            // proxy that is not there — would otherwise reject the whole
            // Promise.all and leave every OTHER card stuck on 'Checking…'
            // for something that has nothing to do with it.
            setLive((prev) => ({
              ...prev,
              [id]: { connected: false, detail: (error as Error).message }
            }))
          }
        })
      )
    } finally {
      runningRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!settings) return
    void probe(settings)
    const timer = window.setInterval(() => void probe(settings), REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [settings, probe])

  const act = async (key: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await work()
      if (settings) {
        // The service's own state is the source of truth, so the row is
        // re-read rather than patched optimistically — a pause that the
        // client refused would otherwise show as paused.
        runningRef.current = false
        await probe(settings)
      }
    } finally {
      setBusy('')
    }
  }

  const header = (
    <header className={styles.head}>
      <h2 className={styles.title}>Services</h2>
      <p className={styles.blurb}>
        What each connected service is doing. Only services this app actually integrates with appear
        here, and only figures their APIs report — nothing is estimated.
      </p>
    </header>
  )

  if (!settings) return <div className={styles.wrap}>{header}</div>

  const configured = ORDER.filter((id) => settings[id].enabled && settings[id].baseUrl)

  return (
    <div className={styles.wrap}>
      {header}

      {configured.length === 0 && (
        <section className={`${styles.card} glass-panel`}>
          <p className={styles.note}>
            Nothing is connected yet. Add a server under Settings and it appears here.
          </p>
        </section>
      )}

      {configured.map((id) => {
        const state = live[id]
        const torrents = state?.torrents ?? []
        return (
          <section key={id} className={`${styles.card} glass-panel`}>
            <div className={styles.cardHead}>
              <div className={own.identity}>
                <span
                  className={`${own.lamp} ${
                    state?.connected === true
                      ? own.lampOk
                      : state?.connected === false
                        ? own.lampBad
                        : ''
                  }`}
                  aria-hidden="true"
                />
                <div>
                  <h3 className={styles.cardTitle}>{SERVICE_LABELS[id]}</h3>
                  <p className={styles.note}>
                    {ROLE[id]} ·{' '}
                    {state?.connected === null || state === undefined
                      ? 'Checking…'
                      : /* The tester's own message carries the version when
                           the API reports one, which is the only place a
                           version is available at all. */
                        state.detail || (state.connected ? 'Connected' : 'Not answering')}
                  </p>
                </div>
              </div>
              {state?.metric && (
                <div className={own.metric}>
                  <span className={own.metricValue}>{state.metric.value}</span>
                  <span className={own.metricLabel}>{state.metric.label}</span>
                </div>
              )}
            </div>

            {id === 'qbittorrent' && torrents.length > 0 && (
              <ul className={styles.jobs}>
                {torrents.slice(0, 6).map((torrent) => {
                  const paused = /paus|stopped/i.test(torrent.state)
                  return (
                    <li key={torrent.hash} className={styles.job}>
                      <span className={styles.jobTitle}>{torrent.name}</span>
                      <span className={styles.jobState}>
                        {Math.round(torrent.progress * 100)}%
                        {torrent.dlspeed > 0 ? ` · ${speed(torrent.dlspeed)}` : ''}
                      </span>
                      <button
                        type="button"
                        className={styles.ghostButton}
                        disabled={busy === torrent.hash}
                        onClick={() =>
                          void act(torrent.hash, () =>
                            paused
                              ? resumeTorrent(settings[id], torrent.hash)
                              : pauseTorrent(settings[id], torrent.hash)
                          )
                        }
                      >
                        {paused ? 'Resume' : 'Pause'}
                      </button>
                      {/* Deletes the torrent AND its files, so it says so.
                          A "Delete" that quietly removes data is the kind
                          of button people click once. */}
                      <button
                        type="button"
                        className={styles.ghostButton}
                        disabled={busy === torrent.hash}
                        onClick={() =>
                          void act(torrent.hash, () =>
                            deleteTorrent(settings[id], torrent.hash, true)
                          )
                        }
                      >
                        Delete with files
                      </button>
                    </li>
                  )
                })}
                {torrents.length > 6 && (
                  <li className={styles.note}>and {torrents.length - 6} more</li>
                )}
              </ul>
            )}
          </section>
        )
      })}

      <p className={styles.note}>
        <Icon name="info" size={13} /> Uptime is not shown because none of these APIs report it.
      </p>
    </div>
  )
}
