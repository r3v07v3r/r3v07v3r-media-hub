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
  expected: ReadonlySet<number> | undefined,
  blocked: boolean
): SeasonBubble {
  const numbers = new Set(held.filter((ep) => ep.season === season).map((ep) => ep.episode))
  const watched = numbers.size
  const last = Math.max(0, ...numbers)
  const total = expected?.size ?? 0
  // Done means every listed episode is held, by number: ten held out of
  // ten listed is not it when the ten are E2–E11 (a service's own
  // numbering, or a list that has since moved).
  const done = total > 0 && [...expected!].every((episode) => numbers.has(episode))
  const state: SeasonBubble['state'] = watched === 0 ? 'none' : done ? 'done' : 'part'
  return { season, watched, last, total, state, blocked }
}

/** The episode numbers each season has, as the title's metadata lists them. */
export type SeasonEpisodes = ReadonlyMap<number, ReadonlySet<number>>

/**
 * The sides of one row. `listed` is the episodes per season as the title's
 * metadata lists them, when the panel has them; a season not in it, or not
 * yet loaded, gets no green. Specials (season 0) are left out: the
 * comparison never looks at them.
 */
export function showSyncSides(
  row: Pick<ShowSyncRow, 'held' | 'services'>,
  listed: SeasonEpisodes = new Map()
): ShowSyncSide[] {
  const held = (row.held ?? []).filter((ep) => ep.season > 0)
  const services = (Object.keys(row.services) as EpisodeSyncService[]).filter(
    (service) => row.services[service]
  )
  const seasons = new Set<number>(listed.keys())
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
      seasons: ordered.map((season) => bubble(season, local, listed.get(season), false))
    }
  ]
  for (const service of services) {
    const part = row.services[service]!
    const theirs = without(held, [...part.sent, ...part.unsendable])
    const blocked = new Set(part.blockedSeasons)
    sides.push({
      key: service,
      seasons: ordered.map((season) =>
        bubble(season, theirs, listed.get(season), blocked.has(season))
      )
    })
  }
  return sides
}

/** The episode numbers per season from a title's episode list, specials
 *  left out. */
export function seasonEpisodes(
  videos:
    readonly { season?: number | null; episode?: number | null; unplayable?: boolean }[] | undefined
): Map<number, Set<number>> {
  const listed = new Map<number, Set<number>>()
  for (const video of videos ?? []) {
    if (video.unplayable) continue
    const season = Number(video.season)
    const episode = Number(video.episode)
    if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode)) continue
    const numbers = listed.get(season) ?? new Set<number>()
    numbers.add(episode)
    listed.set(season, numbers)
  }
  return listed
}
