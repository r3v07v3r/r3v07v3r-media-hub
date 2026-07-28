/** For a series/anime item, `mediaId` needs a `:<season>:<episode>` suffix
 *  (see main/media-hub/torbox.ts's play:stream, which parses it back out to
 *  pick the matching file within the torrent). Defaults to S1E1 when a
 *  specific episode wasn't set (e.g. opening the title fresh rather than
 *  resuming). Shared between AppStateContext (which now resolves/starts
 *  playback itself, see startPlayback) and PlaybackOverlay (which still
 *  needs it to restart a compatibility-mode transcode from a new seek
 *  position with the same media identity). */
export function buildMediaId(
  kind: 'movie' | 'series' | 'anime',
  id: string,
  seasonNumber?: number,
  episodeNumber?: number
): string {
  if (kind === 'movie') return id
  const season = seasonNumber ?? 1
  const episode = episodeNumber ?? 1
  return `${id}:${season}:${episode}`
}
