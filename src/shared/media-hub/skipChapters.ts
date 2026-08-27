// Skip-intro/credits windows derived from a file's own mpv chapter marks,
// for movies and series — the two kinds Aniskip (main/media-hub/aniskip.ts)
// has never covered, because it is a community database of anime submissions
// and has no equivalent for anything else.
//
// There is no community database to ask here, so this reads what the file
// itself already carries: many Blu-ray-sourced and streaming releases tag a
// real chapter as "Opening Credits" or "End Credits", and that mark is
// exact by construction — it was authored against these exact frames, not
// matched by proximity the way Aniskip's submissions are.
//
// The trade this makes is coverage for confidence: a release with no such
// chapter offers nothing, rather than a guess. Two separate gates keep a
// false match from skipping real content —
//
//   - the NAME must be one of a short, literal allowlist. No substring or
//     fuzzy matching: a scene chapter that happens to be titled
//     "Introduction to the Order" must not trip this the way it would
//     under a loose "contains 'intro'" test.
//   - the POSITION must fit where an intro or a credits sequence actually
//     is. An intro chapter appearing three-quarters into the runtime, or a
//     "Credits" chapter in the first few minutes, is not what its name
//     claims to be — some other convention this app has not seen before —
//     and is left alone rather than trusted anyway.
//
// Both gates have to pass. Either alone lets through exactly the kind of
// mislabeled or unconventional chapter this exists to not act on.

export interface ChapterMark {
  title: string
  time: number
}

export interface ChapterSkipWindows {
  intro?: { start: number; end: number }
  credits?: { start: number; end: number }
}

/** Literal chapter titles (case-insensitive, whole-title match) that mean
 *  "recap or opening sequence, skippable start to end of this chapter." */
const INTRO_TITLES = new Set([
  'opening credits',
  'opening titles',
  'intro',
  'introduction',
  'title sequence',
  'main title',
  'main titles',
  'recap',
  'previously on'
])

/** Literal chapter titles meaning "end credits — skippable to the end of
 *  the file." */
const CREDITS_TITLES = new Set([
  'end credits',
  'closing credits',
  'credits',
  'end title',
  'end titles'
])

/** How far into the runtime an intro chapter may start, and how late a
 *  credits chapter may start — a quarter of the runtime either way. Loose
 *  enough for a slow cold open ahead of a title card, or a long tail of
 *  bonus/outtake chapters after the credits proper; tight enough that a
 *  same-named chapter in the middle of a film (a flashback scene actually
 *  titled "Recap", however unlikely) does not qualify just because the
 *  word matched. */
const POSITION_FRACTION = 0.25

/** The longest an intro chapter is allowed to run. A "match" spanning
 *  longer than this is not really an opening sequence — more likely a
 *  release that reuses the same chapter title for something else — and is
 *  left unoffered rather than sending someone six minutes into a film. */
const MAX_INTRO_SECONDS = 5 * 60

/** Lowercased, trimmed, and stripped of a trailing ellipsis (either the
 *  Unicode character or three dots) — "Previously On…" and "Previously
 *  On..." both mean the allowlist's "previously on", and listing every
 *  punctuation spelling by hand invites a typo in the allowlist itself
 *  more than it invites a real miss. */
function normalize(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/(\.{3}|…)$/, '')
    .trim()
}

/**
 * Skip windows this file's own chapter marks support, or null if none of
 * them pass both gates.
 *
 * Chapters are assumed sorted by time, which is how mpv reports them and
 * how every caller of this already has them.
 */
export function skipWindowsFromChapters(
  chapters: readonly ChapterMark[],
  durationSeconds: number
): ChapterSkipWindows | null {
  if (!chapters.length || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null

  const result: ChapterSkipWindows = {}
  const introDeadline = durationSeconds * POSITION_FRACTION
  const creditsEarliest = durationSeconds * (1 - POSITION_FRACTION)

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    const title = normalize(chapter.title)
    const next = chapters[i + 1]

    if (!result.intro && INTRO_TITLES.has(title) && chapter.time <= introDeadline && next) {
      const end = next.time
      if (end - chapter.time > 0 && end - chapter.time <= MAX_INTRO_SECONDS) {
        result.intro = { start: chapter.time, end }
      }
    }

    if (!result.credits && CREDITS_TITLES.has(title) && chapter.time >= creditsEarliest) {
      result.credits = { start: chapter.time, end: durationSeconds }
    }
  }

  return result.intro || result.credits ? result : null
}
