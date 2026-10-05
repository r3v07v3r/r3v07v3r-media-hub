export const meta = {
  name: 'tracking-pipeline-map',
  description: 'Map how catalogue, tracking sync, collections and status actions really work, against the owner\'s expected pipeline',
  phases: [
    { title: 'Map', detail: 'eight read-only mappers, one per subsystem, each answering the owner\'s expectations with file:line evidence', model: 'sonnet' },
  ],
}

const CTX = `
CONTEXT (read fully)
Repo: r3v07v3r/r3v07v3r-media-hub: an Electron desktop app for browsing, tracking and playing movies, series and anime; an Android phone/TV app that reuses the backend headless; a LAN cache daemon ("r3-cache"). Your working directory is a git worktree at origin/preview (the integration branch). Two pull requests are open on top of it, as local branches: pr-189 (later seasons of a merged anime never recommended; Hide watched in the Anime grid) and pr-190 (the phone catch-up, MyAnimeList push/import and Trakt import stop filing by a member's position alone). See them with: git diff origin/preview...pr-189 --stat (or pr-190).

Useful maps (verify against code; docs can be stale): README.md, docs/WATCHLIST-SYNC.md (595 lines, the sync rules), docs/AUDIT-2026-09-27.md (feature audit written from code), docs/CONSISTENCY_AUDIT.md, android/README.md, daemon/README.md. Backend: src/main/media-hub/*.ts (database.ts, tracking.ts, catalog.ts, core.ts, watchlists.ts, watchSync.ts, simkl*.ts, trakt*.ts, mal*.ts, anilist.ts, animeSeasons.ts, collection.ts ...), shared logic: src/shared/media-hub/*.ts, IPC: src/main/ipc, desktop UI: src/renderer/src, phone/TV UI: src/app-ui, headless backend for Android: src/headless, tests: tests/*.test.ts.

THE OWNER'S EXPECTED PIPELINE (Graham). He wants to know, for each point, whether the system does this, and if not, why not and whether what it does instead is more efficient:
E1  There is a local database behind the desktop app. (He is not sure whether the phone app has one.)
E2  Opening the app shows a full catalogue, and searching for absolutely anything always returns it. A title must never be missing just because it has not been cached locally.
E3  When a tracking service is connected (Simkl, Trakt, or another), its watched state, plan-to-watch list and the episode the user is on, for movies, series and anime, are pulled down into the local database.
E4  With several services: after Simkl is synced and Trakt is connected later, where Trakt disagrees with what is held locally (example: local and Simkl say season 1 episode 8, Trakt says season 2 episode 2), a synchronisation dialog shows each difference and lets the user choose which value to keep.
E5  The chosen value is then written back to the service that disagreed (in the example Trakt is changed to season 1 episode 8), so both services and the local database agree.
E6  Every time the app opens it quickly checks each connected service against the local database, so something watched elsewhere arrives.
E7  Finishing an episode in the local player, or marking an episode or a movie as watched, pushes that update to every connected tracking service.
E8  Collections: seven seasons of a series are ONE poster card, not seven, with an average rating across seasons or a "collection" marker; the user drills in.
E9  Inside a collection: season 0 / specials, season 1, a filler movie that sits between seasons 2 and 3, and so on, each in its place.
E10 A collection can be ordered by release order or by chronological (story) order. He accepts this may be desktop-only.
E11 "Not interested" / disliking a title should be quick to do. Today he finds it difficult.
E12 Marking a title as planned from the main list must not make it jump out of the view he is focused on; he wants to be able to flip it back if he clicked by mistake.
E13 None of this may break the other moving parts: the local caching server, stream cache, title index, rooms/party, backups, profiles.
E14 Efficiency: wherever the implementation differs from the description, is it cheaper or more expensive (network calls, API quota, database work, time to first paint)?

RULES
- Read-only. Do not edit files, do not commit, do not run builds or the app. You may run a single test file with "npx tsx tests/<name>.test.ts" if it settles a question ("npm" itself is blocked on this machine).
- Describe what the CODE on origin/preview does, with file:line evidence for every claim that matters. Where pr-189 or pr-190 changes the answer, say so in prImpact.
- Verdicts: "matches" (does what he expects), "exceeds" (does it, and more or more efficiently), "partial" (some of it), "differs" (deliberately does something else), "missing" (not there). When "differs", explain the reason the code or docs give, and judge whether that reason is sound.
- Be specific and concrete. Use the product's real names for things. No padding, no generic advice. If you did not read something, do not claim it.
- ownerQuestions: only decisions that genuinely need the owner (a choice between behaviours), phrased so he can answer in a few words, each with your recommended answer.
`

