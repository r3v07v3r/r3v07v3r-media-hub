# Roadmap

Roughly sixty things competing apps do that this one does not, sequenced into seven phases and
grounded in what the code already holds.

The constraint matters as much as the list. Every item below lands inside a surface that already
exists, and nothing new is allowed onto the launch path. An app that gains sixty features and loses
its speed has not caught up with anything.

Competitors this was measured against: Stremio, Plex, Jellyfin, Emby, Infuse, Kodi, Trakt, Simkl,
Letterboxd, AniList, MyAnimeList, Overseerr/Jellyseerr, Sonarr/Radarr, Teleparty, and the consumer
streaming apps people compare everything to.

## Progress

Thirty features shipped. Sixteen merged as PR #105 and released in
`v1.0.83-preview.70`; everything since — collection pages, content ratings,
fixes from hands-on testing of that build, Trakt in both directions, saved
filters, explained recommendations, the player's remaining mpv capabilities,
subtitle hash matching, IMDb ratings import, a deeper catalog, chapter-based
skip-intro for movies and series, Letterboxd import, and indexer visibility
— is on `claude/post-preview70-fixes`. All 54 registered tests pass, both
TypeScript projects typecheck, and ESLint reports zero errors.

**Phase 0, 1, 2 and 3 are all complete. Phase 4 is done except two rows —
browsing a connected library, and a debrid provider abstraction; see that
phase's own note, which was rewritten once Jellyfin landed as a real
playback source and a live server (`192.168.88.237`) existed to verify it
against.**

The r3-cache daemon has also shipped and is running as tier 2 of playback
(see `daemon/README.md`). Confirmed on the instance at
`192.168.88.237:8945`: `/api/ping` answers as `r3-host` on
`1.0.83-preview.86`, and the app's own status card reports 7 titles and
30.7 GB of a 43.7 GB budget with the TorBox account linked — so pairing,
the credential hand-off and the fetch pipeline all work end to end against
real TorBox downloads. Not yet observed directly: a playback session
actually being served by the `lancache` tier. The keys that would make it
silently miss do agree — `wantedList.ts`'s feeder key, `streamCache.ts`'s
`cacheContentKey` and `streamResolve`'s own lookup all build
`catalogId:season:episode` the same way, and `storage.ts`'s `ItemMeta`
stores it verbatim — but that is a code argument, not a measurement.

