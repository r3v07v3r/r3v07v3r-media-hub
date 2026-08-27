// Ported from r3v07v3r-media-hub's src/main.cjs (osUserAgent/osLoginWith/
// osRequest/osDownloadSubtitleText, and the os:connect/os:disconnect/
// subtitles:search IPC handlers). OpenSubtitles credentials/token live in
// the shared media-hub settings file (see settingsStore.ts) exactly as in
// the original — this module only adds the request/auth-retry logic on top.
//
// Since the port, this module hosts TWO subtitle providers: OpenSubtitles
// (above) and SubDL (below), searched together and merged into one list by
// mergeSubtitleResults. The provider-agnostic entry points the rest of the
// app uses are the subtitles:search handler and downloadSubtitleText; the
// pure per-provider helpers live in opensubtitles.ts and subdl.ts. SubDL
// exists here because OpenSubtitles caps a free account at 5 subtitle
// downloads per day, which one evening of viewing exhausts — see subdl.ts's
// header for the full rationale.
//
// TODO(media-hub-integration): the `r3v07v3r-media-hub v${app.getVersion()}`
// User-Agent string below is copied verbatim from the original app. Left
// as-is rather than rebranded to this project's name, since it's unclear
// whether OpenSubtitles ties API access/rate-limits to this string in a way
// that's enforced server-side — changing it is a functional risk for zero
// user-visible benefit. Revisit if that's confirmed safe.

import { app } from 'electron'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { ConnectResult, SubtitleResult, SubtitleSelection } from '../../shared/media-hub/types'
import { fetchJson, type HttpError } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import { computeActiveStreamHash } from './movieHash'
import {
  buildSearchParams,
  normalizeSubtitleResult,
  type OpenSubtitlesSearchItem,
  type OpenSubtitlesSearchPlayback
} from './opensubtitles'
import {
  buildSubdlSearchParams,
  normalizeSubdlResult,
  readSrtFromZip,
  resolveSubdlDownloadUrl
} from './subdl'
import {
  encrypt,
  osConnected,
  osCredentials,
  readSettings,
  subdlConnected,
  subdlCredentials,
  writeSettings
} from './settingsStore'

const OS_API = 'https://api.opensubtitles.com/api/v1'
const SUBDL_API = 'https://api.subdl.com/api/v1'

/** How many rows the merged subtitle menu shows in total — unchanged from
 *  when OpenSubtitles was the only provider. */
const SEARCH_RESULT_LIMIT = 20

function osUserAgent(): string {
  return `r3v07v3r-media-hub v${app.getVersion()}`
}