const MAP = {
  type: 'object',
  properties: {
    area: { type: 'string' },
    howItWorks: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['matches', 'exceeds', 'partial', 'differs', 'missing', 'not-applicable'] },
          actual: { type: 'string' },
          whyDiffers: { type: 'string' },
          efficiency: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'integer' }, note: { type: 'string' } },
              required: ['file', 'note'],
            },
          },
        },
        required: ['id', 'verdict', 'actual', 'evidence'],
      },
    },
    surprises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
        },
        required: ['title', 'detail'],
      },
    },
    ownerQuestions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    prImpact: { type: 'string' },
  },
  required: ['area', 'howItWorks', 'requirements', 'surprises', 'ownerQuestions', 'risks', 'prImpact'],
}

const MAPPERS = [
  {
    key: 'catalogue-search',
    prompt: `YOUR AREA: the catalogue and search on the DESKTOP app. Answer E1 (what the database is: engine, file, the main tables for catalogue/index/history/tracking) and E2, and E14 for search.
Trace end to end: what "the catalogue" is made of (which upstream sources: Cinemeta, Kitsu, TMDB, Simkl, AniList, the daemon's title index...), what is stored locally and how it gets there (crawls, background jobs, the LAN daemon's title sync, sizes), and what is fetched live. Then the search path: renderer search box -> IPC -> src/shared/media-hub/titleSearch.ts and callers -> each source. Start at: src/main/media-hub/catalog.ts, database.ts (index tables and indexQuery), core.ts, credits.ts, src/shared/media-hub/titleSearch.ts, catalogMerge.ts, catalogFilters.ts, tests/titleSearch.test.ts, tests/catalogIndex.test.ts, tests/catalogQuery.test.ts, tests/catalogSources.test.ts, and the renderer's search UI under src/renderer/src.
Answer precisely: (a) when the user types a title that is NOT in the local index, what happens: which remote sources are asked, in what order, merged how, and what the user sees while waiting; (b) list every concrete way a real, existing title can FAIL to appear in search results (offline, a source down or rate-limited, kind filter, year/alternate/foreign title, short queries, a merged anime's later season hidden behind its show, unsafe/adult filter, an id that cannot be bridged to IMDb/TMDB, result caps, debounce/cancel races) with evidence; (c) the browse grids (Movies/Series/Anime pages with filters, sorts, Hide watched): are they limited to the locally stored index, so "a full catalogue" there means "what has been crawled"? how complete is that and what decides it; (d) can a title found only by remote search be opened, tracked and played like any other (is it written into the index when opened?); (e) cost of a search (calls per keystroke, caching).`,
  },
  {
    key: 'phone-tv',
    prompt: `YOUR AREA: the Android phone / TV app. Answer E1, E2, E3, E6, E7, E8-E10 and E11-E12 AS THEY APPLY TO THE PHONE/TV APP.
Start at: android/README.md, src/app-ui (App.tsx, screens/Home|Browse|Search|Title|Player|Settings.tsx, lib/api.ts, lib/librarySync.ts, lib/nativeHost.ts), src/headless (main.ts, bridge.ts, electronShim, stubs), src/main/backend.ts, src/main/media-hub/simklCatchUp.ts and simklCatchUpRules.ts, devicePairing*.ts, the "catch-up on the phone and TV app" section of docs/WATCHLIST-SYNC.md, tests/simklCatchUp.test.ts, tests/headlessBridge.test.ts.
Answer precisely: (a) architecture: what runs on the device (is the desktop backend from src/main running headless inside the APK? which database engine and file; is it the same schema as the desktop?), and what "linked to a computer" changes; (b) does the phone hold its own tracking data, and where does it come from (its own Simkl sign-in? the desktop? both?). Which services can be connected ON the phone: Simkl, Trakt, MyAnimeList, AniList? (c) what the catch-up pulls (watched, plan to watch, in-progress, anime), when it runs, and what it deliberately leaves out; (d) does watching or marking on the phone push to the services and/or to the desktop; (e) how search and browsing work on the phone: same sources as desktop? what is missing; (f) which desktop features have no phone equivalent yet (collections/merged anime shows, status actions such as planned / not interested / rating, sync dialogs, custom lists); (g) any place where phone and desktop can disagree about the same title (ids, merged shows, seasons).`,
  },
  {
    key: 'service-pull',
    prompt: `YOUR AREA: pulling a tracking service's data DOWN into the local database on the desktop. Answer E3, E6 and E14.
Services to cover, each separately: Simkl, Trakt, MyAnimeList, AniList, and any file imports (Letterboxd, CSV), plus Jellyfin if it feeds watched state. Start at: src/main/media-hub/simkl.ts, simklClient.ts, simklKeyedHistory.ts, trakt.ts, traktClient.ts, mal.ts, malSync.ts, anilist.ts, letterboxdImport.ts, watchlists.ts, remoteLists.ts, watchSync.ts, watchlistRules.ts, tracking.ts, backgroundJobs.ts, taskScheduler.ts, database.ts (history / tracking / watchlist tables), src/shared/media-hub/reconcileQueue.ts, importCsv.ts, docs/WATCHLIST-SYNC.md ("When Simkl's lists are read"), tests/watchlistSync.test.ts, tests/watchSync.test.ts, tests/reconcileSync.test.ts, tests/traktImport.test.ts, tests/mal.test.ts, tests/simklKeyedHistory.test.ts.
For EACH service give a row: what kinds it covers (movies/series/anime); what is pulled (watched movies, watched episodes per season, plan to watch, dropped/on hold, ratings, in-progress position); WHEN (on connect, on every launch, on a timer, on window focus, only when the user presses a button); whether it is automatic or a one-off manual import; whether it is incremental (activity timestamps, date_from, etags) or a full download each time; how many API calls a typical launch costs; where the rows land (table, how the source service/account is recorded); what is deliberately NOT pulled and why.
Then answer: does opening the app really check every connected service (E6), or only Simkl? If a user has only Trakt (no Simkl), what stays in sync automatically? How is the user's "current episode" represented locally: a set of watched-episode rows (so "the episode I am on" is derived), or a stored pointer? That matters for E4. Also note any path that is fire-and-forget or can silently drop data (failed pull, partial pull, rate limit).`,
  },
  {
    key: 'reconcile',
    prompt: `YOUR AREA: what happens when two sources DISAGREE: the reconciliation and any synchronisation dialog. Answer E4 and E5.
Start at: src/shared/media-hub/reconcileQueue.ts, tests/reconcileSync.test.ts, src/main/media-hub/watchSync.ts, watchlistRules.ts, watchlists.ts, malSync.ts (the MyAnimeList sync preview), trakt.ts / traktClient.ts (the Trakt import), simkl.ts, tracking.ts, docs/WATCHLIST-SYNC.md (rules 1-8, especially "Local always wins a genuine conflict"), and the renderer: search src/renderer/src for the sync / import / preview / reconcile dialogs (components/settings, components/overlays, components/mystuff) and the IPC channels they call (src/shared/media-hub/ipc-channels.ts, src/main/ipc/mediaHub.ts, src/main/media-hub/appIpc.ts).
Answer precisely: (a) which dialogs exist today where the user sees differences and chooses: for which service, what exactly is listed (per title? per season? counts?), what choices are offered (pull, push, skip, per item or all at once); screenshots are not needed, quote the component and its props/state; (b) the owner's exact scenario: Simkl connected and synced, then Trakt connected, Trakt has S2E2 for a series where local has up to S1E8. What does the code do, step by step? Is anything shown? What ends up in the local database, and is anything sent to Trakt or Simkl afterwards? (c) the reverse (Trakt is BEHIND local); (d) the same for a movie watched on one and not the other, and for plan-to-watch differences; (e) can the app ever REMOVE watched episodes from a service to bring it down to a lower value (what E5 asks for in the example), and what are the stated reasons where it refuses to; (f) is progress modelled as a set of watched episodes (union on merge) rather than "the episode I am on"? If so, explain plainly why "which value do you want" is a different question under that model, and what a per-item choice dialog would have to do; (g) the conflict rules in force (local wins? newest wins? union?) and where each is implemented; (h) what a second or third service would need for one shared reconcile step (is there a common abstraction over services, or is each service its own code path?).`,
  },
  {
    key: 'push',
    prompt: `YOUR AREA: pushing local changes UP to the tracking services. Answer E7, the push half of E5, and E14.
Start at: src/main/media-hub/playbackProgress.ts, playbackSession.ts, playback.ts, tracking.ts (marking watched/unwatched, episodes, seasons, movies), watchSync.ts, titlePushQueue.ts, watchlistPush.ts, watchlists.ts, simkl.ts, simklClient.ts, trakt.ts, traktClient.ts, mal.ts, malSync.ts, anilist.ts, src/shared/media-hub/serviceIds.ts, serialQueue.ts, reconcileQueue.ts, docs/WATCHLIST-SYNC.md, tests/watchSync.test.ts, tests/watchlistSync.test.ts, tests/trakt.test.ts, tests/mal.test.ts, tests/simklAnime.test.ts.
Build a matrix: rows = user actions (episode finishes in the player; episode marked watched by hand; episode unmarked; whole season marked; movie marked/unmarked; title set to planned; planned removed; dropped / not interested; rating given; playback position mid-episode), columns = Simkl, Trakt, MyAnimeList, AniList. Each cell: pushed immediately / queued / batched on a timer / only on manual sync / never, with file:line. Then: what counts as "finished" (threshold); what happens to a push when offline or the service errors (retry queue persisted across restarts? fire-and-forget? is the user told?); ordering guarantees; de-duplication; what happens to pushes for a merged anime show (one show locally, one entry per season at the service) and where a push is deliberately NOT sent (pr-190 extends this: summarise); whether a watch made on the phone reaches the services; rate-limit handling. Finally say plainly which connected services would NOT learn about an episode watched in the local player today.`,
  },
  {
    key: 'collections',
    prompt: `YOUR AREA: grouping titles into collections and ordering inside them. Answer E8, E9, E10.
Start at: src/main/media-hub/collection.ts, animeSeasons.ts, animeRegroup.ts, animeStory.ts, continuations.ts, catalog.ts, database.ts, src/shared/media-hub/serviceIds.ts, catalogMerge.ts, nextEpisode.ts, upcomingEpisodes.ts, docs/WATCHLIST-SYNC.md ("Anime: one show here, an entry per season at Simkl" and the sections after it), tests/animeRegroup.test.ts, tests/laterSeasonCards.test.ts, tests/simklAnime.test.ts, tests/continuations.test.ts, and the renderer: the poster card and the detail page (src/renderer/src/components/media, components/detail, routes) for how a show, its seasons, specials and related films are drawn.
Answer precisely, separately for (1) ordinary series, (2) anime, (3) movies/film franchises: (a) is one card shown per series with seasons inside? For anime, where the upstream catalogue (Kitsu/Simkl/MAL) has one entry per season, how are they merged into one show, on what evidence (TheTVDB/TMDB mappings?), and how many are NOT merged and so still show as separate cards; (b) what the card shows: is there an average rating across seasons, a season count, a "collection" marker? (c) inside the page: are specials / season 0 shown; do films and OVAs that belong between seasons appear in place, in a separate rail, or not at all; what is "the story" (animeStory.ts) and "continuations"; (d) is there any choice of ordering (release / chronological / story order), where does the order come from, and what data would a chronological order need that the app does not hold; (e) movie collections (e.g. a film series): does collection.ts do this, from which source, and where is it shown; (f) the rule "a member's place is not its page season" (PRs 188, 189, 190): explain in plain words what goes wrong when a film or OVA sits among the seasons of a TMDB-numbered show, how many titles it affects per the docs/PR text, and whether a first-class "collection with ordered members of mixed kinds" model would remove that class of problem or just move it; (g) what the phone app shows for the same show.`,
  },
  {
    key: 'status-ux',
    prompt: `YOUR AREA: the quick status actions in the desktop UI and what the lists do when a status changes. Answer E11 and E12.
Start at: src/main/media-hub/titleStatusRules.ts, tracking.ts (status, hidden, not interested, ratings), watchlists.ts, src/shared/media-hub/rating.ts, catalogFilters.ts, tests/titleStatus.test.ts, tests/ratings.test.ts, and the renderer: the poster card and its hover/context actions (src/renderer/src/components/media, components/category, components/home, components/mystuff, components/detail, components/overlays), hooks and context that hold lists (src/renderer/src/hooks, context, lib/mediaHub), and the "library:changed" push from the backend (grep for it across src) that makes lists refresh.
Answer precisely: (a) every status a title can have (unwatched / planned / watching / watched / dropped / hidden / not interested / liked / disliked / rated...), how each is stored, and which are mutually exclusive; (b) for each status, every place in the UI it can be set and the number of clicks from a poster in a grid (hover button? right-click menu? only on the detail page? keyboard?). Specifically: how does the user say "not interested" or "dislike" today, how many steps, and what does it do afterwards (hide from recommendations? from grids? pushed to a service?); can it be undone and from where; (c) the jump: when a title is marked planned (or watched, or hidden) from a grid or a Home row, what happens to that card: trace the state update, the backend write, the library:changed event, and the re-query. Does the card disappear or move because the list is re-filtered (Hide watched, plan filters), re-sorted, or rebuilt (Home rows such as Recommended dropping saved titles)? List each list/row and whether a status change makes the card leave it immediately; (d) is there any undo affordance (toast with Undo, the card staying until the page is left, an optimistic toggle)? (e) what the cheapest change would be to keep a just-changed card in place until the user navigates away, and any existing pattern in the code that already does this somewhere; (f) the same questions, briefly, for the phone/TV UI (src/app-ui).`,
  },
  {
    key: 'coupling',
    prompt: `YOUR AREA: what else depends on title identity, seasons, grouping and watched state, so that changes to tracking sync or to collections do not break it. Answer E13.
Start at: src/main/media-hub/lanCache.ts, lanCacheFeeder.ts, lanCacheTitleSync.ts, lanCacheDiscovery.ts, streamCache.ts, streamTierRules.ts, mediaSources.ts, torbox.ts, idBridge.ts, src/shared/media-hub/serviceIds.ts, src/shared/lancache, daemon/ (titles.ts, titleCrawler.ts, fetcher.ts, storage.ts, server.ts), playbackSession.ts, playbackProgress.ts, nextEpisode logic, recommendations.ts, calendar.ts, notifications.ts, rooms.ts / party.ts / watchParty.ts (what identifies the thing being watched together), jellyfin.ts, backup.ts, migrations.ts, profiles.ts, database.ts (keys and foreign relations of history/tracking/index tables), docs/CACHE-PERMISSIONS.md, docs/AUDIT-2026-09-27.md (it lists known defects such as an anime LAN cache key mismatch: check which are fixed on preview).
Produce a dependency map: for each subsystem, WHAT KEY it uses to identify a title/episode (imdb id, kitsu id, "show id + season + episode", file hash, stream url...), where that key is derived, and what would break if (1) an anime's grouping changes (a season joins or leaves a merged show), (2) watched rows are rewritten by a reconcile step (moved between ids/seasons, or removed to match a service), (3) a "collection" layer is added above shows, (4) the tracking tables gain a per-service source column or a conflicts table. Note for each whether tests cover it (name the test file) and whether a database migration + backup/restore path exists for such a change (migrations.ts, backup.ts, tests/migrations.test.ts, tests/backup.test.ts). Also list the invariants the docs or code comments state must hold (e.g. nothing deleted on a failed pull; everything stamped with the account it came from; per-profile separation) with file:line, and any place where sync work can block or slow startup, playback or the cache daemon.`,
  },
]

phase('Map')
const maps = (
  await parallel(
    MAPPERS.map((m) => () =>
      agent(`${CTX}\n${m.prompt}`, {
        label: `map:${m.key}`,
        phase: 'Map',
        model: 'sonnet',
        effort: 'high',
        schema: MAP,
      }).then((r) => (r ? { key: m.key, ...r } : null)),
    ),
  )
).filter(Boolean)

log(`${maps.length}/${MAPPERS.length} maps returned`)
return { maps }