| Shipped                          | Phase | What landed                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration runner + schema v2     | 0     | `PRAGMA user_version` migrations in transactions; `profile_id` on every library table; append-only `plays`; `ratings`, `lists`, `list_items`.                                                                                                                                                                           |
| Backup and restore               | 0     | The whole library to one JSON file and back. No credentials, no PIN, no cache. Restore also switches to the profile the backup was taken from — the miss preview.70 testing caught.                                                                                                                                     |
| Autoplay next episode            | 1     | Post-play card with a countdown, pausable on mouse-over. Also fixed `eof-reached` being reported in one direction only, which marked the second title played in a session as watched at position zero.                                                                                                                  |
| Player menu harvest              | 1     | Speed, chapters, audio sync, subtitle size/height/colour/backdrop, sleep timer.                                                                                                                                                                                                                                         |
| Night mode                       | 1     | Loudness normalization, so quiet dialogue survives a loud score.                                                                                                                                                                                                                                                        |
| Frame step, A-B loop, screenshot | 1     | The remaining mpv capabilities, one Playback-menu section, keys `.`/`,`/`s` to match mpv/VLC muscle memory.                                                                                                                                                                                                             |
| Subtitle hash matching           | 1     | OpenSubtitles' `moviehash`, computed by reading the first/last 64KB off the live StreamCache origin — the concern that deferred this out of Phase 1 originally, resolved with a bounded timeout and a silent fallback to the title search. Frame-accurate sync, badged "Exact match".                                   |
| Skip intro beyond anime          | 1     | Chapter-derived, for movies and series — reads the release's own chapter marks (`Opening Credits`, `Recap`, ...) rather than a community database, gated by both a literal name allowlist and a plausible position so a mislabeled or coincidental chapter is never trusted.                                            |
| Ratings                          | 2     | 1-10 per profile, weighting both preferred genres and the taste profile.                                                                                                                                                                                                                                                |
| My Stuff tabs + history          | 2     | Eight tabs. A single viewing can be removed without un-watching the episode.                                                                                                                                                                                                                                            |
| Stats                            | 2     | Viewings, titles, estimated hours, twelve-month chart, top genres, seen-again counted per episode.                                                                                                                                                                                                                      |
| Custom lists                     | 2     | Named lists beside My List, with an add-to-list menu on every title page.                                                                                                                                                                                                                                               |
| Scrobble depth                   | 2     | start / pause / stop to Simkl and Trakt, on transitions. The path existed and had never once run.                                                                                                                                                                                                                       |
| Trakt sync                       | 2     | Device-code sign-in, history/ratings/scrobble pushed alongside Simkl — mirrors the Simkl split (pure builders in `trakt.ts`, I/O in `traktClient.ts`).                                                                                                                                                                  |
| Trakt import                     | 2     | Pulls an existing Trakt account's history and ratings in, with their original dates. Gap-filling and repeatable — never overwrites a local play or rating, never doubles one on a second run.                                                                                                                           |
| IMDb ratings import              | 2     | Reads IMDb's own "export your ratings" CSV. Matched by IMDb id straight from the file — no title lookup, no guessing — and gap-filling like the Trakt import.                                                                                                                                                           |
| Letterboxd import                | 2     | Reads a Letterboxd "Export Your Data" zip's diary and ratings. No id in the export at all, unlike Trakt or IMDb — each row is resolved to an IMDb id by a strict TMDB title+year match (exactly one confident candidate or the row is skipped), cached 90 days so a second run doesn't re-search what it already knows. |
| Person pages                     | 3     | Cast and crew names open what else of theirs the catalog holds.                                                                                                                                                                                                                                                         |
| Search by credits                | 3     | Typing a director's name finds their films, not films with their name in the title.                                                                                                                                                                                                                                     |
| Where to watch                   | 3     | Streaming, rent and buy for your region, from JustWatch via TMDB.                                                                                                                                                                                                                                                       |
| Calendar                         | 3     | A week back and six weeks forward, from air dates already on disk.                                                                                                                                                                                                                                                      |
| Collection pages                 | 3     | The rest of a film's series, from TMDB data the similar-titles pass already fetched and discarded.                                                                                                                                                                                                                      |
| Content ratings                  | 3     | The age certificate for your region, and the prerequisite for parental controls.                                                                                                                                                                                                                                        |
| Saved filters                    | 3     | Name a filter combination on any browse page; it comes back as a chip. The value saved is the URL's own filter-state string, so nothing the filter bar learns to express needs a second schema.                                                                                                                         |
| Home rows with a reason          | 3     | Each suggestion says why: a franchise continuation, a director or actor you follow, a genre match. Emitted by the ranker itself, from the same numbers the score is made of, so the reason can't disagree with the ordering.                                                                                            |
| More catalogs                    | 3     | TMDB's now-playing, upcoming and top-rated lists merged straight into the same catalog every browse sort, search and recommendation already reads from — not a new page, a deeper pool. Every existing surface benefits at once.                                                                                        |
| Sonarr/Radarr requests           | 4     | Lookup by IMDb id through the server, add with a chosen profile and folder, search on add.                                                                                                                                                                                                                              |
| qBittorrent control              | 4     | Pause, resume and remove, with keeping or deleting the files asked separately.                                                                                                                                                                                                                                          |
| Notifications                    | 4     | New episodes of tracked shows, off by default, deferred while watching.                                                                                                                                                                                                                                                 |
| Indexer visibility               | 4     | Connect Prowlarr as a fifth service; the Downloads page names any indexer currently in a failure backoff, so "no results" from Sonarr/Radarr stops being unexplained. Silent when everything is healthy.                                                                                                                |

### Corrected along the way

Four defects, three of them pre-existing and one introduced and caught by its
own test.

- **`eof-reached` was reported in one direction only.** State patches merge, so
  it could never go back — the second title played in any session was marked
  watched the instant it started.
- **Rewatches destroyed the record of the first viewing**, and watch history had
  no profile column at all.
- **Scrobbling never ran.** A handler and a preload binding existed; nothing
  called either.
- **`Number(null)` is `0`, not `NaN`** — every film ended with an autoplay card
  offering season 1 episode 1.

### Turned out not to be needed

- **Seek preview thumbnails**, listed under Phase 1, already existed — the
  scrub bar has had them since the mpv port.

### Revisited

- **Subtitle hash matching** was deferred here as an L, on the reasoning that
  OpenSubtitles' `moviehash` needs the first and last 64KB of the complete
  file and playback streams through a rolling cache that frequently holds
  neither. That undersold the fix: StreamCache already serves an out-of-order
  byte range as an ordinary operation — a scrub to any point in the file
  produces exactly the same request shape — so reading the tail costs nothing
  StreamCache was not already built to do, bounded by its own timeout and
  falling back silently to the title search on anything slower. Shipped in
  Phase 1 after all; see the Progress table.

