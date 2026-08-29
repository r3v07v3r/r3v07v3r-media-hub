'use client'

// The pipeline — how a play actually flows through this install, as a thing
// you can point at and change.
//
// Read left to right, this is the order a title takes: you ask for
// something, something finds it, something decides to keep it, something
// fetches it, subtitles are found, it is stored on the way past, it plays.
//
// DRAWN FROM WHAT IS CONFIGURED, not from a picture of an ideal setup. A
// node that nothing backs is dimmed; a stage with no OUTSIDE service in it
// says what adding one would buy. What it never does is draw a brand this
// app has no integration with — see pipeline.ts for the list and why, and
// for why R3's own function is drawn first in every stage that has one.
//
// Clicking a node selects it and brings up its settings underneath.
// Selecting is separate from switching a service ON, deliberately: those
// are one click apart rather than the same click, so pointing at your
// download client to look at it cannot turn it off.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_SERVICE_SETTINGS, type ServiceConfig, type ServiceSettings } from '@shared/ipc-types'
import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import { testConnection as testJellyfin } from '@renderer/lib/api/jellyfin'
import { sonarrClient, radarrClient } from '@renderer/lib/api/servarr'
import { testConnection as testQbittorrent } from '@renderer/lib/api/qbittorrent'
import { testConnection as testProwlarr } from '@renderer/lib/api/prowlarr'
import type { ConnectionTestResult } from '@renderer/lib/api/types'
import { PIPELINE, PIPELINE_NODES, type PipelineNode } from '../pipeline'
import styles from './CachingSection.module.css'
import own from './PipelineSection.module.css'

const TESTERS = {
  jellyfin: testJellyfin,
  sonarr: sonarrClient.testConnection,
  radarr: radarrClient.testConnection,
  qbittorrent: testQbittorrent,
  prowlarr: testProwlarr
} as const

const SECRET_LABEL = {
  jellyfin: 'API key',
  sonarr: 'API key',
  radarr: 'API key',
  qbittorrent: 'Username:password',
  prowlarr: 'API key'
} as const

