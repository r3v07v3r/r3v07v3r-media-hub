'use client'

// The pipeline — how a play actually flows through this install.
//
// Drawn from what is CONFIGURED, not from a fixed picture of an ideal
// setup. A stage nobody has filled shows as an empty slot with a plain
// sentence about what would go there; it does not show a greyed-out brand,
// because that implies a capability sitting behind a switch when what is
// actually missing is a server nobody has set up.
//
// Read top to bottom, this is the order a title takes: you ask for
// something, something finds it, something fetches it, something stores it,
// something plays it.
//
// Two stages are the app itself, and they are drawn like every other stage
// rather than being left out. "Where does the search happen" is a question
// somebody looking at this diagram will have, and the honest answer is
// "here", not silence.

import { useEffect, useState } from 'react'
import { DEFAULT_SERVICE_SETTINGS, type ServiceSettings } from '@shared/ipc-types'
import { useAppState } from '@renderer/context/AppStateContext'
import styles from './CachingSection.module.css'
import own from './PipelineSection.module.css'

interface Stage {
  key: string
  /** What this step does, in the person's terms — not the vendor's. */
  label: string
  /** The things doing it. Empty means nothing is configured for it. */
  parts: string[]
  /** Shown in place of the parts when there are none. Says what WOULD go
   *  here, so an empty slot is an instruction rather than a gap. */
  empty: string
}

export function PipelineSection() {
  const { mediaHubSettings } = useAppState()
  const [services, setServices] = useState<ServiceSettings | null>(null)
  const [lanCacheName, setLanCacheName] = useState<string | null>(null)

  useEffect(() => {
    void Promise.resolve().then(async () => {
      setServices(
        window.api?.settings ? await window.api.settings.get() : DEFAULT_SERVICE_SETTINGS
      )
      const lanCache = window.api?.mediaHub?.lanCache
      if (!lanCache) return
      const pair = await lanCache.pairStatus()
      // Only an APPROVED cache server is part of the pipeline. A pending
      // one holds a token that authorises nothing, so drawing it here
      // would show a step that cannot run.
      setLanCacheName(pair.state === 'approved' ? (pair.name ?? 'cache server') : null)
    })
  }, [])

  const header = (
    <header className={styles.head}>
      <h2 className={styles.title}>Pipeline</h2>
      <p className={styles.blurb}>
        How a title gets from you asking for it to it playing, through the services this install
        actually has. Empty steps are ones nothing is set up for.
      </p>
    </header>
  )

  // Only the service list is waited for, and it resolves immediately even
  // with no bridge. A MISSING snapshot is not a loading state — it reads as
  // 'nothing is linked', which draws the diagram with its steps empty and
  // their instructions showing. That is the honest picture of a fresh
  // install, and it is what somebody who opened this to find out what to set
  // up needs to see.
  if (!services) return <div className={styles.wrap}>{header}</div>
  const hub = mediaHubSettings

  const on = (id: keyof ServiceSettings): boolean =>
    services[id].enabled && Boolean(services[id].baseUrl.trim())

  const stages: Stage[] = [
    {
      key: 'request',
      label: 'You ask for something',
      parts: ['R3 search and browse'],
      empty: ''
    },
    {
      key: 'index',
      label: 'Something finds releases',
      parts: [...(on('prowlarr') ? ['Prowlarr'] : []), 'R3 built-in scrapers'],
      empty: ''
    },
    {
      key: 'manage',
      label: 'Something decides what to keep',
      parts: [...(on('sonarr') ? ['Sonarr'] : []), ...(on('radarr') ? ['Radarr'] : [])],
      empty: 'Sonarr or Radarr would go here, tracking series and films and asking for them itself.'
    },
    {
      key: 'fetch',
      label: 'Something fetches it',
      parts: [
        ...(hub?.torboxConnected ? ['TorBox'] : []),
        ...(on('qbittorrent') ? ['qBittorrent'] : [])
      ],
      empty: 'Nothing can download. Link TorBox or connect qBittorrent.'
    },
    {
      key: 'subtitles',
      label: 'Subtitles are found',
      parts: [
        ...(hub?.osConnected ? ['OpenSubtitles'] : []),
        ...(hub?.subdlConnected ? ['SubDL'] : [])
      ],
      // Deliberately no Bazarr: this app fetches subtitles itself, so there
      // is nothing for Bazarr to do in this pipeline even if it were set up.
      empty: 'No subtitle service is linked, so only subtitles inside the file itself are used.'
    },
    {
      key: 'store',
      label: 'It is stored on the way past',
      parts: [
        hub?.cacheMode === 'memory'
          ? 'Playback cache (memory only)'
          : 'Playback cache (disk)',
        ...(lanCacheName ? [`${lanCacheName} (network cache)`] : []),
        ...(on('jellyfin') ? ['Jellyfin library'] : [])
      ],
      empty: ''
    },
    {
      key: 'play',
      label: 'It plays',
      parts: [
        ...(hub?.playerAvailable ? ['mpv'] : []),
        ...(on('jellyfin') ? ['Jellyfin'] : [])
      ],
      empty: 'No player was found. Playback will not start until one is available.'
    }
  ]

  return (
    <div className={styles.wrap}>
      {header}

      <ol className={own.flow}>
        {stages.map((stage, index) => (
          <li key={stage.key} className={own.stage}>
            <span className={own.marker} aria-hidden="true">
              <span className={`${own.dot} ${stage.parts.length ? own.dotFilled : ''}`} />
              {/* The connector is drawn on every stage but the last, so the
                  column reads as one path rather than as a list. */}
              {index < stages.length - 1 && <span className={own.line} />}
            </span>
            <div className={own.body}>
              <span className={own.stageLabel}>{stage.label}</span>
              {stage.parts.length > 0 ? (
                <span className={own.parts}>
                  {stage.parts.map((part) => (
                    <span key={part} className={own.part}>
                      {part}
                    </span>
                  ))}
                </span>
              ) : (
                <span className={own.emptySlot}>{stage.empty}</span>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className={`${styles.card} glass-panel`}>
        <h3 className={styles.cardTitle}>Which copy wins</h3>
        <p className={styles.note}>
          {/* The one genuine preference in the pipeline, stated in the
              same words the Settings slider uses so the two agree. */}
          {hub?.sourcePreference === 'prefer-local'
            ? 'A copy on your own network is preferred, even at lower quality.'
            : hub?.sourcePreference === 'prefer-quality'
              ? 'The best release wins, even when a local copy exists.'
              : 'Local copies and quality are weighed against each other.'}
        </p>
      </section>
    </div>
  )
}