### Not verified at runtime

Every pure rule is covered by real tests against real SQLite — migrations,
profile scoping, plays, ratings, stats, lists, credit search, next-episode
ordering, subtitle style, Servarr payloads. What has never executed is the
wiring: mpv chapters and night mode, the autoplay handoff, a live Sonarr add, a
live qBittorrent pause, a real notification. None of it is drivable without the
app, a media source and those services.

## Ground rules

Five constraints every item obeys. They exist because the failure mode here is not shipping too
little — it is shipping all of it and ending up with a slower, noisier app than the one we have.

1. **The navigation stays at seven.** History, stats, lists, and the calendar land as tabs inside My
   Stuff. People and collections are drill-downs from a detail page. A new top-level destination
   requires a genuinely new mode, not a new noun.
2. **Nothing new runs at launch.** `recommendations.ts` set the precedent: rank in a background job,
   store the row, read it on open. Stats, the calendar, and the taste profile follow the same shape.
   Opening the app is a read — never a computation, never a network call.
3. **One schema migration, not five.** Four phases want new columns and three want new tables. The
   current style (a `PRAGMA table_info` probe appended per column, `database.ts:319-345`) does not
   survive that. Build the versioned runner once, up front.
4. **Every feature is free when unused.** New recurring work registers with `registerRecurringJob`
   and declares its pressure ceiling, so it never competes with a cold catalog crawl. New panels
   fetch on mount.
5. **Extend a surface before adding one.** Speed, chapters, subtitle styling, and audio delay go into
   the player's existing menu row. Ratings go into the context menu and detail hero that already
   exist. Resist a settings tab per feature.

Effort marks below are relative: **S** is a sitting, **M** is a few days, **L** is a week or more
with real design decisions inside it.

## Phase 0 — Foundations

Do this in one pass and do not split it. Four later phases add columns, three add tables, and
per-profile scoping rewrites every key in `database.ts`. A half-migrated schema is worse than no
migration at all. Nothing here is user-visible.

| Work                        | Effort | What it is                                                                                                                                                                                                      |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned migration runner  | M      | `PRAGMA user_version`, an ordered migration array, each step in its own transaction. Replaces the ad-hoc column probes at `database.ts:319-345`.                                                                |
| Schema v2 — profile scoping | L      | A `profile_id` on `tracked`, `watch_history`, `playback_positions`, and `disliked`; composite keys; every existing row backfilled to the default profile. The follow-up `profiles.ts:6-15` names and defers.    |
| Schema v2 — `plays` table   | M      | Append-only, one row per play. `watch_history` stays the "have I seen this" index; `plays` becomes the record. Fixes the rewatch overwrite at `database.ts:487`, where a second viewing replaces the first.     |
| Schema v2 — `ratings`       | S      | A 0-10 score per title per profile, with a timestamp. Nothing reads it yet; Phase 2 turns it into recommender input.                                                                                            |
| Schema v2 — `lists`         | M      | `lists` and `list_items`: named, ordered, per-profile. "My List" becomes the first row rather than a special case in the renderer.                                                                              |
| Backup and restore          | M      | The whole database plus settings out to one JSON file, and back in. De-risks every migration after this one, and closes the hole where a local SQLite file is the only copy of everything a person has watched. |
| Thread the active profile   | M      | One accessor resolving the active profile, passed through the `tracking.ts` / `catalog.ts` / `torbox.ts` / `malSync.ts` call sites. Mechanical, but it touches many files — hence the same pass as the schema.  |

**Verification:** a migration test that opens a v1 fixture database, runs the runner, and asserts row
counts and key shapes survive intact. `tests/databasePruning.test.ts` is the pattern to copy.

## Phase 1 — The player people already expect

The best return in the plan. Almost every item is a property mpv already exposes; the work is a menu
in the overlay and a case in the `PlayerCommand` union, not new playback engineering.

**Done.** See the Progress table above. Real fingerprint detection for a chapter-less release
(scanning a season for a recurring intro segment) was always scoped out of this phase as its own
project — see Phase 5.

## Phase 2 — Tracking that tells the truth

Two things here are wrong rather than merely missing: a rewatch destroys the record of the first
viewing, and `MyStuffPage.tsx` shows only My List while the README promises watched, liked, disliked,
and in-progress. Fix those, then reach parity.

**Done.** Trakt now covers both push and pull, and IMDb's and Letterboxd's own exports both read
straight in; see the Progress table above.

## Phase 3 — Discovery on data we already cache

