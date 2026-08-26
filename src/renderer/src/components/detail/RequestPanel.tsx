// "Get this" — hand a title to Sonarr or Radarr from the page you found it on.
//
// Both services have been connected for a while and did nothing but show a
// queue. The whole point of running them is that they FETCH things, and the
// two endpoints that ask them to are the reason Overseerr and Jellyseerr
// exist as separate products. This is that flow, against a connection the
// person has already configured.
//
// Renders nothing at all unless the matching service is configured — a panel
// offering to request a title from a server that does not exist would be
// worse than no panel. It also renders nothing for anime: the catalog gives
// anime a Kitsu id, which neither app understands, and a request that
// silently looked up the wrong show is the one outcome worse than not
// offering the button.

import { useEffect, useState } from 'react'

import { Icon } from '@renderer/components/icons/Icon'
import { useAppState } from '@renderer/context/AppStateContext'
import {
  radarrClient,
  sonarrClient,
  type ServarrLookupResult,
  type ServarrOption,
  type ServarrRootFolder
} from '@renderer/lib/api/servarr'
import { isConfigured } from '@renderer/lib/api/types'
import type { MediaItem } from '@renderer/types'
import { DEFAULT_SERVICE_SETTINGS, type ServiceSettings } from '@shared/ipc-types'
import styles from './RequestPanel.module.css'

/** Movie and series ids in this catalog are IMDb ids; anime ids are Kitsu
 *  (`kitsu:12345`), which is why anime has no request path here. */
function imdbId(media: MediaItem): string | null {
  return /^tt\d+$/.test(media.id) ? media.id : null
}

type Stage =
  | { kind: 'loading' }
  /** Configured, reachable, and this title is not in the library yet. */
  | { kind: 'ready'; lookup: ServarrLookupResult }
  | { kind: 'already' }
  | { kind: 'sent' }
  | { kind: 'unavailable'; reason: string }

export function RequestPanel({ media }: { media: MediaItem }) {
  const { pushNotification } = useAppState()
  const [settings, setSettings] = useState<ServiceSettings>(DEFAULT_SERVICE_SETTINGS)
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [profiles, setProfiles] = useState<ServarrOption[]>([])
  const [folders, setFolders] = useState<ServarrRootFolder[]>([])
  const [profileId, setProfileId] = useState<number | null>(null)
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const kind = media.mediaKind ?? (media.mediaType === 'series' ? 'series' : 'movie')
  const isSeries = kind === 'series'
  const client = isSeries ? sonarrClient : radarrClient
  const label = isSeries ? 'Sonarr' : 'Radarr'
  const config = isSeries ? settings.sonarr : settings.radarr
  const id = imdbId(media)
  const supported = kind !== 'anime' && id !== null

  // Which title and which server the stage below describes. Reset during
  // render rather than from the effect, the same way SidebarNavigation handles
  // its route-keyed state: setting it inside the effect cascades a render, and
  // for the moment between the two the panel would still be showing the
  // PREVIOUS title's answer — "already in your library" against a show it was
  // never about.
  const requestKey = supported ? `${label}:${id}:${config.baseUrl}` : null
  const [stageFor, setStageFor] = useState<string | null>(null)
  if (stageFor !== requestKey) {
    setStageFor(requestKey)
    setStage({ kind: 'loading' })
  }

  useEffect(() => {
    let cancelled = false
    window.api?.settings
      ?.get()
      .then((next) => {
        if (!cancelled) setSettings(next ?? DEFAULT_SERVICE_SETTINGS)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!supported || !isConfigured(config) || !id) return
    let cancelled = false

    // All three at once. The lookup is the slow one (the server queries TVDB
    // or TMDB on our behalf), and making the person wait for the profile list
    // afterwards would double a wait that has no reason to be sequential.
    Promise.all([
      client.lookupByImdb(config, id),
      client.getProfiles(config),
      client.getRootFolders(config)
    ])
      .then(([found, profileList, folderList]) => {
        if (cancelled) return
        if (!found.ok) {
          setStage({ kind: 'unavailable', reason: found.error ?? `${label} did not answer.` })
          return
        }
        if (!found.data) {
          setStage({
            kind: 'unavailable',
            reason: `${label} could not find this title.`
          })
          return
        }
        // A lookup result carrying an id is already in the library.
        if (found.data.id) {
          setStage({ kind: 'already' })
          return
        }
        setProfiles(profileList.data ?? [])
        setFolders(folderList.data ?? [])
        setProfileId(profileList.data?.[0]?.id ?? null)
        setFolderPath(folderList.data?.[0]?.path ?? null)
        setStage({ kind: 'ready', lookup: found.data })
      })
      .catch(() => {
        if (!cancelled) setStage({ kind: 'unavailable', reason: `${label} could not be reached.` })
      })

    return () => {
      cancelled = true
    }
  }, [supported, config, id, client, label])

  async function send(lookup: ServarrLookupResult) {
    if (profileId == null || !folderPath) return
    setSending(true)
    try {
      const result = await client.add(config, lookup, {
        qualityProfileId: profileId,
        rootFolderPath: folderPath,
        searchNow: true
      })
      if (!result.ok) {
        pushNotification({
          tone: 'error',
          message: result.error ?? `${label} refused the request.`
        })
        return
      }
      setStage({ kind: 'sent' })
      pushNotification({ tone: 'success', message: `${media.title} sent to ${label}.` })
    } finally {
      setSending(false)
    }
  }

  // Nothing to offer, and nothing worth explaining: somebody who has not
  // connected Sonarr or Radarr is not waiting to hear about them on a title
  // page.
  if (!supported || !isConfigured(config)) return null
  if (stage.kind === 'loading') return null

  return (
    <section className={`${styles.panel} glass-panel`} aria-label={`Request from ${label}`}>
      <h2 className={styles.heading}>Get this from {label}</h2>

      {/* Said rather than hidden. Somebody who connected Sonarr and is looking
          at a title page has a reason to know the server did not answer, or
          could not find this — silently showing nothing looks like the feature
          is missing rather than like the server is. */}
      {stage.kind === 'unavailable' && <p className={styles.note}>{stage.reason}</p>}

      {stage.kind === 'already' && (
        <p className={styles.note}>
          <Icon name="check" size={14} />
          Already in your {label} library.
        </p>
      )}

      {stage.kind === 'sent' && (
        <p className={styles.note}>
          <Icon name="check" size={14} />
          Sent to {label}, and a search has started. Track it on the Downloads page.
        </p>
      )}

      {stage.kind === 'ready' && (
        <>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Quality</span>
              <select
                className={styles.select}
                value={profileId ?? ''}
                onChange={(event) => setProfileId(Number(event.target.value))}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Folder</span>
              <select
                className={styles.select}
                value={folderPath ?? ''}
                onChange={(event) => setFolderPath(event.target.value)}
              >
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            className={styles.request}
            disabled={sending || profileId == null || !folderPath}
            onClick={() => void send(stage.lookup)}
          >
            {sending ? 'Sending…' : `Request${isSeries ? ' series' : ''}`}
          </button>
          {/* The two selects come from the server, so an empty list means the
              server has none configured — which is a real state worth naming
              rather than a disabled button with no explanation. */}
          {(profiles.length === 0 || folders.length === 0) && (
            <p className={styles.note}>Add a quality profile and a root folder in {label} first.</p>
          )}
        </>
      )}
    </section>
  )
}
