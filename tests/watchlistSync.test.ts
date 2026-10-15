// The rule that stops two-way sync deleting somebody's list.
//
// docs/WATCHLIST-SYNC.md rule 2: a removal only propagates INWARD if this
// app saw the title arrive. "On the local list and not on Trakt" is an
// ambiguous state — it means either "you added it here and Trakt has not
// heard" or "you removed it there and this app has not heard" — and a
// snapshot cannot tell those apart. The origins record is what makes it
// answerable, and this pins the decision that reads it.
//
// The decision is tested rather than the pull: fetching needs three
// authenticated accounts, and what could actually destroy data is this
// judgement, not the HTTP around it.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  answeredServices,
  mayRemoveAt,
  plannedRemovals,
  remotePlanAdoptable,
  removalEvidence,
  startedHere,
  startedTitles
} from '../src/main/media-hub/watchlistRules'

const HOUR = 60 * 60 * 1000
const now = Date.now()

/** The accounts connected right now, as settingsStore's marks. An origin
 *  has to name one of these to justify anything — signing into a
 *  different account changes these strings and orphans every stamp. */
const ACCOUNTS = { simkl: 'simkl-a', trakt: 'trakt-a', mal: 'mal-a' }

/** The ordinary origin: pulled from Trakt, under the Trakt account that
 *  is still connected. */
const fromTrakt = { source: 'trakt' as const, addedAt: now - HOUR, account: ACCOUNTS.trakt }

// --- the case the whole rule exists for ------------------------------------

// Added HERE, never seen on any service. Absent from every list it has
// never been on — and must survive, because the answer is to push it, not
// to delete it. This is the one that would lose real data.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-local'],
    origins: {},
    sources: {},
    answered: new Set(['simkl', 'trakt', 'mal']),
    accounts: ACCOUNTS
  }),
  [],
  'a title added here is never removed by a pull, however long it is absent'
)

// Pulled from Trakt, now gone from Trakt. This app watched it arrive and
// watched it leave: established, not inferred.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
  }),
  ['tt-remote'],
  'a title this app pulled in, now gone from its source, is removed'
)

// --- rule 5: absence has to be an ANSWER ----------------------------------

// Trakt errored, so nothing it holds is known to be absent. Removing on
// that basis would let an outage read as "they emptied their watchlist".
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['simkl', 'mal']),
    accounts: ACCOUNTS
  }),
  [],
  'a service that did not answer cannot be the reason to delete anything'
)

// --- still on somebody's list ---------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: { 'tt-remote': ['simkl'] },
    answered: new Set(['simkl', 'trakt']),
    accounts: ACCOUNTS
  }),
  [],
  'a title still on another service has not left anywhere that counts'
)

// --- already gone locally --------------------------------------------------

assert.deepEqual(
  plannedRemovals({
    tracked: [],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
  }),
  [],
  'nothing to remove when it is already off the local list'
)

// --- a first sync cannot delete -------------------------------------------
//
// The property that makes this safe to ship: an account nobody has pulled
// from has no origins, so every local title is unexplained and none of
// them can be removed. Whatever else is wrong, the first run is harmless.
const firstSync = plannedRemovals({
  tracked: ['a', 'b', 'c', 'd'],
  origins: {},
  sources: { a: ['trakt'] },
  answered: new Set(['simkl', 'trakt', 'mal']),
  accounts: ACCOUNTS
})
assert.deepEqual(firstSync, [], 'a first sync against a fresh account removes nothing')

// --- whose account said so --------------------------------------------
//
// "It came from Trakt" is not enough to delete anything, because Trakt is
// not one person. Sign into a different Trakt and its watchlist says
// nothing at all about the titles the previous account contributed — but
// it IS a successful answer that does not contain them, which is exactly
// the shape the removal rule looks for. The account stamp is what stops
// somebody else's empty list emptying this one.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: { ...ACCOUNTS, trakt: 'trakt-b' }
  }),
  [],
  'a snapshot from a different account is not evidence about the first one'
)

// Records written before stamps existed name no account at all, so they
// can never be attributed to the person signed in now. They become
// ordinary unexplained titles — kept, pushed, never deleted.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR } },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS
  }),
  [],
  'an origin with no account on it cannot justify a removal'
)