Mostly rendering work, not fetching work. Cast, creators, TMDB keywords, AniList tags, collection
records, and airing state are already cached; search ignores them and in some cases nothing renders
them at all.

**Done.** See the Progress table above.

## Phase 4 — Make the connected services do something

Four services are connected and mostly watched rather than used. Independent of every other phase —
the best standalone win if you want something to ship this week.

Request/queue control, notifications and indexer visibility shipped — see the Progress table.

**Jellyfin as a playback source has since landed, and this section's framing of it was stale.**
`mediaSources.ts` looks a title up on the server and returns a real `StreamCandidate`;
`rankStreams` scores it against TorBox weighted by the user's `SourcePreference`; `jellyfin.ts`
covers id-and-title matching for films, episodes and the anime special case; `tests/jellyfin.test.ts`
pins it. The "no live instance to verify against" caveat is also gone — there is a rootless
Jellyfin on `192.168.88.237` now. The row's last clause, that the README's local → server →
download order was not what `stream:resolve` does, was correct and is now fixed at the source: the
README describes the real two-stage selection, and `STREAM_SOURCE_RANK` — the dead constant that
order was written from — has been deleted.

What did NOT land from that row is **browsing** the Jellyfin library, which is what remains below.
The `library:list` / `library:play` IPC pair was removed in the same pass, so nothing browses a raw
TorBox account either; both are one feature, listed once.

| Work                        | Effort | What it is                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse a connected library  | M      | A page that lists what a source actually holds, rather than only resolving titles found in the catalog. Covers Jellyfin (`getResumeItems` is the only read today) and the TorBox account, whose `library:list`/`library:play` handlers were removed as dead — no UI ever called them.                                   |
| Debrid provider abstraction | L      | Extract a provider interface (resolve, cache status, play URL) from `torbox.ts` and add Real-Debrid and AllDebrid behind it. An adoption ceiling more than a feature. Still deliberately deferred: it touches `stream:resolve`, where a mistake breaks what already works rather than merely leaving something missing. |

## Phase 5 — Reach beyond this window

Bets, not tickets. Each is weeks of work and each changes the shape of the app. Listed so they get
decided deliberately rather than drifted into halfway.

- **Casting.** DLNA/UPnP first — `upnp.ts` already exists for port mapping and discovery lives beside
  it. Chromecast needs a receiver app and a real protocol implementation. An "open in VLC/Infuse"
  handoff is the cheap version and buys most of the benefit for an afternoon.
- **Companion remote.** A phone driving the desktop player. `friends.ts` and the party relay already
  do authenticated, encrypted, host-less messaging between devices — this is that channel with a
  different payload, not new infrastructure. The most under-priced item here.
- **Offline pinning.** `streamCache.ts` is a rolling window tied to a session. Pinning means an
  eviction exemption, a deliberate download queue with its own quota, and a quality choice per
  download.
- **Parental controls.** The Kids profile is a label and a PIN. Real controls need Phase 3's content
  ratings, a per-profile ceiling, and time limits — and mean nothing until history is profile-scoped
  (Phase 0).
- **A second platform.** The structural gap: every competitor is on phone, tablet, TV, and web. It
  implies a server mode, which implies an account, which implies cross-device sync we do not have. A
  strategic decision, not something to start by accident with a responsive layout.
- **An addon system.** Stremio's actual moat. Opening catalogs and scrapers to third parties is a
  trust problem before it is a feature: `ipcGuard.ts` assumes only our own renderer ever speaks to
  main. Worth doing, worth doing slowly.

## Phase 4.5 — Viewer and Server Control

Agreed 2026-08-29, deliberately scheduled AFTER the next major release: a navigation split is the
highest-risk-to-polish change there is, and none of it is a new capability. Written down now so it
is built from a decision rather than assembled in pieces.

### The problem

The app has quietly grown a second audience. Six settings categories, eleven service cards, a
Downloads page carrying qBittorrent, two \*arr queues, Prowlarr indexer health and cached streams,
plus cache-server pairing, relay config, stream-cache sizing, update channels and a speed test.
That is an operator console living inside a viewing app, and the person who wants to watch
something has to walk past all of it. Every competitor separates these — Plex has a server
dashboard, Jellyfin a Dashboard, the \*arrs a System page.

### What actually moves

The line is ownership, not difficulty: **does this belong to the person, or to the installation?**
Everything on the left is still theirs on a machine somebody else administers.

