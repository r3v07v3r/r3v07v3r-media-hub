#!/usr/bin/env node
// Resolves real poster/backdrop/logo art (+ plot overview) from TMDB for
// every title in src/renderer/src/data/mockData.ts and writes the result
// to src/renderer/src/data/tmdbArtwork.generated.json. mockData.ts merges
// that file in at module-load time (see the `withRealArtwork()` helper
// there), so the app keeps rendering synchronously off mock data — this
// script is the one-time (or re-run-whenever) network step, not the
// running app.
//
// Requires a free TMDB API key: https://www.themoviedb.org/settings/api
// Put it in .env.local as TMDB_API_KEY=xxxxx (never commit that file —
// it's already in .gitignore), then run:
//
//   npm run fetch:artwork
//
// This makes real network calls to api.themoviedb.org and
// image.tmdb.org. If you're running this from an environment with
// restricted/no outbound internet access (e.g. a locked-down sandbox),
// it will fail with a clear connection error — run it somewhere with
// normal internet access instead (your own machine, CI, etc).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setGlobalDispatcher, ProxyAgent } from 'undici'

// Node's built-in fetch doesn't honor HTTP_PROXY/HTTPS_PROXY env vars the
// way curl does — most real machines don't need a proxy at all, but
// sandboxed environments that gate egress through one (e.g. an
// allowlisting proxy) do. This is a harmless no-op wherever the env var
// isn't set.
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUTPUT_PATH = path.join(ROOT, 'src/renderer/src/data/tmdbArtwork.generated.json')
const ENV_LOCAL_PATH = path.join(ROOT, '.env.local')