// Nothing connected: every mark is the empty string. Empty must not
// compare equal to an origin's empty stamp and let a signed-out service
// delete things.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-remote'],
    origins: { 'tt-remote': { source: 'trakt', addedAt: now - HOUR, account: '' } },
    sources: {},
    answered: new Set(['trakt']),
    accounts: { simkl: '', trakt: '', mal: '' }
  }),
  [],
  'a disconnected service matches no stamp, not even an empty one'
)

// --- the outward half: which removals may be SENT ------------------------
//
// Simkl's removal endpoint is the one that also un-watches, because list
// membership and watched state are one record there. Sending it for a
// title Simkl never had would erase that account's watch history for it —
// so it goes only where this app has seen the title on the list.

assert.equal(
  mayRemoveAt('simkl', []),
  false,
  'no evidence the title is on Simkl means no unscoped removal is sent'
)
assert.equal(
  mayRemoveAt('simkl', ['trakt']),
  false,
  'evidence about Trakt is not evidence about Simkl'
)
assert.equal(mayRemoveAt('simkl', ['simkl', 'trakt']), true, 'seen on Simkl, so Simkl may be told')

// Scoped removals need no evidence: asking Trakt to drop something that
// is not on the watchlist drops nothing and touches no other record, and
// MAL's push checks the entry's status before deleting it.
assert.equal(mayRemoveAt('trakt', []), true, 'a watchlist-scoped removal is safe without evidence')
assert.equal(mayRemoveAt('mal', []), true, 'a status-scoped removal is safe without evidence')

// --- rule 8: a watched title outranks a planned one ---------------------

// Marking a planned title watched takes it off the plan without asking
// Simkl (whose removal is the un-watch call). The pull must then not put
// it back, however many services still list it as planned.
assert.equal(
  remotePlanAdoptable('tt-seen', {
    tracked: new Set(),
    awaitingRemoval: new Set(),
    watched: new Set(['tt-seen'])
  }),
  false,
  'a title with local history is never planned by a pull'
)
assert.equal(
  remotePlanAdoptable('tt-fresh', {
    tracked: new Set(),
    awaitingRemoval: new Set(),
    watched: new Set(['tt-seen'])
  }),
  true
)

// --- rule 6 of plannedRemovals: starting a show is not removing it ---------
//
// Simkl moves a show from plan to watch to "watching" on its first episode,
// and MAL to watching on the first progress push. The next pull finds it
// gone from every plan list — a successful answer that does not contain it,
// exactly the removal shape. Untracking it then would drop a show somebody
// is half way through out of Continue Watching.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-show'],
    origins: { 'tt-show': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS,
    started: new Set(['tt-show'])
  }),
  [],
  'a show started here is not removed because it left plan to watch'
)

// The set only ever holds shows, so a film gone from its source is removed
// as before — rule 8 is what takes a watched film off the plan.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-show', 'tt-film'],
    origins: { 'tt-show': fromTrakt, 'tt-film': fromTrakt },
    sources: {},
    answered: new Set(['trakt']),
    accounts: ACCOUNTS,
    started: new Set(['tt-show'])
  }),
  ['tt-film'],
  'a title not in the started set is unaffected by it'
)

// --- the evidence a removal is sent on, for a show watched here -----------
//
// Simkl's removal for a show is a bare reference to /sync/history/remove,
// which erases everything watched of it there. A show with viewings here is
// never sent that; the scoped services still are.
assert.deepEqual(removalEvidence(['simkl', 'trakt', 'mal'], false), ['simkl', 'trakt', 'mal'])
assert.deepEqual(removalEvidence(['simkl', 'trakt', 'mal'], true), ['trakt', 'mal'])
assert.equal(
  mayRemoveAt('simkl', removalEvidence(['simkl'], true)),
  false,
  'a started show is never removed from Simkl'
)
assert.equal(mayRemoveAt('simkl', removalEvidence(['simkl'], false)), true)

