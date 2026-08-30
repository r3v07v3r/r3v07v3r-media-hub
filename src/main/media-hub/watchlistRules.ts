// The one decision in two-way watchlist sync that can destroy data.
//
// Its own module, with no imports that reach a database or a network, so
// it can be tested directly. Everything else in this feature is fetching
// and writing; this is the judgement, and the judgement is what would
// quietly delete somebody's list if it were wrong.
//
// The rules it implements are docs/WATCHLIST-SYNC.md — read that for why
// each one exists rather than inferring the intent from the code.

export type PlannedSource = 'simkl' | 'trakt' | 'mal'

export interface PlannedOrigin {
  source: PlannedSource
  addedAt: number
  /** WHICH account it came from, as settingsStore's mark for the
   *  connection that was live when the pull ran. A record that says only
   *  "Trakt" is not enough to justify a deletion: authorize a different
   *  Trakt account and its snapshot would be read as evidence that the
   *  first account's title had been removed. Optional only because
   *  records written before this existed are on disk — and those are
   *  treated as unattributable, which is the safe direction. */
  account?: string
}

export interface RemovalInput {
  /** Ids currently on the local planned list. */
  tracked: string[]
  /** Where each pulled title came from — written only when a PULL added
   *  it, never when somebody planned one here. Its absence is the proof
   *  that protects a locally-added title. */
  origins: Record<string, PlannedOrigin>
  /** Which services hold each title, as this pull just found them. */
  sources: Record<string, PlannedSource[]>
  /** Services that answered successfully this pass. A service that
   *  errored is not evidence of anything. */
  answered: ReadonlySet<PlannedSource>
  /** The account mark currently connected for each service. An origin
   *  stamped with anything else was written under a different login, and
   *  this pull's snapshot says nothing about it. Empty string is "not
   *  connected" and must match no stamp at all. */
  accounts: Readonly<Record<PlannedSource, string>>
}

/**
 * Services whose "remove from the watchlist" call is NOT scoped to the
 * watchlist.
 *
 * Simkl is the one. Its documented removal is /sync/history/remove — the
 * same endpoint that un-watches something — because a title's list
 * membership and its watched state are one record there rather than two.
 * Sent for a title that is not on the watchlist, it does not fail
 * harmlessly: it erases whatever watch history the account had.
 *
 * Trakt's and MAL's are scoped (a watchlist endpoint, and a status on a
 * list entry that MAL's push checks first), so removing something absent
 * is a no-op at both.
 *
 * A fourth service added here later is the thing most likely to get this
 * wrong, which is why the list lives beside the rule that reads it rather
 * than as a condition inside one service's request builder.
 */
const UNSCOPED_REMOVALS: readonly PlannedSource[] = ['simkl']

/**
 * Whether a removal may be sent to this service.
 *
 * `known` is the services this app's last pull actually found holding the
 * title. For a scoped removal it does not matter — the call cannot touch
 * anything else. For an unscoped one it is the whole safety condition: no
 * evidence, no request. The cost of being wrong that way is a stale row
 * left on somebody's list, which they can delete; the cost of being wrong
 * the other way is history nobody can get back.
 */
export function mayRemoveAt(service: PlannedSource, known: readonly PlannedSource[]): boolean {
  if (!UNSCOPED_REMOVALS.includes(service)) return true
  return known.includes(service)
}

/**
 * Which locally-planned titles should be un-planned because they have
 * left the service they came from.
 *
 * Five conditions, all required, and each one is a rule from the doc:
 *
 *  1. It has a recorded origin — this app watched it arrive (rule 2).
 *     Without this, a title somebody added here would be deleted for the
 *     crime of not being on a service it was never on.
 *  2. That origin names the account connected NOW. "It came from Trakt"
 *     does not survive somebody signing into a different Trakt: account
 *     B's list is not evidence about account A's title, and an origin
 *     with no account on it (written before stamps existed) can never be
 *     attributed to anyone.
 *  3. That origin's service ANSWERED this pass (rule 5). Absence has to
 *     be a successful answer that did not contain it, not the absence of
 *     an answer — an outage must never read as an emptied watchlist.
 *  4. No service still holds it. Still on Simkl means it has not left
 *     anywhere that counts.
 *  5. It is still on the local list, or there is nothing to remove.
 */
export function plannedRemovals(input: RemovalInput): string[] {
  const tracked = new Set(input.tracked)
  const out: string[] = []
  for (const [id, origin] of Object.entries(input.origins)) {
    const account = input.accounts[origin.source]
    if (!account || origin.account !== account) continue
    if (!input.answered.has(origin.source)) continue
    if ((input.sources[id] ?? []).length > 0) continue
    if (!tracked.has(id)) continue
    out.push(id)
  }
  return out
}
