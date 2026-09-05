// Ingest validation for household title sync — pure, like wantedList.ts,
// so the rules are pinned by tests rather than implied by the loop that
// applies them.
//
// The trust argument, stated once: a paired daemon is trusted to serve
// media and hold TorBox credentials, but title rows carry URLs the
// renderer will load and text it will render, into a database every
// surface reads. So rows are validated AT THE CLIENT, on arrival — a
// compromised or merely buggy daemon can cost the household its sync, but
// never a row the app would not have accepted from upstream itself.

import type { CatalogItem, MediaKind } from '../media-hub/types'

/** Ids the index may hold: Cinemeta's IMDb ids and Kitsu's. Anything else
 *  is rejected — an id is routed on, opened, and interpolated into API
 *  URLs, so the alphabet is closed. */
const ID_RE = /^(tt\d+|kitsu:\d+)$/

/** Artwork must be https or absent. The renderer loads these URLs
 *  directly; http and every other scheme (file:, data:, chrome:) are
 *  refused rather than laundered. */
function httpsOrEmpty(value: unknown): string | null {
  const url = String(value ?? '')
  if (!url) return ''
  if (!/^https:\/\//i.test(url)) return null
  return url.slice(0, 1024)
}

function text(value: unknown, cap: number): string {
  return String(value ?? '').slice(0, cap)
}

/** Rows per sync page — mirrors the daemon's own limit; a page claiming
 *  more is truncated, not trusted. */
export const TITLE_SYNC_PAGE_LIMIT = 500

/** Pages pulled per background pass. Bounds one pass's work (20k rows) —
 *  the watermark makes the next pass resume exactly where this one
 *  stopped, so depth arrives across passes rather than in one gulp. */
export const TITLE_SYNC_MAX_PAGES_PER_PASS = 40

export interface SanitizedTitleRow {
  seq: number
  kind: MediaKind
  rank: number
  item: CatalogItem
}

/**
 * One wire row → one index-ready row, or null.
 *
 * Null means REJECTED, silently and individually — one bad row must not
 * cost the page it arrived on. The accepted shape is the subset of
 * CatalogItem the index stores (see database.ts indexPut): everything
 * else the daemon sent is dropped rather than passed through, so a field
 * this version cannot name cannot reach the database through this door.
 */
export function sanitizeDaemonTitleRow(raw: unknown): SanitizedTitleRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as { seq?: unknown; kind?: unknown; rank?: unknown; item?: unknown }
  const seq = Number(row.seq)
  const rank = Number(row.rank)
  if (!Number.isFinite(seq) || seq <= 0) return null
  if (!Number.isFinite(rank) || rank < 0) return null
  const kind = row.kind
  if (kind !== 'movie' && kind !== 'series' && kind !== 'anime') return null
  if (!row.item || typeof row.item !== 'object') return null
  const item = row.item as Record<string, unknown>

  const id = String(item.id ?? '')
  if (!ID_RE.test(id)) return null
  const title = text(item.title, 300)
  if (!title) return null

  const poster = httpsOrEmpty(item.poster)
  const background = httpsOrEmpty(item.background)
  const logo = httpsOrEmpty(item.logo)
  if (poster === null || background === null || logo === null) return null

  const genres = Array.isArray(item.genres)
    ? item.genres
        .slice(0, 20)
        .map((genre) => text(genre, 60).trim())
        .filter(Boolean)
    : []

  return {
    seq,
    kind,
    rank: Math.floor(rank),
    item: {
      id,
      title,
      type: kind,
      poster,
      background,
      logo,
      year: text(item.year, 20),
      status: text(item.status, 40),
      description: text(item.description, 4000),
      rating: text(item.rating, 10),
      runtime: text(item.runtime, 20),
      genres,
      // The index stores no per-episode data (see migration 2), and a
      // synced row certainly does not smuggle any in.
      videos: [],
      trailers: []
    }
  }
}
