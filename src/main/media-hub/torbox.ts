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
  CacheSessionMeta,
  CacheSourceRef,
  BootstrapResult,
  PlaybackResult,
  PlaybackRelease,
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
  rankSafeStreams,
  releaseGroup,
  resumeCandidateFor,
  streamResolution,
  streamSizeGb,
  selectVideoFile,
  titleMatchesRelease,
  validateTorBoxToken,
  type RawApiPayload,
  type SourcePreference,
  type TorBoxFile,
  guardedForPrefetch
} from './core'
import { sanitizeTrackers } from './security'
import { isAllowedRemoteMediaUrl } from './playback'
import { jellyfinFingerprint } from './jellyfin'
import { findLocalCacheCandidate } from './streamCache'
import { findMediaServerCandidate, mediaServerConfig, mediaServerStreamUrl } from './mediaSources'
import {
  findLanCacheCandidate,
  isLanCacheConnected,
  lanCacheFingerprint,
  lanCacheStreamUrl
} from './lanCache'
import { preparePlayback } from './playbackSession'
import { reportPreparation } from './playbackProgress'
import {
  clearTorBoxToken,
  encrypt,
  getTorBoxToken,
  readSettings,
  writeSettings
} from './settingsStore'
import { streamReleaseName } from '../../shared/media-hub/streamQuality'
import { knownTitles } from './titleNames'

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
  // A forced lookup exists to recover from a stale answer, and TorBox keeps
  // one of its own: without bypass_cache the retry re-asked a question the
  // server could answer from the same cached body the first attempt got —
  // one click, two identical failures two seconds apart, which is what a
  // person's log showed for a torrent whose file list had not landed yet.
  const existing = await torbox<RawApiPayload>('/torrents/mylist', {
    limit: 1000,
    ...(force ? { bypass_cache: true } : {})
  })
  const list: RawApiPayload[] = Array.isArray(existing.data) ? existing.data : []
  let match: RawApiPayload | null = null
  const rows: Array<{ key: string; payload: RawApiPayload }> = []
  for (const entry of list) {
    const entryHash = String(entry?.hash || '').toLowerCase()
    if (!entryHash) continue
    if (entryHash === hash) match = entry
    // Only an entry that already carries its file list is worth keeping for
    // six hours. A torrent still being added arrives in the listing before
    // its files do, and warming that shell as if it were final turned every
    // play of it for the rest of the TTL into "no matching video file".
    if (!Array.isArray(entry?.files) || entry.files.length === 0) continue
    rows.push({ key: key(entryHash), payload: entry })
  }
  // One transaction for the whole warm. This sits on the play click, the
  // database is synchronous on the main thread, and a large library was up
  // to a thousand individually-committed multi-KB rows in a loop with no
  // await — a solid main-thread block at the exact moment playback start
  // needs the event loop responsive.
  db.putCacheBatch(rows, TORBOX_ITEM_TTL_MS)
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
  // One rule, shared with the ranking's release-group comparison — see
  // streamReleaseName for why they must not drift apart.
  return streamReleaseName(stream)
}

/**
 * Whether a copy from a nearer tier is usable, given the person's ceiling.
 *
 * `maxResolution` is a MAXIMUM. The Settings row is "Maximum video quality —
 * avoid releases sharper than this display needs", and the speed test writes
 * it as `min(what the line can carry, what the screen can show)`. So the only
 * question a near tier has to answer is whether its copy is within it.
 *
 * THIS USED TO READ `resolution >= target`, treating the ceiling as a floor,
 * and the damage grew with the setting: at "4K" the local-cache tier could
 * only fire for a 2160p copy, so a 1080p file already on this disk was passed
 * over and re-downloaded from TorBox. At "1080p" a 720p copy on the LAN cache
 * was skipped the same way. Only "Any" behaved correctly, because 0 skips the
 * check — every explicit choice made it worse, which is the signature of an
 * inverted comparison rather than a tuning problem.
 *
 * The intent behind the old rule was real — do not settle for a poor copy
 * when something better exists — but it cannot be expressed with a ceiling,
 * and there is no separate "preferred quality" setting to express it with.
 * The trade is now made deliberately and told to the person instead of being
 * enforced silently: a copy already on this machine or on the LAN is played,
 * and `belowCeiling` on the result says when what they got is a full tier or
 * more below what they allowed, so the renderer can ask before playing it.
 *
 * An unknown resolution is accepted rather than discarded — refusing to play
 * a copy we hold because its metadata is thin would be worse than playing it.
 */
