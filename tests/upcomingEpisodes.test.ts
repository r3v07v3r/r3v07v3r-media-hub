// "Which of these episodes has not come out yet?" — the rules behind the
// TBA / "Releases <date>" tiles and the Play buttons that stay put for
// them. See shared/media-hub/upcomingEpisodes.ts's header for the two
// sources and why the date always wins over the flag.
//
// Run with: npx tsx tests/upcomingEpisodes.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'

import {
  applyAiringSchedule,
  isFinishedStatus,
  markUpcomingEpisodes
} from '../src/shared/media-hub/upcomingEpisodes'
import { hasAired } from '../src/shared/media-hub/catalog-logic'
import { episodeToStart, playableEpisodesInOrder } from '../src/shared/media-hub/nextEpisode'
import { airingScheduleFromNode } from '../src/main/media-hub/anilist'
import {
  isTerminalSchedule,
  scheduleWorthAsking,
  seasonAcceptsSchedule,
  seasonStillAiring
} from '../src/main/media-hub/episodeAiring'
import { isFutureRelease, isUpcomingEpisode } from '../src/renderer/src/lib/mediaHub/releaseDate'
import type { Episode } from '../src/shared/media-hub/types'

// A fixed "today", so the boundary is testable: 16 Sep 2026, midday UTC.
const NOW = Date.UTC(2026, 8, 16, 12)
const YESTERDAY = '2026-09-15'
const LAST_WEEK = '2026-09-09'
const TOMORROW = '2026-09-17'

