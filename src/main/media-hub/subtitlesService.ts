// Ported from r3v07v3r-media-hub's src/main.cjs (osUserAgent/osLoginWith/
// osRequest/osDownloadSubtitleText, and the os:connect/os:disconnect/
// subtitles:search IPC handlers). OpenSubtitles credentials/token live in
// the shared media-hub settings file (see settingsStore.ts) exactly as in
// the original — this module only adds the request/auth-retry logic on top.
//
// Since the port, this module hosts THREE subtitle providers: OpenSubtitles
// (above), SubDL (below) and SubtitleDB (below that, and the only one that
// needs no account), searched together and merged into one list by
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
import { readLimitedResponseBytes } from '../../shared/media-hub/responseLimit'
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
  decodeSubtitleText,
  normalizeSubdlResult,
  readSrtFromZip,
  resolveSubdlDownloadUrl
} from './subdl'
import {
  buildTsdbInfohashPath,
  buildTsdbLookupPath,
  normalizeTsdbResult,
  resolveTsdbDownloadUrl,
  stripLeadingCredits,
  TSDB_API_ORIGIN,
  type TsdbLookupResponse
} from './subtitledb'
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

/** Caps a single subtitle file pulled from OpenSubtitles' download link. A
 *  feature-length SRT is around 100 KB and even a heavily typeset one stays
 *  well under this; it bounds what a hostile or broken host can make the
 *  main process buffer. */
const MAX_SUBTITLE_FILE_BYTES = 8 * 1024 * 1024

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
  const body = await readLimitedResponseBytes(
    response,
    MAX_SUBTITLE_FILE_BYTES,
    'The subtitle file is unexpectedly large.'
  )
  return new TextDecoder().decode(body)
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

  const rows = (result.subtitles || []).map(normalizeSubdlResult)
  const usable = rows.filter((entry) => resolveSubdlDownloadUrl(entry.downloadPath))
  if (rows.length && !usable.length) {
    // Every row refused is SubDL changing the shape of its links (as it did
    // when it put the API key on them), not a title without subtitles; a
    // bare "No results" in the menu hid that for weeks.
    logError(
      'media-hub:subtitles:subdl',
      new Error(
        `SubDL returned ${rows.length} rows and none had a usable download path, e.g. ${JSON.stringify(
          rows[0].downloadPath
        )}`
      )
    )
  }
  return usable
}

/** Downloads a SubDL archive and returns the SRT text inside it. */
async function subdlDownloadSubtitleText(downloadPath: string): Promise<string> {
  const url = resolveSubdlDownloadUrl(downloadPath)
  if (!url) throw new Error('Invalid subtitle selection.')

  let response = await fetch(url)
  if (response.status === 401 || response.status === 403) {
    // The archives are public today (subdl.ts's header has the check), but
    // SubDL now writes the key onto its links, so a day it starts requiring
    // one is plausible. The key goes on the query string the way SubDL's
    // own links carry it, and only after a refusal, so the free anonymous
    // path stays the one normally used.
    const withKey = new URL(url)
    withKey.searchParams.set('api_key', subdlCredentials().apiKey)
    response = await fetch(withKey)
  }
  if (!response.ok) throw new Error('Could not download the subtitle file.')

  // Capped while streaming, not after: buffering the whole response first
  // and then measuring it would be a guard that has already let the thing
  // it guards against happen. A declared length over the cap is refused
  // before any of the body is read.
  const archive = await readLimitedResponseBytes(
    response,
    MAX_SUBDL_ARCHIVE_BYTES,
    'The subtitle archive is unexpectedly large.'
  )
  return readSrtFromZip(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength))
}

// --- SubtitleDB -----------------------------------------------------------
//
// No key, no login, no account: see subtitledb.ts's header for why it is
// the first provider searched and the one every install has.

/** Caps a subtitle file from SubtitleDB — the same bound as the
 *  OpenSubtitles download above, for the same reason. */
const MAX_TSDB_FILE_BYTES = 8 * 1024 * 1024

/** How long one SubtitleDB request may take before the other providers'
 *  rows go out without it. */
const TSDB_TIMEOUT_MS = 12_000
/** How long to wait before the one retry of a lookup SubtitleDB answered
 *  503 (busy) to. */
const TSDB_BUSY_RETRY_MS = 2_000

/**
 * One SubtitleDB lookup. A 503 (busy) is retried once after a short wait,
 * since a busy moment should not empty the menu. Any other failure is
 * thrown, so searchSubtitles can tell "nothing filed" from "could not ask".
 */
async function tsdbLookup(pathname: string): Promise<SubtitleResult[]> {
  const call = (): Promise<TsdbLookupResponse> =>
    fetchJson<TsdbLookupResponse>(
      `${TSDB_API_ORIGIN}${pathname}`,
      {},
      { timeoutMs: TSDB_TIMEOUT_MS }
    )
  let result: TsdbLookupResponse
  try {
    result = await call()
  } catch (error) {
    // A 503 carries a retry-after of a few seconds; httpClient only reads
    // that header on a 429, so one short fixed wait stands in for it.
    if ((error as HttpError)?.status !== 503) throw error
    await new Promise((resolve) => setTimeout(resolve, TSDB_BUSY_RETRY_MS))
    result = await call()
  }
  return (result.subtitles?.items || [])
    .map((entry) => normalizeTsdbResult(entry, pathname.startsWith('/v1/by-infohash/')))
    .filter((entry) => resolveTsdbDownloadUrl(entry.downloadPath))
}

