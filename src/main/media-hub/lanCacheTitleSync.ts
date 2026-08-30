// Household title sync — stage 8 of the title index, the client half of
// the daemon's title tier.
//
// While a cache server is paired, the app pulls the daemon's index into
// its own `catalog_index` by change-sequence watermark: the first pass
// pages through the whole household index, every later pass fetches only
// what changed. The daemon's full-depth crawl thus reaches every device
// without any of them talking to Cinemeta or Kitsu for depth — the local
// deep-scan button stays for the unpaired, and the standing head crawl
// stays local because trending curation and anime grouping are local
// passes.
//
// Two rules carried over from stage 5, deliberately identical:
//   - synced rows NEVER overwrite what the local crawl curated
//     (planDeepScanBatch — the same function, because it is the same
//     rule: daemon rows arrive ungrouped, and upserting one over a
//     franchise-grouped anime row would undo the grouping pass);
//   - failure costs progress, never rows: an unreachable daemon ends the
//     pass with the watermark unmoved, and the next pass resumes.
//
// Rank note: the daemon's rank IS the absolute position in the same
// upstream walk the local crawl and deep scan use, so it passes through
// verbatim — a synced row sorts under "trending" exactly where upstream
// ranks it, and depth arrives underneath the curated head, not on top.

import type { MediaKind } from '../../shared/media-hub/types'
import {
  sanitizeDaemonTitleRow,
  TITLE_SYNC_MAX_PAGES_PER_PASS,
  TITLE_SYNC_PAGE_LIMIT
} from '../../shared/lancache/titleSync'
import { getDatabase } from './dbState'
import { planDeepScanBatch } from './deepScanRules'
import { isLanCacheConnected, lanCacheTitles } from './lanCache'

/** Durable per-kind watermark: the last daemon seq this client ingested.
 *  Reset only by unpairing logic never — a re-paired SAME server resumes,
 *  and a DIFFERENT server's seqs being unrelated is healed by the ids
 *  being the same titles (skip-existing) and the watermark racing forward
 *  on the first pass. */
const WATERMARK_KEY = 'lancachetitles:v1'
const WATERMARK_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000

const KINDS: MediaKind[] = ['movie', 'series', 'anime']

export interface TitleSyncReport {
  /** Rows fetched, rows that passed validation, rows actually added. */
  fetched: number
  accepted: number
  added: number
}

/** One background pass. Registered as a recurring job; safe to run with
 *  no daemon (returns immediately) and cheap once caught up (one page of
 *  nothing per kind). */
export async function runLanCacheTitleSync(): Promise<TitleSyncReport> {
  const report: TitleSyncReport = { fetched: 0, accepted: 0, added: 0 }
  if (!isLanCacheConnected()) return report
  const db = getDatabase()

  for (const kind of KINDS) {
    let since = db.getCache<number>(`${WATERMARK_KEY}:${kind}`, { allowExpired: true }) ?? 0
    for (let page = 0; page < TITLE_SYNC_MAX_PAGES_PER_PASS; page++) {
      const result = await lanCacheTitles(kind, since, TITLE_SYNC_PAGE_LIMIT)
      // Unreachable, unpaired mid-pass, or an older daemon with no title
      // tier: end the pass silently. The watermark is unmoved, so nothing
      // is skipped — the next pass (or the next daemon update) resumes.
      if (!result) break
      const rawRows = Array.isArray(result.rows) ? result.rows.slice(0, TITLE_SYNC_PAGE_LIMIT) : []
      report.fetched += rawRows.length

      // Validate every row individually; a bad row is dropped, not the
      // page. Kind must match what was asked for — a daemon answering the
      // movie question with anime rows does not get them filed under movie.
      const sane = rawRows
        .map((row) => sanitizeDaemonTitleRow(row))
        .filter((row): row is NonNullable<typeof row> => row !== null && row.kind === kind)
      report.accepted += sane.length

      if (sane.length) {
        // Same rule as the deep scan, same function: never overwrite what
        // the local crawl curated. Sorted by daemon rank so the verbatim
        // ranks land in catalog order within the batch.
        const ordered = [...sane].sort((a, b) => a.rank - b.rank)
        const { add } = planDeepScanBatch(
          ordered.map((row) => row.item),
          db.indexExistingIds(
            kind,
            ordered.map((row) => row.item.id)
          )
        )
        if (add.length) {
          const rankOf = new Map(ordered.map((row) => [row.item.id, row.rank]))
          db.indexUpsert(kind, add, {
            source: 'lancache',
            ranks: add.map((item) => rankOf.get(item.id) ?? 0)
          })
          report.added += add.length
        }
      }

      // The watermark advances to what the daemon SAYS we have seen —
      // including rows validation rejected or the skip rule declined.
      // Seen and refused is seen; only failure to hear keeps it still.
      const nextSince = Number(result.nextSince)
      if (Number.isFinite(nextSince) && nextSince > since) {
        since = nextSince
        db.putCache(`${WATERMARK_KEY}:${kind}`, since, WATERMARK_TTL_MS, { durable: true })
      }
      if (!result.more) break
    }
  }
  return report
}
