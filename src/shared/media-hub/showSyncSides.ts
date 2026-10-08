// The Sync review panel's picture of one show: a line per side (here, then
// each service the row has a part for), and on each line a bubble per
// season saying how far that side had got on its own.
//
// The automatic step has already merged the sides, so what the row holds
// is the union (`held`) and the per-service record of what moved
// (`arrived`, `sent`, `unsendable`). Each side's OWN set before the merge is
// worked back from those:
//
//  - here:    held minus everything that arrived from any service;
//  - service: held minus what was sent to it and what cannot be sent to it.
//
// Those are exactly the sets the panel's choices restore ("Use" on a side
// makes every other side match it), so a bubble shows what pressing the
// button beside it would leave everywhere.

import type { EpisodeSyncService, ShowSyncRow, SyncEpisode } from './types'

export type ShowSyncSideKey = 'local' | EpisodeSyncService

/** How far one side had got in one season. */
export interface SeasonBubble {
  season: number
  /** Episodes of the season this side held. */
  watched: number
  /** The highest episode number it held, for the "E12" label. */
  last: number
  /** Episodes the season has, when known (0 when it is not). */
  total: number
  /** `done` when every known episode is held, `part` when some are, `none`
   *  when none are. Without a total, anything held is `part`. */
  state: 'done' | 'part' | 'none'
  /** True on a service line whose season nothing can be sent to: the
   *  service stays as it is there whatever is chosen. */
  blocked: boolean
}

export interface ShowSyncSide {
  key: ShowSyncSideKey
  seasons: SeasonBubble[]
}

function keyOf(ep: SyncEpisode): string {
  return `${ep.season}:${ep.episode}`
}

function without(all: readonly SyncEpisode[], gone: readonly SyncEpisode[]): SyncEpisode[] {
  const skip = new Set(gone.map(keyOf))
  return all.filter((ep) => !skip.has(keyOf(ep)))
}

function bubble(
  season: number,
  held: readonly SyncEpisode[],
  total: number,
  blocked: boolean
): SeasonBubble {
  const mine = held.filter((ep) => ep.season === season)
  const watched = new Set(mine.map((ep) => ep.episode)).size
  const last = mine.reduce((max, ep) => Math.max(max, ep.episode), 0)
  const state: SeasonBubble['state'] =
    watched === 0 ? 'none' : total > 0 && watched >= total ? 'done' : 'part'
  return { season, watched, last, total, state, blocked }
}

/**
 * The sides of one row. `totals` is episodes per season as the title's
 * metadata lists them, when the panel has them; a season not in it, or not
 * yet loaded, gets no green. Specials (season 0) are left out: the
 * comparison never looks at them.
 */
export function showSyncSides(
  row: Pick<ShowSyncRow, 'held' | 'services'>,
  totals: ReadonlyMap<number, number> = new Map()
): ShowSyncSide[] {
  const held = (row.held ?? []).filter((ep) => ep.season > 0)
  const services = (Object.keys(row.services) as EpisodeSyncService[]).filter(
    (service) => row.services[service]
  )
  const seasons = new Set<number>(totals.keys())
  for (const ep of held) seasons.add(ep.season)
  for (const service of services) {
    for (const season of row.services[service]!.blockedSeasons) seasons.add(season)
  }
  seasons.delete(0)
  const ordered = [...seasons].sort((a, b) => a - b)

  const arrivedAnywhere = services.flatMap((service) => row.services[service]!.arrived)
  const local = without(held, arrivedAnywhere)
  const sides: ShowSyncSide[] = [
    {
      key: 'local',
      seasons: ordered.map((season) => bubble(season, local, totals.get(season) ?? 0, false))
    }
  ]
  for (const service of services) {
    const part = row.services[service]!
    const theirs = without(held, [...part.sent, ...part.unsendable])
    const blocked = new Set(part.blockedSeasons)
    sides.push({
      key: service,
      seasons: ordered.map((season) =>
        bubble(season, theirs, totals.get(season) ?? 0, blocked.has(season))
      )
    })
  }
  return sides
}

/** Episodes per season from a title's episode list, specials left out. */
export function seasonTotals(
  videos: readonly { season?: number | null; unplayable?: boolean }[] | undefined
): Map<number, number> {
  const totals = new Map<number, number>()
  for (const video of videos ?? []) {
    if (video.unplayable) continue
    const season = Number(video.season)
    if (!Number.isFinite(season) || season <= 0) continue
    totals.set(season, (totals.get(season) ?? 0) + 1)
  }
  return totals
}