| Stays in Viewer                                                                                                                                                                                                                                         | Moves to Server Control                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playback, subtitle and audio language, episodes/autoplay, appearance and animations, notifications, profiles, My Stuff, backup and the three imports, and the tracking accounts (Simkl, Trakt, MAL) — those are a person's own history, not a server's. | Jellyfin, Sonarr, Radarr, qBittorrent, Prowlarr, TorBox, the r3-cache pairing, stream-cache size and location, the party relay, network address and speed test, update channel, background activity, and the error log. |

Ollama is the one genuine judgement call. It is a connection like the rest, but the assistant and
Recommend Next are features a viewer uses directly. Proposal: the connection lives in Server
Control, and Viewer keeps a read-only line saying whether AI is available.

### Build it in this order

1. **The Server dashboard, as one new destination.** This is the only part that is a NEW
   capability rather than a relocation, and it is the part that was asked for: which component is
   doing what, live connection health, throughput, and errors in one place. `activityGet` /
   `activityChanged` already report running work (see `taskScheduler.ts`), and `logError` is
   already called everywhere — but nothing surfaces it, so a failing subtitle provider or an
   unreachable daemon is invisible unless somebody happens to be watching the right card. Shipping
   this alone is worth doing even if the split never happens.
2. **Move the operator settings behind it**, once the grouping has been lived with.
3. **The mode toggle last**, if it is still wanted — by then it is a nav change over an already
   correct grouping, not a redesign.

### Constraints that are already decided

- **Kids profiles never see Server Control.** `profiles.ts` already models `isKid`, and the PIN
  mechanism already exists — gating this is reuse, not new work, and it is the first thing that
  makes the Kids profile mean something beyond a label.
- **No new IPC for step 1.** Everything the dashboard needs is already crossing the bridge; it is a
  presentation problem. An error log is the one addition, and it belongs beside `logger.ts` rather
  than as a new subsystem.
- **The Downloads page is the precedent, not a casualty.** It already aggregates four backends and
  is where people look for "what is happening". Server Control either absorbs it or links to it —
  what must not happen is two pages that both half-answer the question.

## Phase 6 — The long tail

None of it blocks anything, and all of it separates an app people use from one they recommend. Pick
these up between phases rather than saving them for an end that never comes.

| Work              | Effort | What it is                                                                                                                     |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Localization      | L      | The interface is English-only and metadata language is fixed. Plex, Jellyfin, and Stremio are all heavily localized.           |
| Accessibility     | M      | Audio-description track preference, a real subtitles-versus-captions distinction, and interface font scaling.                  |
| Artwork selection | S      | Choose the poster, logo, and backdrop. Plex, Jellyfin, and Kodi all allow it.                                                  |
| Extras            | S      | Featurettes, deleted scenes, behind-the-scenes, from the TMDB record already fetched.                                          |
| Notes and reviews | M      | A private note per title, and an optional public review if the social work happens.                                            |
| Social layer      | L      | A persistent activity feed, follows, shareable profiles. `friends.ts` gives live presence and nothing that survives a session. |
| Party reach       | L      | A web-join link for someone without the app, plus reactions and voice.                                                         |

## Order of operations

- **Phase 0 goes first and goes whole.** The only genuinely blocking phase, and the one with no
  visible payoff — which is exactly why it gets skipped and then paid for five times.
- **Phases 1 and 2 run in parallel.** One is overlay and player-bridge work, the other is database and
  tracking work. They barely touch the same files.
- **Phase 3 wants Phase 2 finished.** Its Home rows and search are only as good as the signal behind
  them, and ratings are that signal.
- **Phase 4 depends on nothing.** The Sonarr/Radarr request flow is two endpoints against a connection
  that is already configured and currently only watched.
- **Phase 5 is a decision, not a sprint.** One bet at a time, after Phases 0-3 land — most of them
  quietly assume profile-scoped data or content ratings.

## The first five tickets

1. **Autoplay next episode.** The biggest single behavioural gap, and the session already holds
   everything it needs.
2. **Migration runner and schema v2.** Invisible, unskippable. Every ticket after it is cheaper, and
   per-profile history stops being a known defect in a shipped feature.
3. **Ratings, wired into the recommender.** A small UI on a Phase 0 table, and the first real quality
   signal the ranking has ever had.
4. **Sonarr and Radarr requests.** Two endpoints. Turns four configured services from a dashboard into
   something that does work on your behalf.
5. **The player menu harvest.** Speed, chapters, subtitle styling, audio delay, sleep timer — five
   expected features in one menu.

Every phase ships behind the gates the project already runs: `npm test`, `npm run lint`,
`npm run typecheck`, plus a migration test against a v1 fixture database for Phase 0.