/**
 * Searches SubtitleDB for one title: by the torrent's info hash first, when
 * the copy playing is a torrent (those rows are timed to this exact
 * release, and come back marked hashMatch), then by the title's IMDb id or
 * name. The hash lookup finds nothing for a re-encode nobody has filed yet,
 * so the title lookup always runs too; a title lookup that cannot be built
 * (no id, no name) is simply skipped.
 */
async function tsdbSearch(
  item: OpenSubtitlesSearchItem,
  playback: OpenSubtitlesSearchPlayback & { language: string },
  infoHash: string | undefined
): Promise<SubtitleResult[]> {
  const paths = [
    buildTsdbInfohashPath(infoHash, playback.language),
    buildTsdbLookupPath(item, playback)
  ].filter(Boolean)
  if (!paths.length) return []
  const outcomes = await Promise.allSettled(paths.map(tsdbLookup))
  const rows: SubtitleResult[] = []
  const seen = new Set<string>()
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue
    for (const row of outcome.value) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  // Both lookups failing is a failure; one of them is not, as long as the
  // other answered. (An info-hash lookup for a torrent SubtitleDB has never
  // seen answers 404, which is an empty list here, not a rejection.)
  const failed = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  )
  if (failed.length === outcomes.length) throw failed[0].reason
  return rows
}

/** Downloads one SubtitleDB file and returns its text. The API answers
 *  with a redirect to the file host, which fetch follows. */
async function tsdbDownloadSubtitleText(downloadPath: string): Promise<string> {
  const url = resolveTsdbDownloadUrl(downloadPath)
  if (!url) throw new Error('Invalid subtitle selection.')
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not download the subtitle file.')
  const body = await readLimitedResponseBytes(
    response,
    MAX_TSDB_FILE_BYTES,
    'The subtitle file is unexpectedly large.'
  )
  return stripLeadingCredits(
    decodeSubtitleText(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
  )
}

/**
 * Fetches the SRT text for whichever provider `selection` names. The single
 * entry point playbackSession's subtitles:apply handler uses, so that
 * handler never has to know how any provider delivers a file.
 */
export async function downloadSubtitleText(selection: SubtitleSelection): Promise<string> {
  if (selection.provider === 'subtitledb') {
    return tsdbDownloadSubtitleText(selection.downloadPath)
  }
  if (selection.provider === 'subdl') {
    return subdlDownloadSubtitleText(selection.downloadPath)
  }
  return osDownloadSubtitleText(selection.fileId)
}

/**
 * Merges the providers' rows into one menu, in the order given: SubtitleDB,
 * then SubDL, then OpenSubtitles.
 *
 * That order is the point rather than a tie-break: "Show subtitles
 * automatically" and any hurried click take the top row, and a SubtitleDB
 * or SubDL row costs nothing to download, where an OpenSubtitles row spends
 * one of a free account's five daily downloads. Every provider with rows is
 * still guaranteed a share of the list, so a large catalogue can never
 * hide a small one entirely, and whoever has more backfills what the
 * others leave. Rows matched to the exact release playing (hashMatch) go
 * to the top whichever provider found them: they are the ones that need
 * no delay nudging.
 */
export function mergeSubtitleResults(
  lists: SubtitleResult[][],
  limit = SEARCH_RESULT_LIMIT
): SubtitleResult[] {
  const present = lists.filter((list) => list.length)
  const share = present.length ? Math.ceil(limit / present.length) : limit
  const merged = present.flatMap((list) => list.slice(0, share)).slice(0, limit)
  const seen = new Set(merged.map((entry) => entry.id))
  const backfill = present.flat().filter((entry) => !seen.has(entry.id))
  const rows = [...merged, ...backfill].slice(0, limit)
  const exact = rows.filter((entry) => entry.hashMatch)
  return exact.length ? [...exact, ...rows.filter((entry) => !entry.hashMatch)] : rows
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
    (_event, payload) =>
      searchSubtitles(payload?.item || {}, {
        ...payload?.playback,
        language: readSettings().subtitleLanguage || 'en'
      })
  )
}

/**
 * The id the providers can find an anime by. A Kitsu id means nothing to
 * either, so an anime used to be searched by its title alone — which for a
 * later season ("...Slime Season 4") or a romaji name matched nothing, and
 * the Online subtitles list stayed empty. The show's IMDb id, with the
 * season and episode, is how both file TV subtitles. Falls back to the item
 * as it was when no IMDb id is known.
 */
