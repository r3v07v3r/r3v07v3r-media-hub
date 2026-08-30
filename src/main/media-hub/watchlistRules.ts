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
}

/**
 * Which locally-planned titles should be un-planned because they have
 * left the service they came from.
 *
 * Four conditions, all required, and each one is a rule from the doc:
 *
 *  1. It has a recorded origin — this app watched it arrive (rule 2).
 *     Without this, a title somebody added here would be deleted for the
 *     crime of not being on a service it was never on.
 *  2. That origin's service ANSWERED this pass (rule 5). Absence has to
 *     be a successful answer that did not contain it, not the absence of
 *     an answer — an outage must never read as an emptied watchlist.
 *  3. No service still holds it. Still on Simkl means it has not left
 *     anywhere that counts.
 *  4. It is still on the local list, or there is nothing to remove.
 */
export function plannedRemovals(input: RemovalInput): string[] {
  const tracked = new Set(input.tracked)
  const out: string[] = []
  for (const [id, origin] of Object.entries(input.origins)) {
    if (!input.answered.has(origin.source)) continue
    if ((input.sources[id] ?? []).length > 0) continue
    if (!tracked.has(id)) continue
    out.push(id)
  }
  return out
}