// --- what counts as started -----------------------------------------------
//
// The set the pull holds removals back for, and the question an un-plan asks
// before it sends Simkl its removal. A film is in neither, whatever has been
// watched of it: rule 8 is what takes a watched film off the plan, and both
// the pull's removal and the un-plan's request must still reach it. A merged
// anime's later season is planned under its own id and watched under the
// show's, so it is started when the show has viewings.
const groupOf = (id: string): string => (id === 'kitsu:2' ? 'kitsu:1' : id)
const startedSet = startedTitles({
  history: [
    { id: 'tt-film', type: 'movie' },
    { id: 'tt-show', type: 'series' },
    { id: 'kitsu:1', type: 'anime' },
    { id: 'tt-legacy' }
  ],
  tracked: ['tt-film', 'tt-show', 'kitsu:2', 'kitsu:9', 'tt-unwatched'],
  historyIdOf: groupOf
})
assert.deepEqual(
  [...startedSet].sort(),
  ['kitsu:1', 'kitsu:2', 'tt-legacy', 'tt-show'],
  'shows with viewings, a later season of one, and a row that cannot be shown to be a film'
)
assert.equal(startedSet.has('tt-film'), false, 'a watched film is never in the set')
// A later season whose show has only a FILM's history under that id is not
// started by it.
assert.deepEqual(
  [
    ...startedTitles({
      history: [{ id: 'kitsu:1', type: 'movie' }],
      tracked: ['kitsu:2'],
      historyIdOf: groupOf
    })
  ],
  []
)

const watchedIds = new Set(['tt-film', 'tt-show', 'kitsu:1'])
assert.equal(startedHere({ id: 'tt-show', type: 'series' }, watchedIds, groupOf), true)
assert.equal(
  startedHere({ id: 'kitsu:2', type: 'anime' }, watchedIds, groupOf),
  true,
  'through the show it belongs to'
)
assert.equal(
  startedHere({ id: 'tt-film', type: 'movie' }, watchedIds, groupOf),
  false,
  'a film is never started, so its un-plan is sent as before'
)
assert.equal(startedHere({ id: 'tt-other', type: 'series' }, watchedIds, groupOf), false)

// --- a list that was not read is not an answer -------------------------------

// The recurring pull leaves Simkl's lists unread when Simkl says nothing
// changed (watchSync.ts). Its report line then carries the counts of the last
// real read, with no error on it — which looks exactly like an answer, and
// must not be taken for one.
const unreadSimkl = [
  { service: 'simkl' as const, connected: true, pulled: 12, unmapped: 0, skipped: true },
  { service: 'trakt' as const, connected: true, pulled: 3, unmapped: 0 },
  { service: 'mal' as const, connected: false, pulled: 0, unmapped: 0 }
]
assert.deepEqual(
  [...answeredServices(unreadSimkl)],
  ['trakt'],
  'a skipped service has not answered, and neither has one that is not connected'
)
assert.deepEqual(
  [
    ...answeredServices([
      { service: 'simkl', connected: true, skipped: true, error: 'Too many requests' },
      { service: 'trakt', connected: true, error: 'timed out' }
    ])
  ],
  [],
  'nor one that could not be asked, nor one that failed'
)
assert.deepEqual(
  [...answeredServices([{ service: 'simkl', connected: true }])],
  ['simkl'],
  'one that was read and held nothing HAS answered (rule 5)'
)

// What that buys, through the rule itself. Two titles pulled from Simkl,
// one of them also on Trakt until a moment ago; Trakt answered this pass,
// Simkl was not read. The tags Simkl's last read left behind are carried
// over by the pull, so `sources` still shows the first title there.
const fromSimkl = { source: 'simkl' as const, addedAt: now - HOUR, account: ACCOUNTS.simkl }
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-on-simkl', 'tt-left-simkl-earlier', 'tt-trakt-only'],
    origins: {
      'tt-on-simkl': fromSimkl,
      // Gone from Simkl at its last read, kept then because Trakt had it.
      'tt-left-simkl-earlier': fromSimkl,
      'tt-trakt-only': fromTrakt
    },
    sources: { 'tt-on-simkl': ['simkl'] },
    answered: answeredServices(unreadSimkl),
    accounts: ACCOUNTS
  }),
  ['tt-trakt-only'],
  'an unread Simkl removes nothing that came from Simkl; Trakt, which answered, still can'
)
// The failure this guards against, spelled out: the same pass with the
// unread Simkl miscounted as an answer that held nothing.
assert.deepEqual(
  plannedRemovals({
    tracked: ['tt-on-simkl'],
    origins: { 'tt-on-simkl': fromSimkl },
    sources: {},
    answered: new Set(['simkl', 'trakt']),
    accounts: ACCOUNTS
  }),
  ['tt-on-simkl'],
  'answered-and-empty is a removal — which is why unread must never become it'
)

