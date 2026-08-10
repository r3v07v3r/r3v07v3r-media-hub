// Ported from r3v07v3r-media-hub's src/main.cjs — the TorBox API client
// (token()/torbox()/getJson()), account bootstrap (app:bootstrap,
// torbox:connect, torbox:disconnect), stream discovery/resolution
// (stream:resolve, backed by the Meteor P2P addon + TorBox's checkcached),
// playback kickoff (play:stream), and the TorBox "library" (mylist) view
// (library:list, library:play). Logic is preserved 1:1 (translated to
// TypeScript, not redesigned) — every error message, fallback path and
// field name below matches the original exactly.
//
// The original's single global `getJson` hardcoded a TorBox-specific side
// effect: `if (response.status===401 && String(url).startsWith(TORBOX))
// clearTorBoxToken()`. This port's httpClient.ts deliberately drops that
// coupling to stay a generic, dependency-free JSON fetcher shared by every
// backend domain (see that file's doc comment). `torboxFetch` below
// recreates the 401 behavior at this layer instead, wrapping httpClient's
// `fetchJson` for every TorBox-domain call in this file — both the ones
// that go through the `torbox()` helper and the ones (checkcached,
// createtorrent, requestdl) that hit the TorBox API directly with manual
// headers/FormData. The Meteor addon call in stream:resolve is not a
// TorBox URL, so it uses plain `fetchJson`, exactly as the original only
// special-cased TORBOX-prefixed URLs.

import type {
  BootstrapResult,
  LibraryItem,
  PlaybackResult,
  StreamCandidate,
  StreamResolveResult,
  TorBoxConnectResult
} from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { getDatabase } from './dbState'
import { fetchJson, type HttpError } from './httpClient'
import { handle } from './ipcGuard'
import { logError } from './logger'
import {
  cometConfigPath,
  enrichTorBoxItem,
  rankSafeStreams,
  selectVideoFile,
  titleMatchesRelease,
  validateTorBoxToken,
  type RawApiPayload,
  type TorBoxFile
} from './core'
import { sanitizeTrackers } from './security'
import { catalogData } from './catalog'
import { isAllowedRemoteMediaUrl } from './playback'
import { preparePlayback } from './playbackSession'
import {
  clearTorBoxToken,
  encrypt,
  getTorBoxToken,
  readSettings,
  writeSettings
} from './settingsStore'

export const TORBOX = 'https://api.torbox.app/v1/api'

/** Wraps httpClient's generic fetchJson with the TorBox-specific 401 side effect (clears the stored token and notifies the renderer) — see module doc comment. Use this, not fetchJson directly, for every TORBOX-prefixed request. */
async function torboxFetch<T = unknown>(url: string | URL, options?: RequestInit): Promise<T> {
  try {
    return await fetchJson<T>(url, options)
  } catch (error) {
    if ((error as HttpError).status === 401) {
      clearTorBoxToken()
    }
    throw error
  }
}

/** Authenticated GET against the TorBox API. Throws if TorBox isn't connected. */
async function torbox<T = unknown>(
  pathname: string,
  query: Record<string, unknown> = {}
): Promise<T> {
  const auth = getTorBoxToken()
  if (!auth) throw new Error('TorBox is not connected.')
  const url = new URL(TORBOX + pathname)
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined) url.searchParams.set(k, String(v))
  })
  return torboxFetch<T>(url, { headers: { Authorization: `Bearer ${auth}` } })
}

/** How long a resolved TorBox library entry stays usable without asking
 *  again. Its id and file list don't change once the torrent exists; the
 *  only thing that invalidates it is the person deleting it from their
 *  TorBox account, which the retry in play:stream recovers from. */
const TORBOX_ITEM_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The caller's TorBox library entry for one info-hash.
 *
 * `/torrents/mylist` has no by-hash query, so finding one torrent means
 * pulling up to a thousand of them and scanning — a request that sat in
 * the critical path of every single play and grew with the library. Since
 * that response describes every torrent, not just the wanted one, one
 * fetch is used to warm the whole set: a play, a second play of anything
 * else, and a resume all hit the cache.
 *
 * `force` skips the cache, for the one case that can go stale — see
 * play:stream's retry.
 */
