// The browse grid's bucket filters — runtime, seasons, episode length,
// episode count — as RANGES rather than predicates.
//
// They used to live in the renderer as `test: (n) => n >= 90 && n <= 120`
// closures, which is the natural shape while filtering happens in memory and
// the only possible shape when it does. It stops working the moment the same
// filter also has to run as SQL: a closure cannot be turned into a WHERE
// clause, so the alternative was writing each boundary twice, once in JS and
// once in SQL, and hoping the two stayed in step. They would not have. The
// first person to change "Under 90 min" to "Under 100 min" would have changed
// one of them.
//
// A range is the thing both sides can consume. `bucketTest` derives the
// predicate the in-memory path still uses, and the query builder derives
// `col >= min AND col <= max` from the same numbers.
//
// Bounds are INCLUSIVE and integral, which is exact here rather than
// approximate: every value these filter on is a whole number (runtime.ts
// yields whole minutes; season and episode counts are counts), so `m < 90`
// and `m <= 89` select the same titles. Writing them inclusively is what lets
// one definition serve both a JS comparison and a SQL BETWEEN.

export interface Bucket {
  value: string
  label: string
  /** Inclusive lower bound. Absent means unbounded below. */
  min?: number
  /** Inclusive upper bound. Absent means unbounded above. */
  max?: number
}

export const RUNTIME_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 90 min', max: 89 },
  { value: 'medium', label: '90–120 min', min: 90, max: 120 },
  { value: 'long', label: 'Over 120 min', min: 121 }
]

export const SEASONS_BUCKETS: Bucket[] = [
  { value: '1', label: '1 season', min: 1, max: 1 },
  { value: '2-4', label: '2–4 seasons', min: 2, max: 4 },
  { value: '5plus', label: '5+ seasons', min: 5 }
]

export const EPISODE_LENGTH_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 30 min', max: 29 },
  { value: 'medium', label: '30–45 min', min: 30, max: 45 },
  { value: 'long', label: 'Over 45 min', min: 46 }
]

export const EPISODES_BUCKETS: Bucket[] = [
  { value: 'short', label: 'Under 13 episodes', max: 12 },
  { value: 'medium', label: '13–26 episodes', min: 13, max: 26 },
  { value: 'long', label: '26+ episodes', min: 27 }
]

/** The in-memory predicate for one bucket — what the `test` closures used to be. */
export function bucketTest(bucket: Bucket): (n: number) => boolean {
  return (n) => (bucket.min == null || n >= bucket.min) && (bucket.max == null || n <= bucket.max)
}

/** Looks one up by the value carried in the URL. Undefined for a value no
 *  longer in the list — a stale bookmark, which every caller treats as
 *  "matches nothing" rather than "no filter", preserving what the old
 *  `BUCKETS.find(...)` + `if (!bucket) return false` did. */
export function findBucket(buckets: Bucket[], value: string | null): Bucket | undefined {
  if (!value) return undefined
  return buckets.find((b) => b.value === value)
}

export const RATING_THRESHOLDS = [
  { value: '9', label: '9+' },
  { value: '8', label: '8+' },
  { value: '7', label: '7+' },
  { value: '6', label: '6+' }
]
