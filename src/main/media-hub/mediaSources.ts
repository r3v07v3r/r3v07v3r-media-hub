// The seam between "what can play this" and "where the credentials live".
//
// jellyfin.ts is deliberately free of any electron import so its parsing
// and URL building stay unit-testable; this module is the counterpart that
// does the impure half — reading the saved server config and deciding
// whether the media server is usable at all. torbox.ts talks to this, not
// to jellyfin.ts directly.
//
// Note the settings split it papers over: the media server's URL and key
// live in the `r3-settings` electron-store (src/main/ipc/settings.ts),
// while TorBox's token lives in media-hub's own settingsStore.ts. Reading
// across is intentional — migrating credentials between the two stores
// risks the legacy-plaintext data-loss bug settings.ts documents at length.

import { getServiceConfig } from '../ipc/settings'
import {
  buildStreamUrl,
  findEpisode,
  findMovie,
  isJellyfinConfigured,
  jellyfinCandidate,
  parseMediaId,
  type JellyfinConfig
} from './jellyfin'
import type { StreamCandidate } from '../../shared/media-hub/types'

/** The configured media server, or undefined when there isn't a usable
 *  one. `enabled` is part of the test: unticking it in Settings must take
 *  the server out of playback immediately, the same way it revokes the
 *  host from playback's trusted-host allowlist. */
export function mediaServerConfig(): JellyfinConfig | undefined {
  const service = getServiceConfig('jellyfin')
  if (!service.enabled) return undefined
  const config = { baseUrl: service.baseUrl, apiKey: service.apiKey }
  return isJellyfinConfigured(config) ? config : undefined
}

export function isMediaServerConnected(): boolean {
  return Boolean(mediaServerConfig())
}

/**
 * Looks the title up on the media server and returns it as a candidate
 * that can be ranked against torrent results, or null.
 *
 * Best-effort by contract: the server being asleep, unreachable or
 * mid-upgrade must degrade to "TorBox only", never to a playback error.
 * That is what makes the media server a cache tier rather than a
 * dependency.
 */
export async function findMediaServerCandidate(
  id: string,
  /** The title's names — see titleMatchesRelease; the first is the search term. */
  title: string | readonly string[] | undefined
): Promise<StreamCandidate | null> {
  const config = mediaServerConfig()
  if (!config) return null

  try {
    const parsed = parseMediaId(id)
    // Anime ids are Kitsu ids, which a Jellyfin library indexes under a
    // different provider entirely — the id-based lookup would always miss,
    // so those fall through to the title search inside findMovie /
    // findEpisode. Only a real IMDb id is worth passing.
    const providerId = /^tt\d+$/.test(parsed.imdbId) ? parsed.imdbId : ''

    // The id's shape decides what to ask for, and the two-segment form is
    // ambiguous: `tt123:2` never occurs, but anime is addressed as
    // `kitsuId:episode` with NO season segment (see startPlayback's own
    // anime special-case). Reading that second segment as a season would
    // look an episode up as a film and miss every time. A Jellyfin anime
    // library files those under season 1, which is the useful guess.
    const isAnimeEpisode =
      !providerId && parsed.season !== undefined && parsed.episode === undefined
    const season = isAnimeEpisode ? 1 : parsed.season
    const episode = isAnimeEpisode ? parsed.season : parsed.episode

    const item =
      season !== undefined && episode !== undefined
        ? await findEpisode(config, providerId, title ?? '', season, episode)
        : await findMovie(config, providerId, title ?? '')

    return item ? jellyfinCandidate(item) : null
  } catch {
    // See the doc comment — an unavailable server is a missing
    // optimisation, not a failure.
    return null
  }
}

/** The URL to hand the player for a media-server candidate. Null when the
 *  candidate isn't one, or the server has since been turned off. */
export function mediaServerStreamUrl(candidate: StreamCandidate): string | null {
  if (candidate.source !== 'mediaserver' || !candidate.itemId || !candidate.mediaSourceId) {
    return null
  }
  const config = mediaServerConfig()
  if (!config) return null
  return buildStreamUrl(config, candidate.itemId, candidate.mediaSourceId)
}