async function osLoginWith(apiKey: string, username: string, password: string): Promise<string> {
  const result = await fetchJson<{ token?: string }>(`${OS_API}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': apiKey,
      'User-Agent': osUserAgent()
    },
    body: JSON.stringify({ username, password })
  })
  if (!result.token) throw new Error('OpenSubtitles login failed.')
  return result.token
}

/** Authenticated OpenSubtitles request. Lazily logs in (and persists the resulting token) if no token is cached yet, and transparently re-logs-in and retries once on a 401. */
async function osRequest<T = unknown>(pathname: string, options: RequestInit = {}): Promise<T> {
  const creds = osCredentials()
  if (!creds.apiKey || !creds.username || !creds.password) {
    throw new Error('OpenSubtitles is not connected.')
  }
  let token = creds.token
  if (!token) {
    token = await osLoginWith(creds.apiKey, creds.username, creds.password)
    const s = readSettings()
    s.osToken = encrypt(token)
    writeSettings(s)
  }
  const call = (tok: string): Promise<T> =>
    fetchJson<T>(`${OS_API}${pathname}`, {
      ...options,
      headers: {
        'Api-Key': creds.apiKey,
        'User-Agent': osUserAgent(),
        Authorization: `Bearer ${tok}`,
        ...options.headers
      }
    })
  try {
    return await call(token)
  } catch (error) {
    if ((error as HttpError)?.status !== 401) throw error
    token = await osLoginWith(creds.apiKey, creds.username, creds.password)
    const s = readSettings()
    s.osToken = encrypt(token)
    writeSettings(s)
    return await call(token)
  }
}

/** Downloads and returns the raw SRT text for an OpenSubtitles file id. Reached through downloadSubtitleText below, which is what playbackSession.ts's subtitles:apply handler calls. */
async function osDownloadSubtitleText(fileId: number): Promise<string> {
  const result = await osRequest<{ link?: string }>('/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId })
  })
  if (!result.link) throw new Error('OpenSubtitles did not return a download link.')
  const response = await fetch(result.link)
  if (!response.ok) throw new Error('Could not download the subtitle file.')
  return response.text()
}

// --- SubDL ----------------------------------------------------------------
//
// Far less machinery than OpenSubtitles above: the API key goes on the query
// string, there is no login/token/refresh cycle, and the archives are
// fetched anonymously. See subdl.ts's header for why this provider is worth
// having alongside OpenSubtitles at all.

/** Caps the archive body pulled from dl.subdl.com. Subtitle zips are tens of
 *  KB; this bounds what a hostile or broken response can make the main
 *  process buffer, since readSrtFromZip needs the whole thing in memory. */
const MAX_SUBDL_ARCHIVE_BYTES = 16 * 1024 * 1024

interface SubdlSearchResponse {
  status?: unknown
  error?: unknown
  subtitles?: unknown[]
}

/**
 * Runs a SubDL search with `apiKey`.
 *
 * SubDL signals failure with `{status: false, error}` on an otherwise-200
 * response, which httpClient's own `success: false` convention does not
 * cover — so that case is unwrapped into a thrown Error here, keeping every
 * failure on this path a rejection rather than an empty result list.
 */
async function subdlSearch(
  apiKey: string,
  item: OpenSubtitlesSearchItem | undefined,
  playback: OpenSubtitlesSearchPlayback
): Promise<SubtitleResult[]> {
  const params = buildSubdlSearchParams(item, playback)
  const query = new URLSearchParams({
    api_key: apiKey,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
  }).toString()

  const result = await fetchJson<SubdlSearchResponse>(`${SUBDL_API}/subtitles?${query}`)
  if (result.status === false) {
    throw new Error(String(result.error || 'SubDL search failed.'))
  }

  return (result.subtitles || [])
    .map(normalizeSubdlResult)
    .filter((entry) => resolveSubdlDownloadUrl(entry.downloadPath))
}

/** Downloads a SubDL archive and returns the SRT text inside it. */
async function subdlDownloadSubtitleText(downloadPath: string): Promise<string> {
  const url = resolveSubdlDownloadUrl(downloadPath)
  if (!url) throw new Error('Invalid subtitle selection.')

  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not download the subtitle file.')

  // Checked BEFORE reading the body, not after: buffering the whole
  // response first and then measuring it would be a guard that has already
  // let the thing it guards against happen. The post-read check stays as
  // the backstop for a response that under-reports (or omits) its length.
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SUBDL_ARCHIVE_BYTES) {
    throw new Error('The subtitle archive is unexpectedly large.')
  }

  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.byteLength > MAX_SUBDL_ARCHIVE_BYTES) {
    throw new Error('The subtitle archive is unexpectedly large.')
  }
  return readSrtFromZip(archive)
}

/**
 * Fetches the SRT text for whichever provider `selection` names. The single
 * entry point playbackSession's subtitles:apply handler uses, so that
 * handler never has to know how either provider delivers a file.
 */
export async function downloadSubtitleText(selection: SubtitleSelection): Promise<string> {
  if (selection.provider === 'subdl') {
    return subdlDownloadSubtitleText(selection.downloadPath)
  }
  return osDownloadSubtitleText(selection.fileId)
}

/**
 * Merges the two providers' rows into one menu.
 *
 * SubDL goes first, and that ordering is the point of the feature rather
 * than an arbitrary tie-break: "Always have subtitles" and any hurried
 * click take the top row, and a SubDL row costs nothing to download, where
 * an OpenSubtitles row spends one of a free account's five daily
 * downloads. Each provider is still guaranteed half the list so a
 * SubDL-heavy result set can never hide OpenSubtitles entirely, with
 * whichever side has more backfilling any unused half.
 */
export function mergeSubtitleResults(
  subdl: SubtitleResult[],
  openSubtitles: SubtitleResult[],
  limit = SEARCH_RESULT_LIMIT
): SubtitleResult[] {
  const half = Math.ceil(limit / 2)
  const merged = [...subdl.slice(0, half), ...openSubtitles.slice(0, limit - half)]
  const seen = new Set(merged.map((entry) => entry.id))
  const backfill = [...subdl, ...openSubtitles].filter((entry) => !seen.has(entry.id))
  return [...merged, ...backfill].slice(0, limit)
}

interface OsConnectPayload {
  apiKey?: string
  username?: string
  password?: string
}

interface SubdlConnectPayload {
  apiKey?: string
}

interface SubtitlesSearchPayload {
  item?: OpenSubtitlesSearchItem
  playback?: OpenSubtitlesSearchPlayback
}

export function registerSubtitlesIpc(): void {
  handle<OsConnectPayload | undefined, ConnectResult>(
    MEDIA_HUB_CHANNELS.osConnect,
    async (_event, payload) => {
      const key = String(payload?.apiKey || '').trim()
      const user = String(payload?.username || '').trim()
      const pass = String(payload?.password || '')
      if (!key || !user || !pass) {
        return { ok: false, message: 'Enter your OpenSubtitles API key, username and password.' }
      }
      try {
        const token = await osLoginWith(key, user, pass)
        const s = readSettings()
        s.osApiKey = encrypt(key)
        s.osUsername = encrypt(user)
        s.osPassword = encrypt(pass)
        s.osToken = encrypt(token)
        writeSettings(s)
        return { ok: true, message: 'OpenSubtitles connected.' }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.osDisconnect, () => {
    const s = readSettings()
    delete s.osApiKey
    delete s.osUsername
    delete s.osPassword
    delete s.osToken
    writeSettings(s)
    return { ok: true }
  })

  handle<SubdlConnectPayload | undefined, ConnectResult>(
    MEDIA_HUB_CHANNELS.subdlConnect,
    async (_event, payload) => {
      const key = String(payload?.apiKey || '').trim()
      if (!key) return { ok: false, message: 'Enter your SubDL API key.' }
      try {
        // SubDL has no login endpoint, so a real (cheap) search stands in as
        // the credential check — otherwise "Connected" would only mean "you
        // typed something", and a bad key would first surface mid-playback.
        await subdlSearch(key, { id: 'tt1375666', type: 'movie' }, { language: 'en' })
        const s = readSettings()
        s.subdlApiKey = encrypt(key)
        writeSettings(s)
        return { ok: true, message: 'SubDL connected.' }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.subdlDisconnect, () => {
    const s = readSettings()
    delete s.subdlApiKey
    writeSettings(s)
    return { ok: true }
  })

  handle<SubtitlesSearchPayload | undefined, SubtitleResult[]>(
    MEDIA_HUB_CHANNELS.subtitlesSearch,
    async (_event, payload) => {
      const language = readSettings().subtitleLanguage || 'en'
      const item = payload?.item || {}
      const playback = { ...payload?.playback, language }

      const subdlOn = subdlConnected()
      const osOn = osConnected()
      if (!subdlOn && !osOn) {
        throw new Error('Connect SubDL or OpenSubtitles in Settings to search for subtitles.')
      }

      // Fired off now, awaited only inside the OpenSubtitles branch below —
      // not before either provider starts. SubDL's search must not wait on
      // a tail read off a torrent that may not have downloaded it yet; only
      // the branch that can actually USE the hash pays for computing it, and
      // even that one only pays up to computeActiveStreamHash's own bounded
      // timeout, never longer. Imported here rather than at the top of the
      // file: playbackSession.ts imports THIS module (downloadSubtitleText),
      // so a static import here would be a cycle — see recommendations.ts's
      // rebuildRecommendations for the same pattern and the same reason.
      const movieHashPromise = osOn
        ? import('./playbackSession').then(({ activeStreamUrl }) =>
            computeActiveStreamHash(activeStreamUrl())
          )
        : Promise.resolve(null)

      // Both providers are searched together and failures are per-provider:
      // one being down, rate-limited or holding a stale key must not empty
      // a menu the other could still fill. A provider that is not connected
      // simply contributes nothing.
      const [subdlOutcome, osOutcome] = await Promise.allSettled([
        subdlOn
          ? subdlSearch(subdlCredentials().apiKey, item, playback)
          : Promise.resolve<SubtitleResult[]>([]),
        osOn
          ? (async () => {
              const movieHash = await movieHashPromise
              const params = buildSearchParams(item, {
                ...playback,
                movieHash: movieHash?.hash,
                movieBytes: movieHash?.bytes
              })
              const query = new URLSearchParams(
                Object.fromEntries(
                  Object.entries(params).map(([key, value]) => [key, String(value)])
                )
              ).toString()
              const result = await osRequest<{ data?: unknown[] }>(`/subtitles?${query}`)
              return (result.data || []).map(normalizeSubtitleResult).filter((x) => x.fileId)
            })()
          : Promise.resolve<SubtitleResult[]>([])
      ])

      if (subdlOutcome.status === 'rejected') {
        logError('media-hub:subtitles:subdl', subdlOutcome.reason)
      }
      if (osOutcome.status === 'rejected') {
        logError('media-hub:subtitles:opensubtitles', osOutcome.reason)
      }

      // Raised only when every CONNECTED provider failed — counting the
      // not-connected one's resolved [] as a success would mask the real
      // failure. That is not hypothetical: with only SubDL connected (the
      // setup this provider exists to make viable), a bad key, an outage or
      // a rate-limit came back as a bare "No results" in the menu while the
      // actual reason went only to logs/media-hub.log, which is exactly the
      // dead end that made "SubDL isn't loading" impossible to act on.
      const failures = [
        subdlOn && subdlOutcome.status === 'rejected' ? subdlOutcome.reason : undefined,
        osOn && osOutcome.status === 'rejected' ? osOutcome.reason : undefined
      ].filter((reason) => reason !== undefined)
      if (failures.length === Number(subdlOn) + Number(osOn)) {
        throw failures[0]
      }

      return mergeSubtitleResults(
        subdlOutcome.status === 'fulfilled' ? subdlOutcome.value : [],
        osOutcome.status === 'fulfilled' ? osOutcome.value : []
      )
    }
  )
}