async function torboxItemForHash(hash: string, force = false): Promise<RawApiPayload | null> {
  const db = getDatabase()
  const key = (h: string): string => `torbox:item:v1:${h}`
  if (!force) {
    const cached = db.getCache<RawApiPayload>(key(hash))
    if (cached) return cached
  }
  const existing = await torbox<RawApiPayload>('/torrents/mylist', { limit: 1000 })
  const list: RawApiPayload[] = Array.isArray(existing.data) ? existing.data : []
  let match: RawApiPayload | null = null
  for (const entry of list) {
    const entryHash = String(entry?.hash || '').toLowerCase()
    if (!entryHash) continue
    db.putCache(key(entryHash), entry, TORBOX_ITEM_TTL_MS)
    if (entryHash === hash) match = entry
  }
  return match
}

/** Queries one P2P scraper add-on and returns only its infoHash-bearing candidates. Best-effort: a failed/timed-out add-on shouldn't take the other one (or the whole resolve) down with it — see streamResolve's own comment on why two add-ons are queried at all. */
async function fetchAddonStreams(url: string): Promise<StreamCandidate[]> {
  try {
    const result = await fetchJson<{ streams?: StreamCandidate[] }>(url)
    return (result.streams || []).filter((s) => /^[a-f0-9]{40}$/i.test(s.infoHash || ''))
  } catch {
    return []
  }
}

/**
 * The best available free text naming what a stream candidate actually
 * is, for title-matching (see titleMatchesRelease). The two add-ons don't
 * agree on where this lives: Torrentio puts the real release/torrent name
 * as `.title`'s first line (`.name` is just "Torrentio\n1080p", useless for
 * this); Comet leaves `.title` undefined and puts it in `.description`
 * instead (`.name` is similarly just "[TORRENT] Comet 2160p" — confirmed
 * live comparing a real Comet-sourced candidate against a real
 * Torrentio-sourced one for the same search).
 */
function streamReleaseText(stream: StreamCandidate): string {
  const text = stream.title || (stream.description as string | undefined) || stream.name || ''
  return text.split('\n')[0]
}

/** First-seen-wins dedupe across multiple add-ons' results — the same real torrent is often indexed by more than one, and rankStreams should only ever see it once. */
function dedupeByInfoHash(streams: StreamCandidate[]): StreamCandidate[] {
  const seen = new Set<string>()
  const result: StreamCandidate[] = []
  for (const s of streams) {
    const hash = s.infoHash.toLowerCase()
    if (seen.has(hash)) continue
    seen.add(hash)
    result.push(s)
  }
  return result
}

interface StreamResolvePayload {
  type: string
  id: string
  /** The catalog title being searched for — optional (older callers/tests
   *  may omit it), in which case no title-based filtering happens at all.
   *  See titleMatchesRelease's own doc comment for what this guards
   *  against. */
  title?: string
}

interface PlayStreamPayload {
  stream: StreamCandidate
  mediaId?: string
}