function withinQualityCeiling(
  resolution: number | undefined,
  ceiling: number | undefined
): boolean {
  if (!ceiling) return true
  if (!resolution) return true
  return resolution <= ceiling
}

/** The cache-session identity for a resolve request, in exactly the shape
 *  play:stream writes. Returns undefined when the caller did not supply
 *  one, which disables the local tier rather than guessing wrong. */
function cacheMetaFor(
  payload: StreamResolvePayload,
  title: string | undefined
): CacheSessionMeta | undefined {
  const key = payload.cacheKey
  if (!key?.catalogId) return undefined
  return {
    title: title ?? '',
    catalogId: key.catalogId,
    seasonNumber: key.seasonNumber,
    episodeNumber: key.episodeNumber
  }
}

/** The two P2P scraper add-ons, queried in parallel and merged — one
 *  seam shared by the resolve handler and the pre-fetch feeder so the two
 *  can never drift on where candidates come from. See the resolve
 *  handler's comment for why both add-ons and why best-effort each. */
async function fetchDiscoveredRaw(type: string, id: string): Promise<StreamCandidate[]> {
  const config = cometConfigPath()
  const [comet, torrentio] = await Promise.all([
    fetchAddonStreams(
      `https://cometfortheweebs.midnightignite.me/${config}/stream/${type}/${encodeURIComponent(id)}.json`
    ),
    fetchAddonStreams(`https://torrentio.strem.fun/stream/${type}/${encodeURIComponent(id)}.json`)
  ])
  return dedupeByInfoHash([...comet, ...torrentio])
}

/**
 * The best release to PRE-FETCH for a title — the feeder's half of the
 * hybrid model. Deliberately no checkcached call: TorBox having it cached
 * already is not a requirement for the daemon (submitting the torrent so
 * TorBox starts fetching it is precisely the daemon's job), and the
 * ranking's `cached` term is meaningless for work scheduled for tonight.
 * Same title guard, same safety filter, same person's limits as live
 * resolution.
 */
export async function discoverBestPrefetchCandidate(
  type: string,
  id: string,
  title: string | undefined
): Promise<StreamCandidate | null> {
  const preferences = readSettings()
  const limits = {
    maxResolution: Number(preferences.maxStreamResolution) || 0,
    maxSizeGb: Number(preferences.maxStreamSizeGb) || 0
  }
  const discoveredRaw = await fetchDiscoveredRaw(type, id)
  if (!discoveredRaw.length) return null
  // The same guard as live resolution, with the same names: the feeder
  // only has a tracked row's title, and for an anime that is the English
  // one while its releases are named in romaji — a guard that matched
  // nothing fell back to the whole unguarded result set, and an add-on's
  // wrong "exact" match could have the daemon fetch a related title.
  const titles = knownTitles(type, showKey(type, id), [title])
  // No fallback to the unguarded set here, unlike live resolution: a
  // person at the stream picker can see a wrong match and choose again,
  // but nobody is watching the daemon fetch tonight's file. A name that
  // matches none of the title's known names is a title this app cannot
  // vouch for, and "no prefetch" is the right answer for it.
  const discovered = guardedForPrefetch(discoveredRaw, titles)
  if (!discovered.length) return null
  return (
    rankSafeStreams(
      discovered,
      preferences.audioLanguage || 'en',
      limits,
      resolveSourcePreference(preferences.sourcePreference)
    )[0] ?? null
  )
}

