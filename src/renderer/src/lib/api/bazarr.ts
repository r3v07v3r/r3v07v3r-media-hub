// Bazarr — subtitles for the files in your library.
//
// WHAT IT DOES IN THIS APP, PRECISELY, because it is easy to expect more.
// Bazarr works on files Sonarr and Radarr have put on disk: it finds
// subtitles for them and writes them beside the video. It cannot fetch
// subtitles for something this app is streaming from TorBox, because there
// is no library file for it to work on — its whole API is addressed by
// Sonarr/Radarr episode and movie ids.
//
// So its place in the pipeline is real but specific: when a title is played
// from the media-server source, the subtitles that come with it are the ones
// Bazarr fetched. For everything else, SubDL and OpenSubtitles are what
// this app searches directly, which is why all three sit in the same stage
// rather than one replacing the others.
//
// The integration is therefore status only, and deliberately so — a
// "download subtitles now" button here would either do nothing for a
// streamed title or duplicate what Bazarr already does on a schedule for a
// library one.

import type { ServiceConfig } from '@shared/ipc-types'
import { normalizeBaseUrl, type ConnectionTestResult } from './types'
import { proxyFetch } from './proxyFetch'

interface BazarrStatus {
  data?: {
    bazarr_version?: string
    sonarr_version?: string
    radarr_version?: string
  }
}

function headers(config: ServiceConfig): Record<string, string> {
  return config.apiKey ? { 'X-API-KEY': config.apiKey } : {}
}

export async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
  if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
  if (!config.apiKey.trim()) return { ok: false, message: 'API key is required' }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<BazarrStatus>({
    url: `${base}/api/system/status`,
    method: 'GET',
    // Bazarr spells the header in full caps, unlike the *arr family's
    // X-Api-Key. Sending the wrong one gets a 401 that reads like a bad key.
    headers: headers(config)
  })
  if (!res.ok) {
    return { ok: false, message: res.error ?? `Server responded with status ${res.status}` }
  }
  const version = res.data?.data?.bazarr_version
  return { ok: true, message: `Connected to Bazarr${version ? ` v${version}` : ''}` }
}
