// The daemon's own thin TorBox client: exactly the three calls needed to
// turn a job's torrent identity into a fresh, fetchable download link.
//
// Deliberately NOT an import of the app's torbox.ts — that module is wired
// into Electron (settings store, IPC, playback session) and is the one
// file the daemon must never drag in. What IS shared is everything that
// matters for correctness: fetchJson + the 'torbox' scheduler lane
// (httpClient/taskScheduler, dependency-free by design) and
// selectVideoFile from core.ts, so the daemon picks the same file out of a
// season pack the app would.

import { fetchJson } from '../src/main/media-hub/httpClient'
import { selectVideoFile, type TorBoxFile } from '../src/main/media-hub/core'

const TORBOX = 'https://api.torbox.app/v1/api'

interface RawTorrent {
  id?: unknown
  hash?: string
  files?: TorBoxFile[]
}

export interface ResolvedDownload {
  url: string
  fileName: string
  sizeBytes: number
}

function magnetFor(infoHash: string, sources: string[] = []): string {
  const magnet = new URL('magnet:')
  magnet.searchParams.set('xt', `urn:btih:${infoHash.toLowerCase()}`)
  // Trackers were sanitized app-side before the job was queued; the daemon
  // just carries them.
  for (const tracker of sources.slice(0, 20)) magnet.searchParams.append('tr', tracker)
  return magnet.toString()
}

async function torboxGet<T>(
  token: string,
  pathname: string,
  query: Record<string, string>
): Promise<T> {
  const url = new URL(`${TORBOX}${pathname}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return fetchJson<T>(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    // Background tier on purpose: nothing here is a person waiting on a
    // spinner, and the lane budget is shared with any running app.
    { lane: 'torbox', priority: 'background', label: 'torbox (r3-cache)' }
  )
}

/**
 * Ensures the torrent exists in the TorBox account and mints a download
 * link for its video file.
 *
 * `add_only_if_cached` is NOT set — this is the pre-fetcher, and telling
 * TorBox to start downloading an uncached torrent is the job. A torrent
 * TorBox is still ingesting simply has no files yet; the caller treats
 * that as retry-later, not failure.
 */
export async function resolveDownload(
  token: string,
  infoHash: string,
  options: { fileIdx?: number; sources?: string[]; season?: number; episode?: number }
): Promise<ResolvedDownload | null> {
  const form = new FormData()
  form.append('magnet', magnetFor(infoHash, options.sources))
  const created = await fetchJson<{ data?: { torrent_id?: unknown } }>(
    `${TORBOX}/torrents/createtorrent`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    { lane: 'torbox', priority: 'background', label: 'torbox (r3-cache)' }
  )
  const torrentId = created.data?.torrent_id
  if (torrentId === undefined || torrentId === null) return null

  const fetched = await torboxGet<{ data?: RawTorrent | RawTorrent[] }>(token, '/torrents/mylist', {
    id: String(torrentId),
    bypass_cache: 'true'
  })
  const item = Array.isArray(fetched.data) ? fetched.data[0] : fetched.data
  const files = item?.files ?? []
  if (!files.length) return null // still ingesting — retry later

  // Same preference order as the app's play path: the scraper's fileIdx
  // when it maps to a real video file, selectVideoFile's guess otherwise.
  const video = /\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i
  let file: TorBoxFile | null = null
  if (options.fileIdx !== undefined && files[options.fileIdx]) {
    const byIdx = files[options.fileIdx]
    if (video.test(byIdx.name || byIdx.short_name || '')) file = byIdx
  }
  if (!file) file = selectVideoFile(files, options.season ?? null, options.episode ?? null)
  if (!file) return null

  const fileId = file.id ?? file.file_id
  const link = await torboxGet<{ data?: string | { url?: string; download_url?: string } }>(
    token,
    '/torrents/requestdl',
    {
      token,
      torrent_id: String(torrentId),
      file_id: String(fileId ?? ''),
      redirect: 'false'
    }
  )
  const url =
    typeof link.data === 'string' ? link.data : (link.data?.url ?? link.data?.download_url)
  if (!url) return null

  const rawName = file.short_name || file.name || `${infoHash}.mkv`
  return {
    url,
    // The torrent's path separator must not survive into a file name.
    fileName: rawName.split(/[\\/]/).pop() || `${infoHash}.mkv`,
    sizeBytes: Number(file.size) || 0
  }
}