console.log('ok  watchlist two-way removal rule')

// --- the pull itself, against a real database --------------------------
//
// The rules above are only as good as what the pull hands them. These run
// watchlists.ts's syncPlannedFromServices against a temporary database with
// the services' answers faked at fetch, for the cases where what came back
// is not the answer it looks like: a list cut off part way (Trakt, MAL), an
// anime entry nobody could look up, a merged anime's later season watched
// here, and an anime un-planned here that Simkl, which is never sent an
// anime removal, still lists.
//
// watchlists.ts reaches Electron through its imports, so 'electron' is the
// headless stand-in, as tests/accountMarks.test.ts loads it. Tokens are in
// the settings store's "plain:" form.

process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-watchlist-pull-'))
process.env.R3_ELECTRON_SHIM = '1'
const shim = pathToFileURL(
  path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
    return next(specifier, context)
  }
})

const plain = (value: string): string => `plain:${Buffer.from(value, 'utf8').toString('base64')}`
const DAY = 24 * 60 * 60 * 1000

/** What a fake service says to one request: a JSON body, a body cut off
 *  part way, or a failure status. */
type Answer = unknown | { cut: string } | { status: number }

function respond(answer: Answer): Response {
  const shaped = answer as { cut?: string; status?: number }
  if (shaped && typeof shaped === 'object' && typeof shaped.cut === 'string') {
    const bytes = new TextEncoder().encode(shaped.cut)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.error(new Error('connection reset'))
      }
    })
    return new Response(stream, { status: 200 })
  }
  if (shaped && typeof shaped === 'object' && typeof shaped.status === 'number') {
    return new Response('', { status: shaped.status })
  }
  return new Response(JSON.stringify(answer), { status: 200 })
}

