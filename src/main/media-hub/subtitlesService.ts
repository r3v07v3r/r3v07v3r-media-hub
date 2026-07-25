// Ported from r3v07v3r-media-hub's src/main.cjs (osUserAgent/osLoginWith/
// osRequest/osDownloadSubtitleText, and the os:connect/os:disconnect/
// subtitles:search IPC handlers). OpenSubtitles credentials/token live in
// the shared media-hub settings file (see settingsStore.ts) exactly as in
// the original — this module only adds the request/auth-retry logic on top.
//
// TODO(media-hub-integration): the `r3v07v3r-media-hub v${app.getVersion()}`
// User-Agent string below is copied verbatim from the original app. Left
// as-is rather than rebranded to this project's name, since it's unclear
// whether OpenSubtitles ties API access/rate-limits to this string in a way
// that's enforced server-side — changing it is a functional risk for zero
// user-visible benefit. Revisit if that's confirmed safe.

import { app } from 'electron'

import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import type { ConnectResult, SubtitleResult } from '../../shared/media-hub/types'
import { fetchJson, type HttpError } from './httpClient'
import { handle } from './ipcGuard'
import {
  buildSearchParams,
  normalizeSubtitleResult,
  type OpenSubtitlesSearchItem,
  type OpenSubtitlesSearchPlayback
} from './opensubtitles'
import { encrypt, osCredentials, readSettings, writeSettings } from './settingsStore'

const OS_API = 'https://api.opensubtitles.com/api/v1'

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

/** Downloads and returns the raw SRT text for an OpenSubtitles file id. Used by playbackSession.ts's subtitles:apply handler. */
export async function osDownloadSubtitleText(fileId: number): Promise<string> {
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

interface OsConnectPayload {
  apiKey?: string
  username?: string
  password?: string
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

  handle<SubtitlesSearchPayload | undefined, SubtitleResult[]>(
    MEDIA_HUB_CHANNELS.subtitlesSearch,
    async (_event, payload) => {
      const language = readSettings().subtitleLanguage || 'en'
      const params = buildSearchParams(payload?.item || {}, { ...payload?.playback, language })
      const query = new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
      ).toString()
      const result = await osRequest<{ data?: unknown[] }>(`/subtitles?${query}`)
      return (result.data || [])
        .map(normalizeSubtitleResult)
        .filter((x) => x.fileId)
        .slice(0, 20)
    }
  )
}