async function searchableItem(item: OpenSubtitlesSearchItem): Promise<OpenSubtitlesSearchItem> {
  const id = String(item.id || '')
  if (item.type !== 'anime' || !id.startsWith('kitsu:')) return item
  try {
    const { crossIdsForKitsu } = await import('./idBridge')
    const imdb = (await crossIdsForKitsu(id)).imdb
    if (imdb && /^tt\d+$/.test(imdb)) return { ...item, id: imdb, type: 'series' }
  } catch (error) {
    logError('media-hub:subtitles:anime-id', error)
  }
  return item
}

/**
 * Searches every provider for one title and merges the rows — the
 * subtitles:search handler, and play:stream's automatic fetch for a copy
 * with neither the wanted audio nor subtitles. SubtitleDB is always asked;
 * SubDL and OpenSubtitles when a key is held. There is no "nothing is set
 * up" case any more: a fresh install has SubtitleDB.
 */
export async function searchSubtitles(
  rawItem: OpenSubtitlesSearchItem,
  playback: OpenSubtitlesSearchPlayback & { language: string }
): Promise<SubtitleResult[]> {
  const subdlOn = subdlConnected()
  const osOn = osConnected()

  // Up to two network round trips for an anime's IMDb id, shared by all
  // three providers.
  const item = await searchableItem(rawItem)

  // What is playing, for the two exact-release lookups: SubtitleDB's by
  // the torrent's info hash, OpenSubtitles' by the file's hash. Imported
  // here rather than at the top of the file: playbackSession.ts imports
  // THIS module (downloadSubtitleText), so a static import here would be a
  // cycle — see recommendations.ts's rebuildRecommendations for the same
  // pattern and the same reason.
  const session = await import('./playbackSession')
  const infoHash = session.activeRelease()?.infoHash

  // Fired off now, awaited only inside the OpenSubtitles branch below —
  // not before either provider starts. The other providers' searches must
  // not wait on a tail read off a torrent that may not have downloaded it
  // yet; only the branch that can actually USE the hash pays for computing
  // it, and even that one only pays up to computeActiveStreamHash's own
  // bounded timeout, never longer.
  const movieHashPromise = osOn
    ? computeActiveStreamHash(session.activeStreamUrl())
    : Promise.resolve(null)

  // Every provider is searched together and failures are per-provider:
  // one being down, rate-limited or holding a stale key must not empty
  // a menu the others could still fill. A provider that is not connected
  // simply contributes nothing.
  const [tsdbOutcome, subdlOutcome, osOutcome] = await Promise.allSettled([
    tsdbSearch(item, playback, infoHash),
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
          const search = async (
            searchParams: Record<string, string | number>
          ): Promise<SubtitleResult[]> => {
            const query = new URLSearchParams(
              Object.fromEntries(
                Object.entries(searchParams).map(([key, value]) => [key, String(value)])
              )
            ).toString()
            const result = await osRequest<{ data?: unknown[] }>(`/subtitles?${query}`)
            return (result.data || []).map(normalizeSubtitleResult).filter((x) => x.fileId)
          }
          const rows = await search(params)
          // An id the catalog got wrong, or a show OpenSubtitles files
          // under another id, finds nothing; the title still might.
          const title = String(rawItem.title || '').trim()
          if (rows.length || params.query !== undefined || !title) return rows
          const byTitle: Record<string, string | number> = { ...params, query: title }
          delete byTitle.imdb_id
          delete byTitle.parent_imdb_id
          return search(byTitle)
        })()
      : Promise.resolve<SubtitleResult[]>([])
  ])

  const providers: Array<{
    name: string
    on: boolean
    outcome: PromiseSettledResult<SubtitleResult[]>
  }> = [
    { name: 'SubtitleDB', on: true, outcome: tsdbOutcome },
    { name: 'SubDL', on: subdlOn, outcome: subdlOutcome },
    { name: 'OpenSubtitles', on: osOn, outcome: osOutcome }
  ]
  for (const provider of providers) {
    if (provider.on && provider.outcome.status === 'rejected') {
      logError(`media-hub:subtitles:${provider.name.toLowerCase()}`, provider.outcome.reason)
    }
  }

  // Raised only when every provider that was asked failed — counting a
  // not-connected one's resolved [] as a success would mask the real
  // failure, and a bare "No results" in the menu while the actual reason
  // went only to logs/media-hub.log is exactly the dead end that made
  // "subtitles aren't loading" impossible to act on. Every asked
  // provider's reason is named, not the first one's.
  const asked = providers.filter((provider) => provider.on)
  const failures = asked.filter((provider) => provider.outcome.status === 'rejected')
  if (failures.length === asked.length) {
    if (failures.length === 1) throw (failures[0].outcome as PromiseRejectedResult).reason
    throw new Error(
      failures
        .map((provider) => {
          const reason = (provider.outcome as PromiseRejectedResult).reason
          return `${provider.name}: ${(reason as Error)?.message ?? reason}`
        })
        .join(' · ')
    )
  }

  return mergeSubtitleResults(
    providers.map((provider) =>
      provider.outcome.status === 'fulfilled' ? provider.outcome.value : []
    )
  )
}
