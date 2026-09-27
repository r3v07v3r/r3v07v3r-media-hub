// Which near copy answers a resolve, and in what order — the tiers that
// need no credentials, alone in a module with no Electron or network in
// reach so tests can hold it down. The same split deepScanRules and
// watchlistRules use, for the same reason: stream:resolve once refused
// for want of a source BEFORE looking at either tier, and nothing could
// pin the order while it lived inside the handler.

import type { StreamCandidate, StreamResolveResult } from '../../shared/media-hub/types'
import type { LocalCacheCandidate } from './streamCache'
import { resumeCandidateFor } from './core'

/** What stream:resolve says when a title is held nowhere near and there is
 *  no source to fetch it from. Thrown only after both cache tiers have
 *  missed — see answerFromCacheTiers. */
export const NO_PLAYBACK_SOURCE_MESSAGE =
  "This title isn't on this computer or a paired cache server. Connect TorBox or a media server in Settings to play it."

/** Which sources are configured right now. */
export interface ResolveSources {
  torbox: boolean
  mediaServer: boolean
  lanCache: boolean
}

/** The lookups the tiers are answered from, handed in so the order can be
 *  tested without a disk, a database or a daemon behind them. */
export interface CacheTierLookups {
  local: () => Promise<LocalCacheCandidate | null>
  recent: () => StreamResolveResult | null
  lan: () => Promise<StreamCandidate | null>
  rankLan: (candidate: StreamCandidate) => StreamCandidate[]
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
export function withinQualityCeiling(
  resolution: number | undefined,
  ceiling: number | undefined
): boolean {
  if (!ceiling) return true
  if (!resolution) return true
  return resolution <= ceiling
}

/**
 * The answers stream:resolve can give before any source is searched: this
 * disk, the hour-cached answer, the paired cache server — in that order.
 *
 * Returns null when none of them has the title. Only then does having no
 * source become an error: the first and last of these need no credentials,
 * so a title held complete plays with TorBox disconnected and no media
 * server at all.
 *
 * `remember` says whether the caller should cache the answer for the hour.
 */
export async function answerFromCacheTiers(
  sources: ResolveSources,
  maxResolution: number,
  lookups: CacheTierLookups
): Promise<{ result: StreamResolveResult; remember: boolean } | null> {
  // TIER 1 — already on this machine.
  //
  // Ahead of the resolve cache below deliberately. That cache holds
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
  // Without this, a partial session was dead weight: the search could
  // return a different encode of the same title, whose length differs,
  // so adoption was refused and the bytes already downloaded were
  // re-downloaded from scratch.
  //
  // Subject to the quality ceiling like every other tier: a cached 4K
  // copy does not win when the person capped at 1080p.
  const cached = await lookups.local()
  if (cached && withinQualityCeiling(cached.resolution, maxResolution)) {
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
      return { result: { streams: [candidate], best: candidate }, remember: true }
    }

    const resume = resumeCandidateFor(cached, sources.torbox, sources.mediaServer)
    if (resume) {
      // Deliberately NOT remembered: this is a resume of a download still
      // in flight, and once it finishes the complete branch above should
      // take over on the next play rather than a stale hour-old row
      // sending us back to the source.
      return { result: { streams: [resume], best: resume }, remember: false }
    }
  }

  // Fast path 1: an identical resolve (same title/episode, same
  // quality/size limits) already ran within the last hour.
  //
  // Read only while a source that could have produced it is still
  // configured. The key carries no trace of the TorBox token, so an
  // answer cached before a disconnect would otherwise be served for up
  // to an hour and then fail in play:stream with "TorBox is not
  // connected."
  if (sources.torbox || sources.mediaServer) {
    const recent = lookups.recent()
    if (recent) return { result: recent, remember: false }
  }

  // TIER 2 — the on-site cache daemon. Same footing as the media server:
  // one LAN round-trip, quality-gated, best-effort. Only COMPLETE items
  // produce a candidate (the daemon 404s partials on /stream), so a hit
  // here is playable this second.
  if (sources.lanCache) {
    const lan = await lookups.lan()
    if (lan && withinQualityCeiling(lan.resolution, maxResolution)) {
      const ranked = lookups.rankLan(lan)
      if (ranked.length) {
        return { result: { streams: ranked, best: ranked[0] }, remember: true }
      }
    }
  }

  return null
}