// ---------- Load TMDB_API_KEY from process.env or .env.local ----------
function loadApiKey() {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY.trim()
  if (existsSync(ENV_LOCAL_PATH)) {
    const raw = readFileSync(ENV_LOCAL_PATH, 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*TMDB_API_KEY\s*=\s*(.+?)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  return null
}

const API_KEY = loadApiKey()
if (!API_KEY) {
  console.error(
    'No TMDB_API_KEY found. Add TMDB_API_KEY=your_key to .env.local (see scripts/fetch-tmdb-artwork.mjs header) and re-run.'
  )
  process.exit(1)
}

// ---------- Manifest: every title that appears in mockData.ts ----------
// `key` must be produced the same way mockData.ts's withRealArtwork()
// helper builds its lookup key: normalize(title) + "|" + normalize(subtitle).
// yearHint/mediaTypeHint are ONLY used to disambiguate TMDB search
// results here — they are not written back to the app's mock data.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
function key(title, subtitle) {
  return `${normalize(title)}|${normalize(subtitle)}`
}

const MANIFEST = [
  { title: 'DUNE', subtitle: 'PART TWO', query: 'Dune Part Two', yearHint: 2024 },
  {
    title: 'THE LAST OF US',
    subtitle: 'SEASON 2',
    query: 'The Last of Us',
    mediaTypeHint: 'tv',
    yearHint: 2023
  },
  { title: 'BLADE RUNNER', subtitle: '2049', query: 'Blade Runner 2049', yearHint: 2017 },
  { title: 'INTERSTELLAR', subtitle: '', query: 'Interstellar', yearHint: 2014 },
  { title: 'Dark', subtitle: '', query: 'Dark', mediaTypeHint: 'tv', yearHint: 2017 },
  { title: 'The Last of Us', subtitle: '', query: 'The Last of Us', mediaTypeHint: 'tv', yearHint: 2023 },
  { title: 'Fallout', subtitle: '', query: 'Fallout', mediaTypeHint: 'tv', yearHint: 2024 },
  { title: 'Dune: Part One', subtitle: '', query: 'Dune', yearHint: 2021 },
  { title: 'Blade Runner 2049', subtitle: '', query: 'Blade Runner 2049', yearHint: 2017 },
  { title: 'Interstellar', subtitle: '', query: 'Interstellar', yearHint: 2014 },
  { title: 'The Martian', subtitle: '', query: 'The Martian', yearHint: 2015 },
  { title: 'Arrival', subtitle: '', query: 'Arrival', yearHint: 2016 },
  { title: 'Ex Machina', subtitle: '', query: 'Ex Machina', yearHint: 2014 },
  { title: 'Her', subtitle: '', query: 'Her', yearHint: 2013 },
  { title: 'Annihilation', subtitle: '', query: 'Annihilation', yearHint: 2018 },
  { title: 'The Grand Budapest Hotel', subtitle: '', query: 'The Grand Budapest Hotel', yearHint: 2014 },
  { title: 'Paddington 2', subtitle: '', query: 'Paddington 2', yearHint: 2017 },
  {
    title: 'Stranger Things',
    subtitle: '',
    query: 'Stranger Things',
    mediaTypeHint: 'tv',
    yearHint: 2016
  },
  { title: 'Mad Max: Fury Road', subtitle: '', query: 'Mad Max Fury Road', yearHint: 2015 },
  { title: 'John Wick', subtitle: '', query: 'John Wick', yearHint: 2014 },
  // ---- Expanded AI Picks pool (spec: "up to 20+ items to cover
  // ultra-wide screens") — more sci-fi/thriller titles in the same vein
  // as the existing picks, so the row has enough real content to fill a
  // 3440px+ window without running out of cards.
  { title: 'Inception', subtitle: '', query: 'Inception', yearHint: 2010 },
  { title: 'The Prestige', subtitle: '', query: 'The Prestige', yearHint: 2006 },
  { title: 'Minority Report', subtitle: '', query: 'Minority Report', yearHint: 2002 },
  { title: 'Edge of Tomorrow', subtitle: '', query: 'Edge of Tomorrow', yearHint: 2014 },
  { title: 'Looper', subtitle: '', query: 'Looper', yearHint: 2012 },
  { title: 'Oblivion', subtitle: '', query: 'Oblivion', yearHint: 2013 },
  { title: 'Elysium', subtitle: '', query: 'Elysium', yearHint: 2013 },
  { title: 'District 9', subtitle: '', query: 'District 9', yearHint: 2009 },
  { title: 'Children of Men', subtitle: '', query: 'Children of Men', yearHint: 2006 },
  { title: 'Gravity', subtitle: '', query: 'Gravity', yearHint: 2013 },
  { title: 'The Matrix', subtitle: '', query: 'The Matrix', yearHint: 1999 },
  { title: '12 Monkeys', subtitle: '', query: '12 Monkeys', yearHint: 1995 },
  { title: 'Moon', subtitle: '', query: 'Moon', yearHint: 2009 },
  { title: 'Snowpiercer', subtitle: '', query: 'Snowpiercer', yearHint: 2013 },
  { title: 'A Quiet Place', subtitle: '', query: 'A Quiet Place', yearHint: 2018 },
  { title: 'Prisoners', subtitle: '', query: 'Prisoners', yearHint: 2013 },
  { title: 'Sicario', subtitle: '', query: 'Sicario', yearHint: 2015 },
  { title: 'Gone Girl', subtitle: '', query: 'Gone Girl', yearHint: 2014 }
]

// Dedupe by key — a couple of titles (Interstellar, Blade Runner 2049)
// legitimately appear twice in mockData.ts under slightly different
// title/subtitle pairs.
const seen = new Map()
for (const entry of MANIFEST) {
  seen.set(key(entry.title, entry.subtitle), entry)
}

const TMDB_API = 'https://api.themoviedb.org/3'
const IMG = 'https://image.tmdb.org/t/p'

async function tmdbGet(pathname, params = {}) {
  const url = new URL(TMDB_API + pathname)
  url.searchParams.set('api_key', API_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`TMDB ${pathname} -> HTTP ${res.status}`)
  }
  return res.json()
}

function pickBestResult(results, entry) {
  const candidates = results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
  if (candidates.length === 0) return null
  if (entry.mediaTypeHint) {
    const filtered = candidates.filter((r) => r.media_type === entry.mediaTypeHint)
    if (filtered.length) return pickByYear(filtered, entry.yearHint)
  }
  return pickByYear(candidates, entry.yearHint)
}

function pickByYear(candidates, yearHint) {
  if (!yearHint) return candidates[0]
  let best = candidates[0]
  let bestDiff = Infinity
  for (const c of candidates) {
    const dateStr = c.release_date || c.first_air_date || ''
    const year = dateStr ? Number(dateStr.slice(0, 4)) : null
    const diff = year ? Math.abs(year - yearHint) : 99
    if (diff < bestDiff) {
      bestDiff = diff
      best = c
    }
  }
  return best
}

async function resolveOne(entry) {
  const search = await tmdbGet('/search/multi', { query: entry.query, include_adult: 'false' })
  const best = pickBestResult(search.results || [], entry)
  if (!best) {
    console.warn(`  no TMDB match for "${entry.query}"`)
    return null
  }
  const mediaType = best.media_type // "movie" | "tv"
  const detail = await tmdbGet(`/${mediaType}/${best.id}/images`, {
    include_image_language: 'en,null'
  })
  const poster = best.poster_path ? `${IMG}/w500${best.poster_path}` : undefined
  const backdrop = best.backdrop_path ? `${IMG}/w1280${best.backdrop_path}` : undefined
  const logoPath = (detail.logos || [])[0]?.file_path
  const logo = logoPath ? `${IMG}/w500${logoPath}` : undefined
  return {
    tmdbId: best.id,
    mediaType,
    matchedTitle: best.title || best.name,
    posterUrl: poster,
    backdropUrl: backdrop,
    logoUrl: logo,
    // Straight from /search/multi — no extra request needed. Falls back
    // to undefined (never an empty string) so mockData.ts's `??` chain
    // treats a missing overview the same as no TMDB match at all.
    overview: best.overview || undefined
  }
}

async function main() {
  console.log(`Resolving artwork for ${seen.size} unique titles from TMDB...`)
  const output = {}
  let ok = 0
  let failed = 0
  for (const [k, entry] of seen) {
    try {
      const result = await resolveOne(entry)
      if (result) {
        output[k] = result
        ok += 1
        console.log(`  ✓ ${entry.query} -> ${result.matchedTitle} (${result.mediaType}, tmdb:${result.tmdbId})`)
      } else {
        failed += 1
      }
    } catch (err) {
      failed += 1
      console.error(`  ✗ ${entry.query}: ${err.message}`)
    }
    // Be polite to TMDB's rate limit — small delay between requests.
    await new Promise((r) => setTimeout(r, 150))
  }
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n')
  console.log(`\nWrote ${ok} entries (${failed} failed) to ${path.relative(ROOT, OUTPUT_PATH)}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('\nFailed to reach TMDB:', err.message)
  console.error(
    'If this is a connection error (ENOTFOUND / ETIMEDOUT / 403 from a proxy), the environment ' +
      'running this script doesn\'t have outbound internet access to api.themoviedb.org. Run it ' +
      'somewhere with normal internet access instead.'
  )
  process.exit(1)
})