/** Registers app:bootstrap, torbox:connect/disconnect, stream:resolve, play:stream, and library:list/play. */
export function registerTorBoxIpc(): void {
  handle<undefined, BootstrapResult>(MEDIA_HUB_CHANNELS.bootstrap, async () => {
    const configured = Boolean(getTorBoxToken())
    if (!configured) return { configured: false }
    try {
      const [user, library] = await Promise.all([
        torbox<RawApiPayload>('/user/me'),
        torbox<RawApiPayload>('/torrents/mylist', { limit: 100 })
      ])
      return { configured: true, user: user.data || {}, library: library.data || [] }
    } catch (error) {
      return { configured: false, error: (error as Error).message }
    }
  })

  handle<string, TorBoxConnectResult>(MEDIA_HUB_CHANNELS.torboxConnect, async (_e, raw) => {
    const value = String(raw || '').trim()
    if (!validateTorBoxToken(value)) {
      return { ok: false, message: 'Enter the API token shown in TorBox Settings.' }
    }
    try {
      const result = await torboxFetch<RawApiPayload>(`${TORBOX}/user/me`, {
        headers: { Authorization: `Bearer ${value}` }
      })
      const s = readSettings()
      s.torboxToken = encrypt(value)
      s.onboardingVersion = 2
      writeSettings(s)
      return { ok: true, user: result.data || {}, message: 'TorBox connected.' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  handle<undefined, { ok: true }>(MEDIA_HUB_CHANNELS.torboxDisconnect, () => {
    const s = readSettings()
    delete s.torboxToken
    writeSettings(s)
    return { ok: true }
  })

  handle<StreamResolvePayload, StreamResolveResult>(
    MEDIA_HUB_CHANNELS.streamResolve,
    async (_e, { type, id, title }) => {
      const auth = getTorBoxToken()
      if (!auth) throw new Error('TorBox is not connected.')
      const preferences = readSettings()
      const limits = {
        maxResolution: Number(preferences.maxStreamResolution) || 0,
        maxSizeGb: Number(preferences.maxStreamSizeGb) || 0
      }
      const key = `stream:v2:${type}:${id}:${limits.maxResolution}:${limits.maxSizeGb}`
      const db = getDatabase()
      try {
        // Two independent P2P scraper add-ons, queried in parallel and
        // merged — found live: Comet alone returned nothing for a
        // brand-new/low-profile anime that Torrentio (which scrapes
        // NyaaSi, the dedicated anime tracker) had real results for.
        // Each is best-effort on its own (a failure/timeout from one
        // shouldn't block whatever the other found) — see
        // fetchAddonStreams. Merged before the checkcached call below so
        // both sources get the same authoritative "is this actually
        // playable right now" check against the user's real TorBox
        // account, and so rankStreams picks the single best candidate
        // across both rather than preferring one source outright.
        //
        // meteorfortheweebs.midnightignite.me (the domain this originally
        // pointed to) now 301-redirects here — the "Meteor" add-on it ran
        // was retired in favor of "Comet", a different add-on with an
        // unrelated config schema (see cometConfigPath's own doc comment).
        const config = cometConfigPath()
        const [comet, torrentio] = await Promise.all([
          fetchAddonStreams(
            `https://cometfortheweebs.midnightignite.me/${config}/stream/${type}/${encodeURIComponent(id)}.json`
          ),
          fetchAddonStreams(
            `https://torrentio.strem.fun/stream/${type}/${encodeURIComponent(id)}.json`
          )
        ])
        const discoveredRaw = dedupeByInfoHash([...comet, ...torrentio])
        if (!discoveredRaw.length) return { streams: [], best: null }
        // Guards against a P2P scraper add-on's own "exact match" flag
        // being wrong for a franchise with several similarly-prefixed
        // entries (found live — see titleMatchesRelease's own doc
        // comment). Only ever narrows the pool, never replaces it with
        // nothing: a release-name shape this heuristic can't parse
        // cleanly falls back to the full unfiltered list rather than
        // turning a real, working result into a dead end.
        const titleFiltered = title
          ? discoveredRaw.filter((s) => titleMatchesRelease(streamReleaseText(s), title))
          : discoveredRaw
        const discovered = titleFiltered.length ? titleFiltered : discoveredRaw
        const hashes = [...new Set(discovered.map((s) => s.infoHash.toLowerCase()))].slice(0, 100)
        const cached = await torboxFetch<{
          data?: { hash?: string }[] | Record<string, unknown>
        }>(`${TORBOX}/torrents/checkcached?format=object&list_files=true`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes })
        })
        const available = new Set(
          Array.isArray(cached.data)
            ? cached.data.map((x) => String(x.hash || x).toLowerCase())
            : Object.keys(cached.data || {}).map((x) => x.toLowerCase())
        )
        const audioLanguage = preferences.audioLanguage || 'en'
        const streams = rankSafeStreams(
          discovered
            .filter((s) => available.has(s.infoHash.toLowerCase()))
            .map((s) => ({ ...s, cached: true, compatible: true })),
          audioLanguage,
          limits
        )
        if (streams.length) {
          const result: StreamResolveResult = { streams, best: streams[0] }
          db.putCache(key, result, 60 * 60 * 1000)
          return result
        }

        // Real torrents exist for this title, just none TorBox has cached
        // yet — rather than a dead end, submit the best one (ranked the
        // same way as a cached match, by exactness/resolution — see
        // rankStreams, whose scoring already treats `cached: false`
        // gracefully rather than excluding it) to actually start
        // downloading it, so this title becomes playable a few minutes
        // later instead of never. Same magnet-building
        // (infoHash + sanitizeTrackers) play:stream's own createtorrent
        // call already uses, just without its `add_only_if_cached: true`
        // flag — that flag is exactly what makes THIS submission a real
        // "start caching" request instead of a no-op. Best-effort: any
        // failure here (TorBox quota, network) just falls through to the
        // same honest "nothing available yet" result as before this
        // existed, rather than surfacing a harder error for what's meant
        // to be a fallback path.
        const candidate = rankSafeStreams(discovered, audioLanguage, limits)[0]
        let queued = false
        if (candidate) {
          try {
            const magnet = new URL('magnet:')
            magnet.searchParams.set('xt', `urn:btih:${candidate.infoHash.toLowerCase()}`)
            for (const tracker of sanitizeTrackers(candidate.sources)) {
              magnet.searchParams.append('tr', tracker)
            }
            const form = new FormData()
            form.append('magnet', magnet.toString())
            await torboxFetch(`${TORBOX}/torrents/createtorrent`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${auth}` },
              body: form
            })
            queued = true
          } catch {
            // Best-effort, see comment above.
          }
        }
        const result: StreamResolveResult = { streams: [], best: null, queued }
        // Cached briefly either way (a much shorter window than a real
        // cache hit's hour) — a queued request shouldn't get resubmitted
        // to TorBox on every repeat click while it's still working
        // through the download, and there's no reason to re-hit the
        // Meteor addon every click for a title with genuinely nothing
        // available either.
        db.putCache(key, result, 3 * 60 * 1000)
        return result
      } catch (error) {
        const stale = db.getCache<StreamResolveResult>(key, { allowExpired: true })
        if (stale) return stale
        throw error
      }
    }
  )

  handle<PlayStreamPayload, PlaybackResult>(
    MEDIA_HUB_CHANNELS.playStream,
    async (_e, { stream, mediaId }) => {
      const auth = getTorBoxToken()
      const hash = String(stream?.infoHash || '').toLowerCase()
      if (!/^[a-f0-9]{40}$/.test(hash)) {
        throw new Error('The selected source has no valid torrent hash.')
      }
      // Wrapped so the whole lookup can be repeated once against a fresh
      // listing: a cached library entry describes a torrent that existed a
      // moment ago, and the one thing that invalidates it — the person
      // deleting it from their TorBox account — only shows up as a failure
      // at requestdl. Only that second attempt pays the full-library fetch.
      const resolveDownloadUrl = async (force: boolean): Promise<string> => {
        let item = await torboxItemForHash(hash, force)
        if (!item) {
          const magnet = new URL('magnet:')
          magnet.searchParams.set('xt', `urn:btih:${hash}`)
          for (const tracker of sanitizeTrackers(stream.sources)) {
            magnet.searchParams.append('tr', tracker)
          }
          const form = new FormData()
          form.append('magnet', magnet.toString())
          form.append('add_only_if_cached', 'true')
          const created = await torboxFetch<{ data?: { torrent_id?: unknown } }>(
            `${TORBOX}/torrents/createtorrent`,
            { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: form }
          )
          const torrentId = created.data?.torrent_id
          const fetched = await torbox<RawApiPayload>('/torrents/mylist', {
            id: torrentId,
            bypass_cache: true
          })
          item = Array.isArray(fetched.data) ? fetched.data[0] : fetched.data
        }
        if (!item) throw new Error('TorBox could not prepare the cached torrent.')
        const parts = String(mediaId || '').split(':')
        const episode = Number(parts.at(-1))
        const season = Number(parts.at(-2))
        const episodic = parts.length >= 3 && Number.isFinite(season) && Number.isFinite(episode)
        const files = (item.files || []) as TorBoxFile[]
        // Prefer the scraper add-on's own fileIdx (Torrentio provides it,
        // Comet doesn't — see StreamCandidate.fileIdx's own doc comment)
        // over selectVideoFile's filename-regex guessing, but only when it
        // actually resolves to a real video file in TorBox's own listing —
        // found live: on a large batch torrent (e.g. a "Complete Series"
        // pack), the regex guess can miss entirely even though the add-on
        // already told us exactly which file. Falls back to the regex guess
        // whenever the index doesn't line up, rather than trusting it
        // blindly (TorBox's own file ordering isn't guaranteed to match the
        // add-on's).
        const videoExt = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i
        const hintedIdx = Number(stream?.fileIdx)
        const hinted =
          Number.isInteger(hintedIdx) &&
          hintedIdx >= 0 &&
          files[hintedIdx] &&
          videoExt.test(files[hintedIdx].name || files[hintedIdx].short_name || '')
            ? files[hintedIdx]
            : null
        const file =
          hinted ||
          selectVideoFile(files, episodic ? season : undefined, episodic ? episode : undefined)
        if (!file) throw new Error('No matching video file was found in the TorBox torrent.')
        const result = await torboxFetch<{
          data?: string | { url?: string; download_url?: string }
        }>(
          `${TORBOX}/torrents/requestdl?token=${encodeURIComponent(auth)}&torrent_id=${encodeURIComponent(item.id)}&file_id=${encodeURIComponent(String(file.id))}&redirect=false`
        )
        const url =
          typeof result.data === 'string'
            ? result.data
            : result.data?.url || result.data?.download_url
        if (!url) throw new Error('TorBox did not return a playable URL.')
        // TorBox occasionally hands back a link for a torrent that's
        // reported cached but isn't actually servable yet (found live: a
        // freshly-completed download returning a non-HTTPS/malformed URL
        // on the first requestdl right after checkcached said it was
        // ready) — preparePlayback's own playbackProxy would reject this
        // exact same URL downstream anyway, just several stages later and
        // with a confusing raw error. Failing here instead means it's
        // caught by the retry-once wrapper below, in the same click.
        if (!isAllowedRemoteMediaUrl(url)) {
          throw new Error('TorBox returned a link that was not ready yet.')
        }
        return url
      }

      let url: string
      try {
        url = await resolveDownloadUrl(false)
      } catch (error) {
        logError('torbox:play:retry', error)
        url = await resolveDownloadUrl(true)
      }
      return preparePlayback(url)
    }
  )

  handle<undefined, LibraryItem[]>(MEDIA_HUB_CHANNELS.libraryList, async () => {
    const [result, catalogs] = await Promise.all([
      torbox<RawApiPayload>('/torrents/mylist', { limit: 100, bypass_cache: false }),
      Promise.all(
        (['movie', 'series', 'anime'] as const).map((kind) => catalogData(kind).catch(() => []))
      )
    ])
    const raw: RawApiPayload[] = Array.isArray(result.data) ? result.data : []
    return raw.map((item) => enrichTorBoxItem(item, catalogs.flat()))
  })

  handle<RawApiPayload, PlaybackResult>(MEDIA_HUB_CHANNELS.libraryPlay, async (_e, item) => {
    const auth = getTorBoxToken()
    const files = (item.files || item.file_list || []) as TorBoxFile[]
    const file = selectVideoFile(files)
    if (!file) throw new Error('No matching video file was found in this TorBox item.')
    const torrentId = item.id || item.torrent_id
    if (!torrentId) throw new Error('TorBox item has no torrent ID.')
    const fileId = file.id || file.file_id
    const result = await torboxFetch<{ data?: string | { url?: string; download_url?: string } }>(
      `${TORBOX}/torrents/requestdl?token=${encodeURIComponent(auth)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(String(fileId))}&redirect=false`
    )
    const url =
      typeof result.data === 'string' ? result.data : result.data?.url || result.data?.download_url
    if (!url) throw new Error('TorBox did not return a playable URL.')
    return preparePlayback(url)
  })
}