export function PipelineSection() {
  const { mediaHubSettings } = useAppState()
  const [services, setServices] = useState<ServiceSettings | null>(null)
  const [lanCache, setLanCache] = useState(false)
  const [selected, setSelected] = useState<string>('r3-browse')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<{ id: string; result: ConnectionTestResult } | null>(null)

  useEffect(() => {
    void Promise.resolve().then(async () => {
      setServices(
        window.api?.settings ? await window.api.settings.get() : DEFAULT_SERVICE_SETTINGS
      )
      const api = window.api?.mediaHub?.lanCache
      if (!api) return
      // Only an APPROVED cache server is part of the pipeline. A pending one
      // holds a token that authorises nothing, so drawing it as present
      // would show a step that cannot run.
      setLanCache((await api.pairStatus()).state === 'approved')
    })
  }, [])

  /** Whether a node is actually doing its job right now. The one place that
   *  question is answered, so the diagram, the dimming and the config panel
   *  cannot disagree about it. */
  const isLive = useCallback(
    (node: PipelineNode): boolean => {
      if (node.config.kind === 'service') {
        const config = services?.[node.config.service]
        return Boolean(config?.enabled && config.baseUrl.trim())
      }
      if (node.config.kind === 'builtin') {
        // mpv is the one built-in that can genuinely be absent — it is a
        // binary fetched at install. The rest are the app itself: R3's own
        // tracking and the player's reading of embedded subtitle tracks run
        // whether or not anything else is set up, which is the whole reason
        // they are drawn.
        return node.id === 'mpv' ? Boolean(mediaHubSettings?.playerAvailable) : true
      }
      if (node.id === 'torbox') return Boolean(mediaHubSettings?.torboxConnected)
      if (node.id === 'opensubtitles') return Boolean(mediaHubSettings?.osConnected)
      if (node.id === 'subdl') return Boolean(mediaHubSettings?.subdlConnected)
      if (node.id === 'lan-cache') return lanCache
      return false
    },
    [services, mediaHubSettings, lanCache]
  )

  const patch = (next: ServiceConfig): void => {
    const entry = PIPELINE_NODES[selected]
    if (!services || entry?.node.config.kind !== 'service') return
    setServices({ ...services, [entry.node.config.service]: next })
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (!services || !window.api?.settings) return
    setBusy(true)
    setServices(await window.api.settings.set(services))
    setDirty(false)
    setBusy(false)
  }

  const runTest = async (): Promise<void> => {
    const entry = PIPELINE_NODES[selected]
    if (!services || entry?.node.config.kind !== 'service') return
    const id = entry.node.config.service
    setBusy(true)
    setTest({ id: selected, result: await TESTERS[id](services[id]) })
    setBusy(false)
  }

  const selectedEntry = PIPELINE_NODES[selected]
  const stageOf = selectedEntry?.stage
  /** The tabs are the OTHER nodes in the same stage, because that is the
   *  choice being made — which tool fills this step — rather than a flat
   *  list of everything in the pipeline. */
  const tabs = useMemo(() => stageOf?.nodes ?? [], [stageOf])

  const header = (
    <header className={styles.head}>
      <h2 className={styles.title}>Pipeline</h2>
      <p className={styles.blurb}>
        How a title gets from you asking for it to it playing. Click any step to choose what fills
        it and set it up.
      </p>
    </header>
  )

  if (!services) return <div className={styles.wrap}>{header}</div>

  return (
    <div className={`${styles.wrap} ${own.wide}`}>
      {header}

      <div className={own.legend}>
        <span className={own.legendItem}>
          <span className={`${own.dot} ${own.dotLive}`} /> Active
        </span>
        <span className={own.legendItem}>
          <span className={own.dot} /> Available, not set up
        </span>
      </div>

      {/* Scrolls sideways rather than wrapping. Seven stages wrapped onto two
          rows stop reading as a left-to-right path, which is the only thing
          this diagram is for. */}
      <div className={own.flowScroll}>
        <ol className={own.flow}>
          {PIPELINE.map((stage, index) => {
            // The hint is about OUTSIDE services only. R3's own function is
            // live in several stages by definition, so counting it would
            // hide the suggestion in exactly the stages that most want one.
            const outsideLive = stage.nodes.some(
              (node) => node.config.kind !== 'builtin' && isLive(node)
            )
            return (
              <li key={stage.id} className={own.stage}>
                <div className={own.stageHead}>
                  <span className={own.stageIcon} aria-hidden="true">
                    <Icon name={stage.icon} size={14} />
                  </span>
                  <span className={own.stageLabel}>{stage.label}</span>
                </div>
                <p className={own.stageBlurb}>{stage.blurb}</p>

                <div className={own.nodes}>
                  {stage.nodes.map((node) => {
                    const live = isLive(node)
                    return (
                      <button
                        key={node.id}
                        type="button"
                        aria-pressed={node.id === selected}
                        className={`${own.node} ${live ? own.nodeLive : ''} ${
                          node.id === selected ? own.nodeSelected : ''
                        }`}
                        onClick={() => {
                          setSelected(node.id)
                          setTest(null)
                        }}
                      >
                        <span className={own.nodeIcon} aria-hidden="true">
                          <Icon name={node.icon} size={16} />
                        </span>
                        <span className={own.nodeText}>
                          <span className={own.nodeLabel}>{node.label}</span>
                          <span className={own.nodeDetail}>{node.detail}</span>
                        </span>
                        <span
                          className={`${own.dot} ${live ? own.dotLive : ''}`}
                          aria-hidden="true"
                        />
                      </button>
                    )
                  })}
                </div>

                {!outsideLive && stage.hint && <p className={own.stageHint}>{stage.hint}</p>}

                {/* Between stages, not after the last one, so the row reads
                    as a path with an end rather than as one that trails off. */}
                {index < PIPELINE.length - 1 && (
                  <span className={own.connector} aria-hidden="true">
                    <Icon name="chevron" size={16} />
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>

      {/* ---------- the selected step's settings ---------- */}
      {selectedEntry && (
        <section className={`${styles.card} glass-panel`}>
          <div className={own.tabs} role="tablist" aria-label={`${stageOf?.label} options`}>
            {tabs.map((node) => (
              <button
                key={node.id}
                type="button"
                role="tab"
                aria-selected={node.id === selected}
                className={`${own.tab} ${node.id === selected ? own.tabActive : ''}`}
                onClick={() => {
                  setSelected(node.id)
                  setTest(null)
                }}
              >
                {node.label}
              </button>
            ))}
          </div>

          <ConfigPanel
            node={selectedEntry.node}
            stageLabel={stageOf?.label ?? ''}
            services={services}
            live={isLive(selectedEntry.node)}
            dirty={dirty}
            busy={busy}
            test={test?.id === selected ? test.result : null}
            onPatch={patch}
            onSave={save}
            onTest={runTest}
          />
        </section>
      )}
    </div>
  )
}

function ConfigPanel({
  node,
  stageLabel,
  services,
  live,
  dirty,
  busy,
  test,
  onPatch,
  onSave,
  onTest
}: {
  node: PipelineNode
  stageLabel: string
  services: ServiceSettings
  live: boolean
  dirty: boolean
  busy: boolean
  test: ConnectionTestResult | null
  onPatch: (next: ServiceConfig) => void
  onSave: () => Promise<void>
  onTest: () => Promise<void>
}) {
  if (node.config.kind === 'builtin') {
    return (
      <p className={styles.note}>
        {node.label} is part of R3 itself and fills this step with nothing to set up.
        {node.id === 'mpv' && !live
          ? ' The bundled player was not found, so playback cannot start.'
          : ''}
      </p>
    )
  }

  if (node.config.kind === 'account') {
    return (
      <div className={own.panelBody}>
        <p className={styles.note}>
          {live
            ? `${node.label} is linked and filling this step.`
            : `${node.label} is not linked, so it is not part of the pipeline yet.`}
        </p>
        {/* A second copy of a credential form is a second place for it to be
            wrong. This says where the real one is instead. */}
        <p className={styles.note}>Linked in {node.config.where}.</p>
      </div>
    )
  }

  const id = node.config.service
  const config = services[id]

  return (
    <div className={own.panelBody}>
      <div className={own.enableRow}>
        <span className={styles.toggleText}>
          <span className={styles.toggleTitle}>Use {node.label} for {stageLabel.toLowerCase()}</span>
          <span className={styles.note}>
            {config.baseUrl.trim()
              ? config.enabled
                ? 'On — this step runs through it.'
                : 'Off — the step falls to whatever else is in it.'
              : 'Needs an address before it can be switched on.'}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label={`Use ${node.label}`}
          className={`${styles.switch} ${config.enabled ? styles.switchOn : ''}`}
          onClick={() => onPatch({ ...config, enabled: !config.enabled })}
        >
          <span className={styles.switchThumb} />
        </button>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Address</span>
        <input
          className={styles.fieldInput}
          type="text"
          spellCheck={false}
          placeholder="http://192.168.1.20:8989"
          value={config.baseUrl}
          onChange={(event) => onPatch({ ...config, baseUrl: event.target.value })}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{SECRET_LABEL[id]}</span>
        <input
          className={styles.fieldInput}
          // Not `type="password"`: this is a self-hosted service key on the
          // person's own machine, and hiding it only stops them checking it
          // against the one their server shows.
          type="text"
          spellCheck={false}
          value={config.apiKey}
          onChange={(event) => onPatch({ ...config, apiKey: event.target.value })}
        />
      </label>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => void onTest()}
          disabled={busy || !config.baseUrl.trim()}
        >
          Test connection
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => void onSave()}
          disabled={busy || !dirty}
        >
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>

      {test && (
        <p className={`${styles.message} ${test.ok ? styles.messageOk : styles.messageError}`}>
          {test.message}
        </p>
      )}
    </div>
  )
}