async function pulls(): Promise<void> {
  const store = await import('../src/main/media-hub/settingsStore')
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { setDatabase } = await import('../src/main/media-hub/dbState')
  const seasons = await import('../src/main/media-hub/animeSeasons')
  const watchlists = await import('../src/main/media-hub/watchlists')

  const db = createDatabase(path.join(process.env.R3_USER_DATA!, 'pull.sqlite'), 'profile-pull')
  setDatabase(db)

  // What each service answers, by path; anything unlisted fails, so a
  // request the test did not expect cannot quietly pass as an answer.
  let answers: Record<string, Answer> = {}
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const key = `${url.host}${url.pathname}`
    return key in answers ? respond(answers[key]) : new Response('', { status: 503 })
  }) as typeof fetch

  const connect = (services: { simkl?: boolean; trakt?: boolean; mal?: boolean }): void =>
    store.writeSettings({
      ...(services.simkl ? { simklClientId: 'cid', simklAccessToken: plain('simkl') } : {}),
      ...(services.trakt ? { traktClientId: 'tid', traktAccessToken: plain('trakt') } : {}),
      ...(services.mal
        ? { malAccessToken: plain('mal'), malTokenExpiresAt: Date.now() + 30 * DAY }
        : {})
    })
  const reset = (): void => {
    for (const id of db.tracked().map((item) => String(item.id))) db.untrack(id)
    for (const key of [
      'planned:origins',
      'planned:sources',
      'planned:pending-removals',
      'planned:unplanned-anime'
    ]) {
      db.deleteCache(key)
    }
  }
  /** A title planned here by an earlier pull from `source`. */
  const pulledEarlier = (
    id: string,
    type: 'movie' | 'anime',
    source: 'simkl' | 'trakt' | 'mal'
  ) => {
    db.track({ id, type, title: id })
    const origins = {
      [id]: { source, addedAt: Date.now() - DAY, account: store.trackingAccountMarks()[source] }
    }
    db.putCache('planned:origins', origins, 365 * DAY, { durable: true })
  }
  const SIMKL = 'api.simkl.com'
  const simklLists = (anime: unknown[]): Record<string, Answer> => ({
    [`${SIMKL}/sync/all-items/movies/plantowatch`]: { movies: [] },
    [`${SIMKL}/sync/all-items/shows/plantowatch`]: { shows: [] },
    [`${SIMKL}/sync/all-items/anime/plantowatch`]: { anime }
  })
  const MAL_LIST = 'api.myanimelist.net/v2/users/@me/animelist'
  /** What idBridge caches for a MAL id: the Kitsu id, or 0 for "none". */
  const bridged = (malId: number, kitsuId: number): void =>
    db.putCache(`idbridge:rev:mal:${malId}`, kitsuId, 30 * DAY)

  // ---- Trakt's watchlist cut off part way ---------------------------------
  reset()
  connect({ trakt: true })
  pulledEarlier('tt-from-trakt', 'movie', 'trakt')
  answers = {
    'api.trakt.tv/sync/watchlist/movies': { cut: '[{"movie":{"title":"Dune","ids":' },
    'api.trakt.tv/sync/watchlist/shows': []
  }
  let report = await watchlists.syncPlannedFromServices('interactive')
  const trakt = report.services.find((entry) => entry.service === 'trakt')
  assert.ok(trakt?.error, 'a cut-off Trakt watchlist is an error')
  assert.equal(answeredServices(report.services).has('trakt'), false)
  assert.equal(report.removed, 0)
  assert.ok(db.isTracked('tt-from-trakt'), 'a cut-off Trakt watchlist un-plans nothing')
  // The same pass with the list read whole and empty: the removal it is.
  answers['api.trakt.tv/sync/watchlist/movies'] = []
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.equal(report.removed, 1)
  assert.equal(db.isTracked('tt-from-trakt'), false, 'answered and empty is a removal')

  // ---- MyAnimeList's plan to watch cut off, or with no list in it -----------
  for (const broken of [{ cut: '{"data":[{"node":{"id":1' }, {}] as Answer[]) {
    reset()
    connect({ mal: true })
    pulledEarlier('kitsu:900', 'anime', 'mal')
    answers = { [MAL_LIST]: broken }
    report = await watchlists.syncPlannedFromServices('interactive')
    assert.ok(report.services.find((entry) => entry.service === 'mal')?.error)
    assert.equal(answeredServices(report.services).has('mal'), false)
    assert.ok(db.isTracked('kitsu:900'), 'a MAL list that is not a whole answer un-plans nothing')
  }
  answers = { [MAL_LIST]: { data: [], paging: {} } }
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.equal(db.isTracked('kitsu:900'), false, 'a whole, empty MAL list is a removal')

  // ---- an anime entry the id bridge could not be asked about ---------------
  // Simkl lists the anime this app pulled from it, but its MAL id cannot be
  // looked up (Simkl's search and Kitsu's mapping both fail). Left out of the
  // pulled set, it looked removed; Simkl must not count as having answered.
  reset()
  connect({ simkl: true })
  pulledEarlier('kitsu:5000', 'anime', 'simkl')
  db.deleteCache('idbridge:rev:mal:100')
  answers = simklLists([{ show: { title: 'Planned', ids: { mal: 100 } } }])
  report = await watchlists.syncPlannedFromServices('interactive')
  const simkl = report.services.find((entry) => entry.service === 'simkl')
  assert.match(String(simkl?.error), /could not be looked up/)
  assert.equal(answeredServices(report.services).has('simkl'), false)
  assert.ok(db.isTracked('kitsu:5000'), 'an unanswered lookup removes nothing')
  // Answered with "no Kitsu id" is an answer: counted as unmapped, and the
  // title it might have been is gone from a list that answered.
  bridged(100, 0)
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.equal(report.services.find((entry) => entry.service === 'simkl')?.unmapped, 1)
  assert.equal(db.isTracked('kitsu:5000'), false)

  // ---- a merged anime's later season, watched here --------------------------
  // SHOW fronts a group whose second member is its second season. Its
  // viewings are kept under SHOW at season 2, never under SEASON_2's own id.
  const SHOW = 'kitsu:11469'
  const SEASON_2 = 'kitsu:12268'
  db.putCache('catalog:v2:anime', [{ id: SHOW, groupedIds: [SEASON_2] }], DAY)
  db.putCache(seasons.ANIME_GROUPED_KEY, true, DAY)
  db.putCache('kitsu:tvdb:11469', { seriesId: '305074', season: 1 }, 30 * DAY)
  db.putCache('kitsu:tvdb:12268', { seriesId: '305074', season: 2 }, 30 * DAY)
  seasons.invalidateAnimeGroupIndex()
  assert.deepEqual(seasons.placeAnimeEntry(SEASON_2), { id: SHOW, season: 2 })
  bridged(201, 12268)
  const watchedAt = new Date().toISOString()
  // Only the first season watched: the second is still a plan.
  reset()
  connect({ mal: true })
  db.importWatched([{ id: SHOW, type: 'anime', title: 'Show', season: 1, episode: 1, watchedAt }])
  answers = {
    [MAL_LIST]: {
      data: [{ node: { id: 201, title: 'Season 2' }, list_status: { status: 'plan_to_watch' } }],
      paging: {}
    }
  }
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.ok(db.isTracked(SEASON_2), 'an unwatched later season is planned')
  // Watched here: not planned again, however long MyAnimeList lists it.
  reset()
  db.importWatched([{ id: SHOW, type: 'anime', title: 'Show', season: 2, episode: 1, watchedAt }])
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.equal(report.added, 0)
  assert.equal(db.isTracked(SEASON_2), false, 'a watched later season is not planned again')

  // ---- an anime un-planned here that Simkl still lists ----------------------
  reset()
  connect({ simkl: true })
  bridged(300, 7000)
  const ANIME = { id: 'kitsu:7000', type: 'anime' as const, title: 'Planned at Simkl' }
  answers = simklLists([{ show: { title: ANIME.title, ids: { mal: 300 } } }])
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.ok(db.isTracked(ANIME.id), 'arrives from Simkl')
  // Un-planned here. Simkl is sent nothing for anime, so it still lists it.
  db.untrack(ANIME.id)
  await watchlists.applyLocalPlanChange(ANIME, false)
  report = await watchlists.syncPlannedFromServices('interactive')
  assert.equal(db.isTracked(ANIME.id), false, 'not planned again while Simkl still lists it')
  // Planned here again: the marker goes, so a later un-plan starts afresh.
  db.track(ANIME)
  await watchlists.applyLocalPlanChange(ANIME, true)
  const markers = db.getCache<Record<string, unknown>>('planned:unplanned-anime', {
    allowExpired: true
  })
  assert.equal(markers?.[ANIME.id], undefined, 'planning it here again clears the marker')
  // Un-planned again, then gone from Simkl: the marker is cleared, so the
  // anime planned at Simkl afresh later comes back here.
  db.untrack(ANIME.id)
  await watchlists.applyLocalPlanChange(ANIME, false)
  answers = simklLists([])
  await watchlists.syncPlannedFromServices('interactive')
  answers = simklLists([{ show: { title: ANIME.title, ids: { mal: 300 } } }])
  await watchlists.syncPlannedFromServices('interactive')
  assert.ok(db.isTracked(ANIME.id), 'planned at Simkl afresh after it left, it is planned here')
  // Un-planned from a card that carried no type, which trackingToggle sends
  // as a film: still marked, by its Kitsu id, so not planned again.
  db.untrack(ANIME.id)
  await watchlists.applyLocalPlanChange({ ...ANIME, type: 'movie' }, false)
  await watchlists.syncPlannedFromServices('interactive')
  assert.equal(db.isTracked(ANIME.id), false, 'an anime un-planned as a film is still held back')

  console.log('ok  the plan pull against a real database')
}

pulls().catch((error) => {
  console.error(error)
  process.exit(1)
})