function ep(season: number, episode: number, extra: Partial<Episode> = {}): Episode {
  return {
    id: `${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: `Episode ${episode}`,
    released: '',
    ...extra
  }
}

function upcomingKeys(videos: Episode[]): string[] {
  return videos.filter((v) => v.upcoming === true).map((v) => v.id)
}

// ---------------------------------------------------------------------------
// isFinishedStatus — every vocabulary the sources use.

assert.equal(isFinishedStatus('finished'), true, "Kitsu's finished")
assert.equal(isFinishedStatus('Ended'), true, "Cinemeta's Ended")
assert.equal(isFinishedStatus('Canceled'), true, "TMDB's Canceled")
assert.equal(isFinishedStatus('cancelled'), true)
assert.equal(isFinishedStatus('current'), false, "Kitsu's current is running")
assert.equal(isFinishedStatus('Continuing'), false, "Cinemeta's Continuing is running")
assert.equal(isFinishedStatus('upcoming'), false)
assert.equal(isFinishedStatus(''), false, 'empty is unknown, not finished')
assert.equal(isFinishedStatus(undefined), false)

// ---------------------------------------------------------------------------
// Rule 1: the shape of the list.

// The case that started this: a running show whose last two episodes have no
// date. They come after the last aired one, so they are upcoming; the aired
// ones are not.
{
  const videos = [
    ep(1, 1, { released: LAST_WEEK }),
    ep(1, 2, { released: YESTERDAY }),
    ep(1, 3),
    ep(1, 4)
  ]
  const marked = markUpcomingEpisodes(videos, { status: 'current', now: NOW })
  assert.deepEqual(upcomingKeys(marked), ['1:3', '1:4'])
  assert.equal(marked[0].upcoming, undefined, 'an aired episode carries no flag at all')
}

// Cinemeta's vocabulary gets the same answer.
{
  const marked = markUpcomingEpisodes([ep(1, 1, { released: YESTERDAY }), ep(1, 2)], {
    status: 'Continuing',
    now: NOW
  })
  assert.deepEqual(upcomingKeys(marked), ['1:2'])
}

// A finished show with a dateless tail is a gap in the record, not a
// schedule — nothing is hidden behind TBA.
{
  const marked = markUpcomingEpisodes([ep(1, 1, { released: LAST_WEEK }), ep(1, 2)], {
    status: 'finished',
    now: NOW
  })
  assert.deepEqual(upcomingKeys(marked), [])
}

// An UNKNOWN status is not "running" either: with no evidence the show is
// still going, an undated tail stays presumed aired, as it always was.
{
  const marked = markUpcomingEpisodes([ep(1, 1, { released: LAST_WEEK }), ep(1, 2)], {
    status: '',
    now: NOW
  })
  assert.deepEqual(upcomingKeys(marked), [])
}

// A dateless episode in the MIDDLE of a running show is a gap, not the
// future: only what comes after the last aired episode is upcoming.
{
  const videos = [ep(1, 1, { released: LAST_WEEK }), ep(1, 2), ep(1, 3, { released: YESTERDAY })]
  const marked = markUpcomingEpisodes(videos, { status: 'current', now: NOW })
  assert.deepEqual(upcomingKeys(marked), [])
}

// After a future-dated episode, an undated one cannot have aired — whatever
// the title's status says, and even with nothing aired at all yet.
{
  const videos = [ep(1, 1, { released: TOMORROW }), ep(1, 2), ep(1, 3)]
  assert.deepEqual(upcomingKeys(markUpcomingEpisodes(videos, { status: '', now: NOW })), [
    '1:2',
    '1:3'
  ])
}

// A dated episode never carries the flag, future or not — its date is its
// verdict, and hasAired reads that first.
{
  const videos = [ep(1, 1, { released: YESTERDAY }), ep(1, 2, { released: TOMORROW })]
  const marked = markUpcomingEpisodes(videos, { status: 'current', now: NOW })
  assert.deepEqual(upcomingKeys(marked), [])
  assert.equal(hasAired(marked[1], NOW), false, 'still unaired, by its date')
}

// No dated episode anywhere (Kitsu's count-only placeholders) leaves rule 1
// nothing to reason from — it must not guess.
{
  const marked = markUpcomingEpisodes([ep(1, 1), ep(1, 2), ep(1, 3)], {
    status: 'current',
    now: NOW
  })
  assert.deepEqual(upcomingKeys(marked), [])
}

// Order is by (season, episode), not array position, and the boundary
// crosses seasons: an announced-but-unscheduled season 2 is all upcoming.
{
  const videos = [
    ep(2, 2),
    ep(1, 2, { released: YESTERDAY }),
    ep(2, 1),
    ep(1, 1, { released: LAST_WEEK })
  ]
  const marked = markUpcomingEpisodes(videos, { status: 'Continuing', now: NOW })
  assert.deepEqual(upcomingKeys(marked).sort(), ['2:1', '2:2'])
  assert.deepEqual(
    marked.map((v) => v.id),
    ['2:2', '1:2', '2:1', '1:1'],
    'the caller’s order is kept'
  )
}

// Specials and synthetic entries are outside the numbered run: never
// flagged, and never the boundary either.
{
  const videos = [
    ep(0, 1),
    ep(1, 1, { released: LAST_WEEK }),
    ep(1, 2),
    ep(0, -1, { unplayable: true })
  ]
  const marked = markUpcomingEpisodes(videos, { status: 'current', now: NOW })
  assert.deepEqual(upcomingKeys(marked), ['1:2'])
}

// Idempotent, and it clears a flag that no longer holds: the same list
// re-marked after its tail gained (past) dates loses the flags.
{
  const first = markUpcomingEpisodes([ep(1, 1, { released: LAST_WEEK }), ep(1, 2)], {
    status: 'current',
    now: NOW
  })
  assert.deepEqual(upcomingKeys(first), ['1:2'])
  const again = markUpcomingEpisodes(first, { status: 'current', now: NOW })
  assert.deepEqual(again, first)
  const dated = markUpcomingEpisodes(
    first.map((v) => (v.id === '1:2' ? { ...v, released: YESTERDAY } : v)),
    { status: 'current', now: NOW }
  )
  assert.deepEqual(upcomingKeys(dated), [])
  assert.equal('upcoming' in dated[1], false, 'cleared means removed, not false')
}

// An episode the caller passed untouched keeps its identity, so React and
// memo callers see no change where there is none.
{
  const aired = ep(1, 1, { released: LAST_WEEK })
  const marked = markUpcomingEpisodes([aired, ep(1, 2)], { status: 'current', now: NOW })
  assert.equal(marked[0], aired)
}

// ---------------------------------------------------------------------------
// hasAired honours the flag — and only when there is no date.

assert.equal(hasAired(ep(1, 1), NOW), true, 'undated, unflagged: presumed aired')
assert.equal(hasAired(ep(1, 1, { upcoming: true }), NOW), false, 'undated, flagged: not yet')
assert.equal(
  hasAired(ep(1, 1, { released: YESTERDAY, upcoming: true }), NOW),
  true,
  'a stale flag loses to a date that has passed'
)
assert.equal(hasAired(ep(1, 1, { released: TOMORROW }), NOW), false)
assert.equal(
  hasAired(ep(1, 1, { released: 'not a date', upcoming: true }), NOW),
  false,
  'an unparseable date is no date'
)

// ...so Play, progress and the next-up card all skip a flagged episode.
{
  const videos = [ep(1, 1), ep(1, 2), ep(1, 3, { upcoming: true })]
  assert.deepEqual(
    playableEpisodesInOrder(videos, NOW).map((v) => v.id),
    ['1:1', '1:2']
  )
  assert.deepEqual(episodeToStart(videos, new Set(['1:1', '1:2']), NOW), {
    season: 1,
    episode: 1
  })
}

// ---------------------------------------------------------------------------
// Rule 2: AniList's schedule, over one season.

const SCHEDULE_NEXT_12 = {
  status: 'RELEASING',
  nextEpisode: 12,
  airDates: { 12: '2026-09-17T15:30:00.000Z', 13: '2026-09-24T15:30:00.000Z' }
}

// The screenshot case exactly: thirteen placeholders with no dates at all,
// AniList says 12 airs next. 1–11 have aired, 12 and 13 get their instants
// (and so no flag), and Play/progress stop at 11.
{
  const placeholders = Array.from({ length: 13 }, (_, i) => ep(1, i + 1))
  const applied = applyAiringSchedule(placeholders, 1, SCHEDULE_NEXT_12)
  assert.deepEqual(upcomingKeys(applied), [])
  assert.equal(applied[11].released, '2026-09-17T15:30:00.000Z')
  assert.equal(applied[12].released, '2026-09-24T15:30:00.000Z')
  assert.equal(applied[10].released, '', 'an aired episode’s missing date is left alone')
  assert.deepEqual(
    playableEpisodesInOrder(applied, NOW).map((v) => v.episode),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  )
}

// A scheduled episode beyond what AniList has dated is upcoming by number,
// and so flagged — the TBA tile.
{
  const applied = applyAiringSchedule([ep(1, 11), ep(1, 12), ep(1, 13), ep(1, 14)], 1, {
    status: 'RELEASING',
    nextEpisode: 12,
    airDates: { 12: '2026-09-17T15:30:00.000Z' }
  })
  assert.deepEqual(upcomingKeys(applied), ['1:13', '1:14'])
  assert.equal(applied[1].upcoming, undefined, 'dated by the schedule, so judged by the date')
}

// The schedule overrides rule 1 both ways: an episode rule 1 flagged that
// AniList says has aired is cleared; one rule 1 left alone that AniList
// puts after the next airing is flagged.
{
  const rule1 = markUpcomingEpisodes(
    [ep(1, 9, { released: LAST_WEEK }), ep(1, 10), ep(1, 11), ep(1, 12), ep(1, 13)],
    { status: 'current', now: NOW }
  )
  assert.deepEqual(upcomingKeys(rule1), ['1:10', '1:11', '1:12', '1:13'])
  const applied = applyAiringSchedule(rule1, 1, {
    status: 'RELEASING',
    nextEpisode: 12,
    airDates: {}
  })
  assert.deepEqual(upcomingKeys(applied), ['1:12', '1:13'])
}

// AniList's instant replaces Kitsu's calendar day for a scheduled episode.
{
  const applied = applyAiringSchedule([ep(1, 12, { released: TOMORROW })], 1, SCHEDULE_NEXT_12)
  assert.equal(applied[0].released, '2026-09-17T15:30:00.000Z')
}

// An episode the schedule says has aired loses a date still ahead of now —
// the broadcast was moved earlier since that date was learned, and a date
// wins everywhere else, so left alone it would keep the tile blocked until
// the old instant passed. A date already behind now is consistent and kept.
{
  const movedEarlier = [
    ep(1, 11, { released: YESTERDAY }),
    ep(1, 12, { released: '2026-09-24T15:30:00.000Z' }),
    ep(1, 13, { released: '2026-10-01T15:30:00.000Z' })
  ]
  const applied = applyAiringSchedule(
    movedEarlier,
    1,
    { status: 'RELEASING', nextEpisode: 13, airDates: { 13: '2026-10-01T15:30:00.000Z' } },
    NOW
  )
  assert.equal(applied[0].released, YESTERDAY, 'a past date is consistent with "aired"')
  assert.equal(applied[1].released, '', 'the stale future date is cleared')
  assert.equal(applied[1].upcoming, undefined)
  assert.equal(hasAired(applied[1], NOW), true, 'so it reads as aired, as the schedule says')
  assert.equal(applied[2].released, '2026-10-01T15:30:00.000Z', 'still scheduled: kept')
  // FINISHED does NOT: a status is the title's word, not an episode's, and
  // a FINISHED entered early on a community-edited database must not turn
  // a finale still dated ahead into a Play button. Flags cleared, dates kept.
  const done = applyAiringSchedule(
    [...movedEarlier, ep(1, 14, { upcoming: true })],
    1,
    { status: 'FINISHED', nextEpisode: null, airDates: {} },
    NOW
  )
  assert.deepEqual(
    done.map((v) => v.released),
    [YESTERDAY, '2026-09-24T15:30:00.000Z', '2026-10-01T15:30:00.000Z', '']
  )
  assert.deepEqual(upcomingKeys(done), [])
  assert.deepEqual(
    playableEpisodesInOrder(done, NOW).map((v) => v.episode),
    [11, 14]
  )
}

// Only the season the schedule is for — a grouped anime's earlier seasons
// are numbered by their own entries and are not this schedule's business.
{
  const applied = applyAiringSchedule([ep(1, 12), ep(2, 12), ep(0, 12)], 2, SCHEDULE_NEXT_12)
  assert.equal(applied[0].released, '')
  assert.equal(applied[1].released, '2026-09-17T15:30:00.000Z')
  assert.equal(applied[2].released, '', 'specials are never touched')
}

// A cancelled (or paused) title: nothing airs after the moment AniList first
// said so. An episode dated later than that never aired — its pulled date
// goes and it is flagged, whatever the clock says now, because a cancelled
// title is never read again and its dates would otherwise "pass". One dated
// before it is consistent with having aired; undated ones keep rule 1's
// verdict. A row cached before `since` existed is judged against now.
{
  const cancelledAt = Date.UTC(2026, 8, 10)
  const list = [
    ep(1, 10, { released: '2026-09-03T15:30:00.000Z' }),
    ep(1, 11, { released: '2026-09-12T15:30:00.000Z' }),
    ep(1, 12, { released: '2026-09-24T15:30:00.000Z' }),
    ep(1, 13, { upcoming: true }),
    ep(1, 14)
  ]
  const cancelled = { status: 'CANCELLED', nextEpisode: null, airDates: {}, since: cancelledAt }
  const applied = applyAiringSchedule(list, 1, cancelled, NOW)
  assert.equal(applied[0].released, '2026-09-03T15:30:00.000Z', 'aired before: kept')
  assert.equal(applied[1].released, '', 'dated after the cancellation, though past now: pulled')
  assert.equal(applied[1].upcoming, true)
  assert.equal(applied[2].released, '', 'dated after and still ahead: pulled')
  assert.equal(applied[2].upcoming, true)
  assert.equal(applied[3].upcoming, true, 'undated: rule 1 stands')
  assert.equal(applied[4].upcoming, undefined, 'undated: rule 1 stands')
  assert.deepEqual(
    playableEpisodesInOrder(applied, NOW).map((v) => v.episode),
    [10, 14]
  )
  assert.deepEqual(
    applyAiringSchedule(list, 1, { ...cancelled, status: 'HIATUS' }, NOW).map((v) => v.released),
    ['2026-09-03T15:30:00.000Z', '', '', '', ''],
    'a hiatus is judged the same way — until a later read resumes the schedule'
  )
  const legacy = applyAiringSchedule(list, 1, { ...cancelled, since: undefined }, NOW)
  assert.equal(legacy[1].released, '2026-09-12T15:30:00.000Z', 'no since: past now, kept')
  assert.equal(legacy[2].released, '', 'no since: ahead of now, pulled')
}

// FINISHED clears every flag in the season; NOT_YET_RELEASED with nothing
// scheduled flags every episode; HIATUS says nothing and rule 1 stands.
{
  const flagged = [ep(1, 1, { upcoming: true }), ep(1, 2)]
  assert.deepEqual(
    upcomingKeys(
      applyAiringSchedule(flagged, 1, { status: 'FINISHED', nextEpisode: null, airDates: {} })
    ),
    []
  )
  assert.deepEqual(
    upcomingKeys(
      applyAiringSchedule(flagged, 1, {
        status: 'NOT_YET_RELEASED',
        nextEpisode: null,
        airDates: {}
      })
    ),
    ['1:1', '1:2']
  )
  assert.deepEqual(
    upcomingKeys(
      applyAiringSchedule(flagged, 1, { status: 'HIATUS', nextEpisode: null, airDates: {} })
    ),
    ['1:1']
  )
}

// A JSON round trip (the cache) turns airDates' keys into strings; the
// lookup must not care.
{
  const thawed = JSON.parse(JSON.stringify(SCHEDULE_NEXT_12))
  const applied = applyAiringSchedule([ep(1, 12)], 1, thawed)
  assert.equal(applied[0].released, '2026-09-17T15:30:00.000Z')
}

// ---------------------------------------------------------------------------
// The AniList node → schedule parser.

// The shape AniList returns for a show mid-season: airingAt in SECONDS, and
// the not-yet-aired schedule listing the next episode too.
{
  const schedule = airingScheduleFromNode({
    status: 'RELEASING',
    nextAiringEpisode: { episode: 12, airingAt: 1789918200 },
    airingSchedule: {
      nodes: [
        { episode: 12, airingAt: 1789918200 },
        { episode: 13, airingAt: 1790523000 },
        null,
        { episode: 0, airingAt: 1 },
        { episode: 14, airingAt: null }
      ]
    }
  })
  assert.deepEqual(schedule, {
    status: 'RELEASING',
    nextEpisode: 12,
    airDates: {
      12: new Date(1789918200 * 1000).toISOString(),
      13: new Date(1790523000 * 1000).toISOString()
    }
  })
}

// A finished show: no next episode, an empty schedule.
assert.deepEqual(
  airingScheduleFromNode({
    status: 'FINISHED',
    nextAiringEpisode: null,
    airingSchedule: { nodes: [] }
  }),
  { status: 'FINISHED', nextEpisode: null, airDates: {} }
)

// No node at all (AniList has no such id) is null, not an empty schedule —
// the caller caches the difference.
assert.equal(airingScheduleFromNode(null), null)
assert.equal(airingScheduleFromNode(undefined), null)

// ---------------------------------------------------------------------------
// When main asks AniList at all: while the season still has episodes to
// air, and not once every one is out.

assert.equal(
  seasonStillAiring([ep(1, 1), ep(1, 2)], 1, NOW),
  true,
  'placeholders with no dates: the schedule may date them'
)
assert.equal(
  seasonStillAiring(
    [ep(1, 1, { released: LAST_WEEK }), ep(1, 2, { released: '2026-09-17T15:30:00.000Z' })],
    1,
    NOW
  ),
  true,
  'an AniList instant still ahead: the schedule may move it'
)
assert.equal(
  seasonStillAiring([ep(1, 1, { released: LAST_WEEK }), ep(1, 2, { released: TOMORROW })], 1, NOW),
  false,
  "a bare calendar day ahead is the season's own source's plan, not the schedule's to refresh"
)
assert.equal(
  seasonStillAiring([ep(1, 1, { released: LAST_WEEK }), ep(1, 2, { released: YESTERDAY })], 1, NOW),
  false,
  'every episode out: nothing left to ask'
)
assert.equal(
  seasonStillAiring([ep(1, 1, { released: LAST_WEEK }), ep(2, 1)], 1, NOW),
  false,
  'only the season asked about counts'
)
assert.equal(
  seasonStillAiring([ep(0, 1), ep(0, -1, { unplayable: true })], 0, NOW),
  false,
  'specials and synthetic entries are never a reason to ask'
)

// ...and the second reason: what AniList last said. A finale whose stored
// air time has passed reads as fully aired, but a last read that still said
// RELEASING means it may have been postponed since — ask again. FINISHED
// (or CANCELLED) on the last read, or no read at all, leaves the list's own
// verdict as the only reason.
{
  // Instants: dates this module learned from AniList, which is what marks
  // the season as one the schedule speaks for (see seasonAcceptsSchedule).
  const allOut = [
    ep(1, 12, { released: '2026-09-09T15:30:00.000Z' }),
    ep(1, 13, { released: '2026-09-15T15:30:00.000Z' })
  ]
  const releasing = { status: 'RELEASING', nextEpisode: 13, airDates: {} }
  const finished = { status: 'FINISHED', nextEpisode: null, airDates: {} }
  assert.equal(scheduleWorthAsking(allOut, 1, releasing, NOW), true, 'a postponed finale')
  assert.equal(scheduleWorthAsking(allOut, 1, { ...releasing, status: 'HIATUS' }, NOW), true)
  assert.equal(scheduleWorthAsking(allOut, 1, finished, NOW), false, 'finished: never again')
  assert.equal(scheduleWorthAsking(allOut, 1, { ...finished, status: 'CANCELLED' }, NOW), false)
  assert.equal(scheduleWorthAsking(allOut, 1, { ...finished, status: null }, NOW), false)
  assert.equal(scheduleWorthAsking(allOut, 1, null, NOW), false, 'never read: nothing to go on')
  assert.equal(
    scheduleWorthAsking([ep(1, 13)], 1, null, NOW),
    true,
    'the list still airing is reason enough on its own'
  )
  // ...except against AniList's own terminal word: a grouped franchise whose
  // last season is dateless placeholders looks "still airing" by the list
  // forever, and must not stay on the request lane forever with it.
  assert.equal(
    scheduleWorthAsking([ep(1, 13)], 1, finished, NOW),
    false,
    'FINISHED beats undated placeholders'
  )
  assert.equal(
    scheduleWorthAsking([ep(1, 13)], 1, { ...finished, status: 'CANCELLED' }, NOW),
    false
  )
  assert.equal(isTerminalSchedule(finished), true)
  assert.equal(isTerminalSchedule(releasing), false)
  assert.equal(isTerminalSchedule(null), false)
}

// Whether the schedule may be applied to a season at all: its episodes must
// be numbered the way AniList's entry is. Undated episodes and AniList's own
// instants say so; a bare calendar day ahead of now says the season's own
// source (TMDB, whose seasons need not match; Kitsu's planned dates) is in
// charge, and the schedule stays out.
{
  const kitsuPartial = [ep(1, 1, { released: LAST_WEEK }), ep(1, 2)]
  const learned = [
    ep(1, 1, { released: LAST_WEEK }),
    ep(1, 2, { released: '2026-09-17T15:30:00.000Z' })
  ]
  const tmdbAhead = [ep(1, 1, { released: LAST_WEEK }), ep(1, 2, { released: TOMORROW })]
  const settled = [ep(1, 1, { released: LAST_WEEK }), ep(1, 2, { released: YESTERDAY })]
  assert.equal(
    seasonAcceptsSchedule(kitsuPartial, 1, NOW),
    true,
    'undated: only the schedule can date it'
  )
  assert.equal(seasonAcceptsSchedule(learned, 1, NOW), true, 'an instant it wrote before')
  assert.equal(seasonAcceptsSchedule(tmdbAhead, 1, NOW), false, 'its own source dates it ahead')
  assert.equal(seasonAcceptsSchedule(settled, 1, NOW), false, 'nothing for the schedule to settle')
  assert.equal(
    seasonAcceptsSchedule([...kitsuPartial, ep(1, 3, { released: TOMORROW })], 1, NOW),
    false
  )
  assert.equal(seasonAcceptsSchedule([ep(2, 1)], 1, NOW), false, 'another season is not this one')
  // ...and scheduleWorthAsking defers to it: a TMDB-numbered season with
  // its own future dates is never asked about, whatever AniList last said.
  assert.equal(scheduleWorthAsking(tmdbAhead, 1, null, NOW), false)
  assert.equal(
    scheduleWorthAsking(tmdbAhead, 1, { status: 'RELEASING', nextEpisode: 2, airDates: {} }, NOW),
    false
  )
}

// ---------------------------------------------------------------------------
// The renderer's side of the same question. isUpcomingEpisode decides
// whether a tile is a Play button; it must agree with hasAired about an
// episode airing LATER TODAY, which a calendar-day compare got wrong.

// Local noon on the 16th, built from local components so the date-only
// cases below (which parse to LOCAL midnight) hold in any timezone.
const LOCAL_NOON = new Date(2026, 8, 16, 12).getTime()
const LATER_TODAY = new Date(LOCAL_NOON + 3 * 60 * 60 * 1000).toISOString()
const EARLIER_TODAY = new Date(LOCAL_NOON - 3 * 60 * 60 * 1000).toISOString()

assert.equal(isFutureRelease('2026-09-16', LOCAL_NOON), false, 'dated today: out since midnight')
assert.equal(isFutureRelease('2026-09-17', LOCAL_NOON), true, 'dated tomorrow: still coming')
assert.equal(isFutureRelease(EARLIER_TODAY, LOCAL_NOON), false, 'an instant earlier today: out')
assert.equal(
  isFutureRelease(LATER_TODAY, LOCAL_NOON),
  true,
  'an instant later today is NOT out yet — the AniList broadcast moment'
)
assert.equal(isFutureRelease('', LOCAL_NOON), false)
assert.equal(isFutureRelease('not a date', LOCAL_NOON), false)

assert.equal(isUpcomingEpisode(ep(1, 1, { released: LATER_TODAY }), LOCAL_NOON), true)
assert.equal(isUpcomingEpisode(ep(1, 1, { released: EARLIER_TODAY }), LOCAL_NOON), false)
assert.equal(isUpcomingEpisode(ep(1, 1, { upcoming: true }), LOCAL_NOON), true, 'TBA')
assert.equal(isUpcomingEpisode(ep(1, 1), LOCAL_NOON), false, 'undated, unflagged: a gap')
assert.equal(
  isUpcomingEpisode(ep(1, 1, { released: EARLIER_TODAY, upcoming: true }), LOCAL_NOON),
  false,
  'the date wins over a stale flag here too'
)

// The grid and the shared rule give one answer for the episode airing
// later today: not playable, in both places.
assert.equal(hasAired(ep(1, 1, { released: LATER_TODAY }), LOCAL_NOON), false)
assert.equal(isUpcomingEpisode(ep(1, 1, { released: LATER_TODAY }), LOCAL_NOON), true)

// ...and for a bare calendar day, which every catalogue source hands over:
// both read it as the viewer's LOCAL day. hasAired used to read it as UTC
// midnight, so west of Greenwich the tile and the rule disagreed for the
// timezone's worth of hours around every release.
assert.equal(hasAired(ep(1, 1, { released: '2026-09-16' }), LOCAL_NOON), true, 'today: out')
assert.equal(hasAired(ep(1, 1, { released: '2026-09-17' }), LOCAL_NOON), false, 'tomorrow: not')
assert.equal(isUpcomingEpisode(ep(1, 1, { released: '2026-09-17' }), LOCAL_NOON), true)

// The stale-date clearing judges a bare day the same way, so a Kitsu date of
// "tomorrow" on an episode AniList says has aired (moved earlier) is cleared
// at the moment the tile would otherwise block it — not a timezone later.
{
  const applied = applyAiringSchedule(
    [ep(1, 11, { released: '2026-09-17' }), ep(1, 12)],
    1,
    { status: 'RELEASING', nextEpisode: 12, airDates: {} },
    LOCAL_NOON
  )
  assert.equal(applied[0].released, '', 'cleared: the tile would have read it as tomorrow')
  assert.equal(isUpcomingEpisode(applied[0], LOCAL_NOON), false)
  const kept = applyAiringSchedule(
    [ep(1, 11, { released: '2026-09-16' }), ep(1, 12)],
    1,
    { status: 'RELEASING', nextEpisode: 12, airDates: {} },
    LOCAL_NOON
  )
  assert.equal(kept[0].released, '2026-09-16', "today's date is consistent with aired: kept")
}

console.log('upcomingEpisodes: ok')
