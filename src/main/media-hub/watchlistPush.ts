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
import { mayRemoveAt, type PlannedSource } from './watchlistRules'
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
 * THE REMOVE PATH IS THE DESTRUCTIVE ONE, which is why it is gated
 * before it ever gets here — see mayRemoveAt in watchlistRules. Simkl
 * documents removal from a list as /sync/history/remove, the same
 * endpoint that un-watches something, because a title's list membership
 * and its watched state are one record there rather than two. Sent for a
 * title that is NOT on the Simkl watchlist it does not fail harmlessly:
 * it erases whatever watch history that account had for the title.
 *
 * It is still the least certain call in this file. If a removal silently
 * does nothing against a real account, this is the first thing to check —
 * the outcome will say the request succeeded, because it will have.
 */
async function simklPlan(item: PushableTitle, add: boolean): Promise<boolean> {
  if (!simklCredentials().accessToken) return false
  // Films and shows only. Anime reaches Simkl under ids this app does not
  // hold — see the pull side, which reads Simkl's anime through the id
  // bridge rather than pretending the two id spaces are one.
  if (item.type === 'anime') return false
  const ids = /^tt\d+$/.test(item.id) ? { imdb: item.id } : null
  if (!ids) return false
  const body =
    item.type === 'movie'
      ? { movies: [{ ids, to: add ? 'plantowatch' : undefined }] }
      : { shows: [{ ids, to: add ? 'plantowatch' : undefined }] }
  await simklRequest(add ? '/sync/add-to-list' : '/sync/history/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return true
}

/** Trakt's watchlist add/remove. Anime is not pushable — see trakt.ts. */
async function traktPlan(item: PushableTitle, add: boolean): Promise<boolean> {
  if (!traktCredentials().accessToken) return false
  if (!isTraktPushable(item)) return false
  const ids = traktIds(item)
  if (!ids) return false
  const body = item.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] }
  await traktRequest(add ? '/sync/watchlist' : '/sync/watchlist/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return true
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
async function malPlan(item: PushableTitle, add: boolean): Promise<boolean> {
  if (!malCredentials().accessToken) return false
  if (item.type !== 'anime') return false
  const malId = await resolveMalIdForKitsu(item.id)
  if (!malId) return false
  if (add) {
    await malRequest(`/anime/${malId}/my_list_status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ status: 'plan_to_watch' })
    })
    return true
  }
  const current = await malRequest<{ my_list_status?: { status?: string } }>(
    `/anime/${malId}?fields=my_list_status`
  )
  if (current.my_list_status?.status !== 'plan_to_watch') return false
  await malRequest(`/anime/${malId}/my_list_status`, { method: 'DELETE' })
  return true
}

/**
 * What happened at one service.
 *
 * `skipped` and `sent` are kept apart because the caller queues failed
 * removals for retry, and a service that was never asked to do anything
 * must not join that queue — a Simkl removal held back for want of
 * evidence is a decision, not a failure to be retried later.
 */
export type PushResult = { state: 'skipped' | 'sent' } | { state: 'failed'; error: string }

export type PushOutcome = Record<PlannedSource, PushResult>

export interface PushOptions {
  /** The services this app's last pull found holding the title. Used only
   *  to gate removals whose endpoint is not scoped to the watchlist —
   *  today that is Simkl and only Simkl. */
  onServices?: readonly PlannedSource[]
  /** Narrows the push to these services. The retry of a half-failed
   *  removal uses it so the services that already succeeded are not asked
   *  a second time — harmless at all three, but a retry that re-sends
   *  everything makes the outcome say less than it should. */
  only?: readonly PlannedSource[]
}

/** The first error message in an outcome, for a log line or a stored
 *  note. One is enough: the services that failed are listed separately,
 *  and three stacked messages in one string help nobody read it. */
export function firstFailure(outcome: PushOutcome): string | undefined {
  for (const service of Object.keys(outcome) as PlannedSource[]) {
    const result = outcome[service]
    if (result.state === 'failed') return result.error
  }
  return undefined
}

/** Which services failed, for the caller deciding what to retry. */
export function failedServices(outcome: PushOutcome): PlannedSource[] {
  return (Object.keys(outcome) as PlannedSource[]).filter(
    (service) => outcome[service].state === 'failed'
  )
}

/**
 * Puts a title on — or takes it off — every connected service that can
 * hold it.
 *
 * Errors are collected per service rather than thrown: one account being
 * unreachable is not a reason to skip the other two, and the caller needs
 * to know WHICH failed to decide whether to retry it.
 */
export async function pushPlanEverywhere(
  item: PushableTitle,
  add: boolean,
  options: PushOptions = {}
): Promise<PushOutcome> {
  const known = options.onServices ?? []
  const outcome: PushOutcome = {
    simkl: { state: 'skipped' },
    trakt: { state: 'skipped' },
    mal: { state: 'skipped' }
  }
  const runners: [PlannedSource, () => Promise<boolean>][] = [
    ['simkl', () => simklPlan(item, add)],
    ['trakt', () => traktPlan(item, add)],
    ['mal', () => malPlan(item, add)]
  ].filter(([service]) => !options.only || options.only.includes(service as PlannedSource)) as [
    PlannedSource,
    () => Promise<boolean>
  ][]
  // Each one catches its own, so a rejection never escapes to become an
  // unhandled one while a sibling is still in flight.
  await Promise.all(
    runners.map(async ([service, run]) => {
      // One choke point for the destructive direction: a removal reaches
      // a service only if that service's removal is scoped to the
      // watchlist, or this app has evidence the title is on it.
      if (!add && !mayRemoveAt(service, known)) return
      try {
        if (await run()) outcome[service] = { state: 'sent' }
      } catch (error) {
        outcome[service] = { state: 'failed', error: (error as Error).message || String(error) }
        logError(`watchlist:push:${service}`, error)
      }
    })
  )
  return outcome
}
