// Sending plan-to-watch OUT to the services.
//
// The pull side lives in watchlists.ts. This is the half that writes, and
// the half that can remove something from an account somebody else's
// software owns — so the rules it follows are written down first, in
// docs/WATCHLIST-SYNC.md, rather than inferred from this file.
//
// The two calls below are deliberately dumb: they add or remove ONE title
// on whichever services can hold it, report what happened per service,
// and decide nothing. Every question about whether a removal SHOULD
// propagate is answered in watchlists.ts against the origins record,
// where the history needed to answer it lives.

import { logError } from './logger'
import { malRequest, resolveMalIdForKitsu } from './malSync'
import { simklRequest } from './simklClient'
import { malCredentials, simklCredentials, traktCredentials } from './settingsStore'
import { traktRequest } from './traktClient'
import { traktIds, isTraktPushable } from './trakt'
import type { MediaKind } from '../../shared/media-hub/types'

export interface PushableTitle {
  id: string
  type: MediaKind
  title: string
  year?: string
}

/**
 * Simkl's add/remove pair.
 *
 * `to=plantowatch` is what makes an add a PLAN rather than a watch —
 * without it Simkl files the title under its default list, which for a
 * watchlist entry would mark something watched that nobody has seen.
 *
 * THE REMOVE PATH IS THE LEAST CERTAIN CALL IN THIS FILE. Simkl documents
 * removal from a list as /sync/history/remove — the same endpoint that
 * un-watches something — because a title's list membership and its
 * watched state are one record there rather than two. It is written that
 * way here, and it is the first thing to check if a removal silently does
 * nothing against a real account: the per-service push outcome will say
 * the request succeeded, because it will have.
 */
async function simklPlan(item: PushableTitle, add: boolean): Promise<void> {
  if (!simklCredentials().accessToken) return
  // Films and shows only. Anime reaches Simkl under ids this app does not
  // hold — see the pull side, which reads Simkl's anime through the id
  // bridge rather than pretending the two id spaces are one.
  if (item.type === 'anime') return
  const ids = /^tt\d+$/.test(item.id) ? { imdb: item.id } : null
  if (!ids) return
  const body =
    item.type === 'movie'
      ? { movies: [{ ids, to: add ? 'plantowatch' : undefined }] }
      : { shows: [{ ids, to: add ? 'plantowatch' : undefined }] }
  await simklRequest(add ? '/sync/add-to-list' : '/sync/history/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/** Trakt's watchlist add/remove. Anime is not pushable — see trakt.ts. */
async function traktPlan(item: PushableTitle, add: boolean): Promise<void> {
  if (!traktCredentials().accessToken) return
  if (!isTraktPushable(item)) return
  const ids = traktIds(item)
  if (!ids) return
  const body = item.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] }
  await traktRequest(add ? '/sync/watchlist' : '/sync/watchlist/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * MAL's plan_to_watch, which is a status on the anime's own list entry
 * rather than a separate collection.
 *
 * Removing therefore means DELETING the list entry — and that is why this
 * refuses to remove anything whose status is not still plan_to_watch. A
 * title somebody has since started watching has a real progress record on
 * MAL, and deleting the entry to satisfy a watchlist removal here would
 * throw away episode counts this app never owned.
 */
async function malPlan(item: PushableTitle, add: boolean): Promise<void> {
  if (!malCredentials().accessToken) return
  if (item.type !== 'anime') return
  const malId = await resolveMalIdForKitsu(item.id)
  if (!malId) return
  if (add) {
    await malRequest(`/anime/${malId}/my_list_status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'plan_to_watch' })
    })
    return
  }
  const current = await malRequest<{ my_list_status?: { status?: string } }>(
    `/anime/${malId}?fields=my_list_status`
  )
  if (current.my_list_status?.status !== 'plan_to_watch') return
  await malRequest(`/anime/${malId}/my_list_status`, { method: 'DELETE' })
}

export interface PushOutcome {
  simkl?: string
  trakt?: string
  mal?: string
}

/**
 * Puts a title on — or takes it off — every connected service that can
 * hold it.
 *
 * Errors are collected per service rather than thrown: one account being
 * unreachable is not a reason to skip the other two, and the caller needs
 * to know WHICH failed to decide whether to retry it.
 */
export async function pushPlanEverywhere(item: PushableTitle, add: boolean): Promise<PushOutcome> {
  const outcome: PushOutcome = {}
  const attempts: [keyof PushOutcome, Promise<void>][] = [
    ['simkl', simklPlan(item, add)],
    ['trakt', traktPlan(item, add)],
    ['mal', malPlan(item, add)]
  ]
  for (const [service, work] of attempts) {
    try {
      await work
    } catch (error) {
      outcome[service] = (error as Error).message
      logError(`watchlist:push:${service}`, error)
    }
  }
  return outcome
}