/** Narrows a persisted settings value to a known preference. An unknown
 *  or absent value means the default, never a crash — settings files
 *  outlive the code that wrote them. */
function resolveSourcePreference(value: unknown): SourcePreference {
  return value === 'prefer-local' || value === 'prefer-quality' || value === 'balanced'
    ? value
    : 'balanced'
}

/** The candidate's torrent hash, lowercased, or '' when it has none.
 *  StreamCandidate.infoHash became optional when media-server candidates
 *  joined the same shape — every use below is on a torrent-only path, so
 *  this narrows once rather than at six call sites. */
function torrentHash(stream: StreamCandidate): string {
  return stream.infoHash?.toLowerCase() ?? ''
}

/** First-seen-wins dedupe across multiple add-ons' results — the same real torrent is often indexed by more than one, and rankStreams should only ever see it once. */
function dedupeByInfoHash(streams: StreamCandidate[]): StreamCandidate[] {
  const seen = new Set<string>()
  const result: StreamCandidate[] = []
  for (const s of streams) {
    const hash = torrentHash(s)
    // A candidate with no hash cannot be a scraper result; drop it rather
    // than letting one collapse every other hashless entry onto ''.
    if (!hash || seen.has(hash)) continue
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
  /** Other names the same title is released under — an anime's romaji
   *  name beside its English one. Every one of them is accepted by the
   *  title guard; see titleMatchesRelease. */
  altTitles?: string[]
  /** The identity play:stream will store on the cache session. Supplied so
   *  the local-cache tier compares like with like instead of guessing it
   *  from `id` — see the preload comment on resolve(). Optional: without
   *  it the local tier simply does not fire. */
  cacheKey?: { catalogId?: string; seasonNumber?: number; episodeNumber?: number }
}

interface PlayStreamPayload {
  stream: StreamCandidate
  mediaId?: string
  /** Same `type`/`id` stream:resolve was called with — NOT always equal to
   *  `mediaId` (anime's resolveId omits the season segment mediaId always
   *  has, see streamId.ts's own comment). Threaded through separately so
   *  play:stream can remember "the stream that actually worked" under the
   *  exact key stream:resolve will look it up by next time — see
   *  LAST_STREAM_TTL_MS's own comment for why. */
  type?: string
  resolveId?: string
  /** Renderer-supplied metadata for the stream-cache manifest (see
   *  streamCache.ts's meta.json) — the Downloads page's "Cached Streams"
   *  list reads this back. `catalogId` is the bare, routable catalog id;
   *  distinct from `mediaId` above, which is the composite
   *  `imdbId:season:episode` key used for stream resolution. All optional:
   *  a play:stream call that omits them just means this session won't show
   *  up with a title/poster in that list. */
  catalogId?: string
  title?: string
  posterUrl?: string
  season?: number
  episode?: number
  /** The episode's own name — carried through to the player session so
   *  the overlay's badge and title line can show it. */
  episodeTitle?: string
}

/** How long play:stream's "last stream that actually worked for this
 *  title/episode" memory lives — see stream:resolve's own fast-path
 *  comment for what reads it. Long enough to matter for a real resume days
 *  later (the whole point), safe to be this generous because it's always
 *  re-verified live with a single-hash checkcached before ever being
 *  trusted, never assumed still good. */
const LAST_STREAM_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * The show an episode id belongs to, for memory that should span episodes.
 * An anime resolve id is `<kitsu id>:<episode>` (two segments); a series
 * one is `<imdb>:<season>:<episode>` (three); a movie's is itself.
 */
function showKey(type: string, id: string): string {
  if (type === 'movie') return String(id)
  const parts = String(id).split(':')
  // A show id is one segment ("tt123", a bare Kitsu number) or a prefixed
  // pair ("simkl:123", "kitsu:555"); whatever follows is coordinates —
  // however many, since a series position with no season is "id:episode".
  const prefixed = parts.length > 1 && /^[a-z]+$/i.test(parts[0]) && /^\d+$/.test(parts[1])
  return prefixed ? parts.slice(0, 2).join(':') : parts[0]
}

/** Which release group last played an episode of this show — read back by
 *  the ranking so the next episode prefers the same group, which is what
 *  keeps its audio and look consistent across a season. */
function releaseGroupMemoKey(type: string, id: string): string {
  return `groupmemo:v1:${type}:${showKey(type, id)}`
}

/** Remembers the release that actually played, under both the episode and
 *  the show. */
function rememberPlayedStream(type: string, resolveId: string, stream: StreamCandidate): void {
  const db = getDatabase()
  db.putCache(lastStreamKey(type, resolveId), stream, LAST_STREAM_TTL_MS)
  const group = releaseGroup(streamReleaseText(stream))
  if (group) db.putCache(releaseGroupMemoKey(type, resolveId), group, LAST_STREAM_TTL_MS)
}

/** The release as the Info panel shows it — see PlaybackRelease. */
function releaseFacts(stream: StreamCandidate): PlaybackRelease {
  return {
    name: (streamReleaseText(stream) || stream.name || '').split('\n')[0].trim(),
    resolution: streamResolution(stream) || undefined,
    sizeGb: streamSizeGb(stream) ?? undefined,
    source: stream.source ?? 'torbox',
    infoHash: stream.infoHash
  }
}

function lastStreamKey(type: string, id: string): string {
  return `laststream:v1:${type}:${id}`
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
    async (_e, payload) => {
      const { type, id, title, altTitles } = payload
      // Every name the title goes by, for the guards below: what the
      // renderer sent, plus what the cached record knows (an index-backed
      // card carries no originalTitle, and a romaji-named release must
      // still pass the guard). Empty means no title guard at all, exactly
      // as an absent `title` always has.
      const titles = knownTitles(type, showKey(type, id), [
        title,
        ...(Array.isArray(altTitles) ? altTitles : [])
      ])
      const auth = getTorBoxToken()
      const mediaServer = mediaServerConfig()
      // Either source alone is a complete configuration. Only having
      // neither is an error, and it names both so the message is
      // actionable for whichever one the person meant to set up.
      if (!auth && !mediaServer) {
        throw new Error('Connect TorBox or a media server to start playback.')
      }
      const preferences = readSettings()
      const limits = {
        maxResolution: Number(preferences.maxStreamResolution) || 0,
        maxSizeGb: Number(preferences.maxStreamSizeGb) || 0
      }
      const sourcePreference = resolveSourcePreference(preferences.sourcePreference)
      // v2 -> v3: the answer now depends on the source preference and on
      // which server is configured, so both join the key. Without them a
      // person who switches preference, or points at a different server,
      // keeps being served the previous answer for an hour.
      const key =
        `stream:v4:${type}:${id}:${limits.maxResolution}:${limits.maxSizeGb}` +
        `:${sourcePreference}:${jellyfinFingerprint(mediaServer)}:${lanCacheFingerprint()}`
      const db = getDatabase()
      const audioLanguage = preferences.audioLanguage || 'en'
      // The group that played the previous episode of this show, if any —
      // see SAME_RELEASE_GROUP_BONUS in core.ts.
      const preferredGroup = getDatabase().getCache<string>(releaseGroupMemoKey(type, id)) ?? null

      // Fast path 1: an identical resolve (same title/episode, same
      // quality/size limits) already ran within the last hour. The answer
      // was already being cached below — it just was never actually READ
      // here, only ever pulled as a last-resort fallback when the fresh
      // search below threw. That's the actual reason replaying or resuming
      // something just watched re-ran the full two-addon search plus a
      // TorBox checkcached call every single time, instead of reusing an
      // answer that hadn't changed.
      // TIER 1 — already on this machine.
      //
      // Ahead of the resolve cache above deliberately. That cache holds
      // "which source to use" for an hour, so a title finished downloading
      // five minutes ago would still route back through TorBox to mint a
      // link and read a length, purely to end up adopting bytes already on
      // this disk. Nothing that plays offline should need a round trip to
      // learn that.
      //
      // Answered from the filesystem alone: no source contacted, no network
      // touched. Two distinct outcomes, and the partial one is the reason
      // sessions record where their bytes came from:
      //
      //  COMPLETE  play it straight from disk, offline.
      //  PARTIAL   re-request THE SAME RELEASE from the source it was
      //            originally pulled from, so the half we already hold is
      //            resumed rather than abandoned. Handing back a candidate
      //            for the original source (not a localcache one) is what
      //            makes that work: play mints a link for that exact
      //            release, and streamCache.start's own findReusableSession
      //            then adopts the existing chunks, because the release
      //            matching means its totalBytes check passes.
      //
      // Without this, a partial session was dead weight: the search below
      // could return a different encode of the same title, whose length
      // differs, so adoption was refused and the bytes already downloaded
      // were re-downloaded from scratch.
      //
      // Subject to the quality target like every other tier: a cached 720p
      // copy does not win when 1080p was asked for.
      const cached = await findLocalCacheCandidate(cacheMetaFor(payload, title))
      if (cached && withinQualityCeiling(cached.resolution, limits.maxResolution)) {
        if (cached.complete) {
          const candidate: StreamCandidate = {
            source: 'localcache',
            cacheToken: cached.token,
            complete: true,
            name: cached.title,
            resolution: cached.resolution,
            cached: true,
            compatible: true,
            exact: true
          }
          const result: StreamResolveResult = { streams: [candidate], best: candidate }
          db.putCache(key, result, 60 * 60 * 1000)
          return result
        }

        const resume = resumeCandidateFor(cached, Boolean(auth), Boolean(mediaServer))
        if (resume) {
          // Deliberately NOT cached under `key`: this is a resume of a
          // download still in flight, and once it finishes the complete
          // branch above should take over on the next play rather than a
          // stale hour-old row sending us back to the source.
          return { streams: [resume], best: resume }
        }
      }

      // The group memo is not part of the key, on purpose: it changes
      // whenever another episode of the show plays from a different group,
      // and keying on it would throw away a search that is still right. A
      // cached answer was RANKED without it, though, so a replay or a
      // previously resolved episode never saw the same-group bonus.
      // Re-ranking is a sort, not a search — every cached answer served
      // from here (the hour-fresh one below, and the expired one the catch
      // at the end falls back to) goes through this instead.
      const withGroupMemo = (result: StreamResolveResult): StreamResolveResult => {
        if (!preferredGroup || result.streams.length < 2) return result
        const reranked = rankSafeStreams(result.streams, audioLanguage, limits, sourcePreference, {
          preferredGroup
        })
        return reranked.length ? { ...result, streams: reranked, best: reranked[0] } : result
      }

      const recent = db.getCache<StreamResolveResult>(key)
      if (recent) return withGroupMemo(recent)

      // TIER 2 — the on-site cache daemon. Same footing as the media
      // server below: one LAN round-trip, quality-gated, best-effort. Only
      // COMPLETE items produce a candidate (the daemon 404s partials on
      // /stream), so a hit here is playable this second.
      if (isLanCacheConnected()) {
        const meta = cacheMetaFor(payload, title)
        const lanKey = meta
          ? `${String(meta.catalogId).trim().toLowerCase()}:${meta.seasonNumber ?? ''}:${meta.episodeNumber ?? ''}`
          : ''
        const lan = await findLanCacheCandidate(lanKey)
        if (lan && withinQualityCeiling(lan.resolution, limits.maxResolution)) {
          const ranked = rankSafeStreams([lan], audioLanguage, limits, sourcePreference)
          if (ranked.length) {
            const result: StreamResolveResult = { streams: ranked, best: ranked[0] }
            db.putCache(key, result, 60 * 60 * 1000)
            return result
          }
        }
      }

      // Asked BEFORE the remembered-stream path below, not after.
      //
      // `laststream` records where a title played FROM last time, with a
      // 14-day life and no knowledge of the source. Consulting it first
      // meant that for any title played via TorBox in the last fortnight,
      // a newly connected media server was never asked at all — the whole
      // feature silently did nothing until those entries aged out.
      // Confirmed live: 29 live movie/series entries, every one TorBox,
      // and not a single stream:v3 row ever written.
      //
      // The server is one LAN request and usually answers in milliseconds,
      // so giving it first refusal costs nothing when it does not have the
      // title, and the remembered TorBox stream is still right there
      // underneath when it does not.
      const localLookup = findMediaServerCandidate(id, titles)

      // A local copy that already satisfies the person's quality ceiling
      // ends the search here — no checkcached round-trip, no add-on calls,
      // and no remembered-stream lookup. This is the slow-connection
      // payoff: resolution drops from seconds to a single LAN request.
      //
      // prefer-quality opts out by definition: that setting means "look at
      // everything and pick the best", so short-circuiting on the first
      // acceptable local copy would silently ignore a better remote one.
      if (sourcePreference !== 'prefer-quality') {
        const local = await localLookup
        const acceptable =
          local && rankSafeStreams([local], audioLanguage, limits, sourcePreference)
        if (acceptable?.length) {
          const result: StreamResolveResult = { streams: acceptable, best: acceptable[0] }
          db.putCache(key, result, 60 * 60 * 1000)
          return result
        }
      }

      // Fast path 2: the stream that actually played last time for this
      // exact title/episode — regardless of how long ago, up to
      // LAST_STREAM_TTL_MS — re-verified with a single-hash checkcached
      // (cheap: one TorBox call, no P2P add-ons at all) rather than trusted
      // blindly, since TorBox's cache or the person's own quality/size
      // limits can both have moved on since. This is the "remember where
      // it played from last and try that first" path.
      const remembered = db.getCache<StreamCandidate>(lastStreamKey(type, id))
      const rememberedUsable =
        remembered &&
        rankSafeStreams([remembered], audioLanguage, limits, sourcePreference).length > 0 &&
        // A remembered stream from a source that is no longer configured
        // must not be replayed — the token or the server has gone.
        (remembered.source === 'mediaserver'
          ? Boolean(mediaServer)
          : remembered.source === 'lancache'
            ? isLanCacheConnected()
            : Boolean(auth))
      if (remembered && rememberedUsable) {
        try {
          const rememberedHash = torrentHash(remembered)
          // A remembered media-server stream has no TorBox hash to verify.
          // Its availability check is the play:stream request itself, which
          // is one cheap LAN round-trip and fails over to a full search
          // anyway — so re-verifying here would cost a round-trip to
          // establish something we learn for free a moment later.
          const stillCached = !rememberedHash
            ? remembered.source === 'mediaserver'
            : await (async () => {
                const verified = await torboxFetch<{
                  data?: { hash?: string }[] | Record<string, unknown>
                }>(`${TORBOX}/torrents/checkcached?format=object&list_files=true`, {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${auth}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ hashes: [rememberedHash] })
                })
                return Array.isArray(verified.data)
                  ? verified.data.some((x) => String(x.hash || x).toLowerCase() === rememberedHash)
                  : Object.keys(verified.data || {}).some((h) => h.toLowerCase() === rememberedHash)
              })()
          if (stillCached) {
            const result: StreamResolveResult = { streams: [remembered], best: remembered }
            db.putCache(key, result, 60 * 60 * 1000)
            return result
          }
        } catch {
          // Best-effort — falls through to the full search below exactly
          // like every other TorBox call in this handler.
        }
      }

      try {
        // No TorBox token: the media server was the only source available,
        // and it did not have this title. An honest dead end rather than
        // an error — the renderer distinguishes it from `queued`.
        if (!auth) {
          const result: StreamResolveResult = { streams: [], best: null }
          db.putCache(key, result, 3 * 60 * 1000)
          return result
        }

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
        const discoveredRaw = await fetchDiscoveredRaw(type, id)
        // Awaited a second time rather than threaded down from the
        // short-circuit above: awaiting a settled promise is free, and it
        // keeps the add-on calls from ever queueing behind the media
        // server on the prefer-quality path, which skips that block.
        const local = await localLookup
        if (!discoveredRaw.length) {
          // The scrapers found nothing, but the server may still have it —
          // this is the prefer-quality path, where the short-circuit above
          // deliberately did not run.
          const localOnly = local
            ? rankSafeStreams([local], audioLanguage, limits, sourcePreference)
            : []
          const result: StreamResolveResult = {
            streams: localOnly,
            best: localOnly[0] ?? null
          }
          if (localOnly.length) db.putCache(key, result, 60 * 60 * 1000)
          return result
        }
        // Guards against a P2P scraper add-on's own "exact match" flag
        // being wrong for a franchise with several similarly-prefixed
        // entries (found live — see titleMatchesRelease's own doc
        // comment). Only ever narrows the pool, never replaces it with
        // nothing: a release-name shape this heuristic can't parse
        // cleanly falls back to the full unfiltered list rather than
        // turning a real, working result into a dead end.
        const titleFiltered = titles.length
          ? discoveredRaw.filter((s) => titleMatchesRelease(streamReleaseText(s), titles))
          : discoveredRaw
        const discovered = titleFiltered.length ? titleFiltered : discoveredRaw
        const hashes = [...new Set(discovered.map(torrentHash))].slice(0, 100)
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
        // One ranking pass over both sources. On the prefer-quality path
        // this is where the local copy finally competes; on the others it
        // is a no-op, because an acceptable local copy already returned
        // above.
        const streams = rankSafeStreams(
          [
            ...discovered
              .filter((s) => available.has(torrentHash(s)))
              .map((s) => ({ ...s, cached: true, compatible: true })),
            ...(local ? [local] : [])
          ],
          audioLanguage,
          limits,
          sourcePreference,
          { preferredGroup }
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
        const candidate = rankSafeStreams(discovered, audioLanguage, limits, sourcePreference, {
          preferredGroup
        })[0]
        let queued = false
        if (candidate) {
          try {
            const magnet = new URL('magnet:')
            magnet.searchParams.set('xt', `urn:btih:${torrentHash(candidate)}`)
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
        if (stale) return withGroupMemo(stale)
        throw error
      }
    }
  )

  handle<PlayStreamPayload, PlaybackResult>(
    MEDIA_HUB_CHANNELS.playStream,
    async (
      _e,
      {
        stream,
        mediaId,
        type,
        resolveId,
        catalogId,
        title,
        posterUrl,
        season,
        episode,
        episodeTitle
      }
    ) => {
      // Both sources converge here: whatever produced the URL, playback
      // opens it the same way and the same stream gets remembered. Shared
      // as a closure rather than duplicated so the two branches can never
      // drift on cache metadata or the last-stream memo.
      // Recorded on the session so tier 1 can tell later WHICH encode these
      // bytes are. Without it a partial session cannot be safely resumed —
      // resuming against a different release of the same title splices two
      // files together and plays corrupt video.
      const sourceRef: CacheSourceRef = {
        source: stream?.source ?? 'torbox',
        infoHash: stream?.infoHash,
        itemId: stream?.itemId,
        mediaSourceId: stream?.mediaSourceId,
        // The two things a resume needs that the hash alone does not carry:
        // WHICH file of a multi-file torrent these bytes are (the add-on's
        // index, preferred over filename guessing — see resolveDownloadUrl),
        // and the trackers to re-add the torrent with if TorBox has since
        // let it go. Without them a resumed season pack could pick a
        // different episode's file, or fail to find any.
        fileIdx: stream?.fileIdx,
        sources: stream?.sources
      }

      const finish = async (url: string): Promise<PlaybackResult> => {
        const result = await preparePlayback(
          url,
          title
            ? {
                title,
                posterUrl,
                catalogId,
                mediaKind: type as 'movie' | 'series' | 'anime' | undefined,
                seasonNumber: season,
                episodeNumber: episode,
                episodeTitle,
                sourceRef,
                // streamResolution, not stream.resolution: the scrapers
                // mostly leave that field unset and put the real quality in
                // the release text, so reading the raw field stores
                // undefined for nearly every TorBox copy.
                resolution: stream ? streamResolution(stream) || undefined : undefined,
                release: stream ? releaseFacts(stream) : undefined
              }
            : undefined
        )
        // Only remembered once playback actually started — see
        // stream:resolve's own "fast path 2" comment for where this gets
        // read back. Records the stream that was ACTUALLY used, which
        // isn't always stream:resolve's own top pick (a manual choice
        // from the stream picker lands here too).
        if (type && resolveId) rememberPlayedStream(type, resolveId, stream)
        return result
      }

      // Tier 1's own tail. Same memo and metadata handling as `finish`,
      // but preparePlayback opens the existing session instead of a link.
      const finishLocal = async (cacheToken: string): Promise<PlaybackResult> => {
        const result = await preparePlayback(
          '',
          title
            ? {
                title,
                posterUrl,
                catalogId,
                mediaKind: type as 'movie' | 'series' | 'anime' | undefined,
                seasonNumber: season,
                episodeNumber: episode,
                episodeTitle
              }
            : undefined,
          cacheToken
        )
        if (type && resolveId) rememberPlayedStream(type, resolveId, stream)
        return result
      }

      // Tier 1: the bytes are already on this disk. No URL to build, no
      // source to contact — hand the cache session straight to the player.
      if (stream?.source === 'localcache' && stream.complete && stream.cacheToken) {
        reportPreparation('buffer', 'Playing from this computer')
        return finishLocal(String(stream.cacheToken))
      }

      // Tier 2: the cache daemon already fetched the file; its /stream URL
      // is one LAN hop away and the trusted-host allowlist (populated at
      // pairing) is what lets mpv open it.
      if (stream?.source === 'lancache') {
        const lanUrl = lanCacheStreamUrl(stream)
        if (!lanUrl) {
          throw new Error('That cache server is no longer paired. Reconnect it in Settings.')
        }
        reportPreparation('link', 'Opening the file on your cache server')
        return finish(lanUrl)
      }

      // The media server needs none of the TorBox machinery below — no
      // torrent to find, nothing to submit, no link to mint. The file is
      // already there; build its URL and open it.
      if (stream?.source === 'mediaserver') {
        const mediaUrl = mediaServerStreamUrl(stream)
        if (!mediaUrl) {
          throw new Error('That media server is no longer connected. Reconnect it in Settings.')
        }
        reportPreparation('link', 'Opening the file on your media server')
        return finish(mediaUrl)
      }

      const auth = getTorBoxToken()
      if (!auth) throw new Error('TorBox is not connected.')
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
        // ready) — preparePlayback's own streamCache.start() would reject
        // this exact same URL downstream anyway, just several stages later
        // and with a confusing raw error. Failing here instead means it's
        // caught by the retry-once wrapper below, in the same click.
        if (!isAllowedRemoteMediaUrl(url)) {
          throw new Error('TorBox returned a link that was not ready yet.')
        }
        return url
      }

      let url: string
      try {
        reportPreparation('link', 'Asking TorBox for a playable link')
        url = await resolveDownloadUrl(false)
      } catch (error) {
        logError('torbox:play:retry', error)
        reportPreparation('link', "That link wasn't ready — asking TorBox again")
        url = await resolveDownloadUrl(true)
      }
      return finish(url)
    }
  )
}
