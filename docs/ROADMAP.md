# Roadmap

Roughly sixty things competing apps did that this one did not when the plan was written, sequenced
into eight phases (0 to 6, plus 4.5) and grounded in what the code already held.

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
— merged to `preview` in PRs #106 and #107.

**Phases 0 to 3 are complete apart from one gap (Next up, item 1). Phase 4
is done except two rows: browsing a connected library, and a debrid
provider abstraction (see Phase 4).**

The r3-cache daemon has also shipped and is running as tier 2 of playback
(see `daemon/README.md`). On 2026-08-29 the instance at
`192.168.88.237:8945` answered `/api/ping` as `r3-host` on
`1.0.83-preview.86` (it updates itself on the preview channel, so that
version has since moved on), and the app's status card reported 7 titles
and 30.7 GB of a 43.7 GB budget with the TorBox account linked — so
pairing, the credential hand-off and the fetch pipeline all work end to
end against real TorBox downloads.

Not yet observed directly: a playback session served by the `lancache`
tier. The feeder and `stream:resolve`'s tier-2 lookup build the same key
(`lanCacheContentKey` in `src/shared/lancache/wantedList.ts`): `id::` for a
movie, `id:season:episode` for a series, and `kitsuId::episode` for anime,
because a Kitsu id already names its season. The daemon stores the key as
given, and tier 1's `cacheContentKey` keeps the anime season on purpose.

That anime rule breaks for a later season of a merged show. Its history is
filed under the show's first member, at the season number the show's page
gives it (see
[WATCHLIST-SYNC.md](WATCHLIST-SYNC.md#when-a-members-place-is-not-its-season)),
and the feeder's key drops that season, so it names the first member's
episode instead. Neither this nor the key match above has been measured;
both are read from the code.

| Shipped                          | Phase | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration runner + schema v2     | 0     | `PRAGMA user_version` migrations in transactions; `profile_id` on every library table; append-only `plays`; `ratings`, `lists`, `list_items`.                                                                                                                                                                                                                                                                                                                     |
| Backup and restore               | 0     | The whole library to one JSON file and back: the profile-scoped tables, the profile list without PINs, the active profile and the anime grouping ledger. No catalog cache, no credentials, no device settings. Restore also switches to the profile the backup was taken from — the miss preview.70 testing caught.                                                                                                                                               |
| Autoplay next episode            | 1     | An Up next card at the credits (Aniskip for anime, the release's credits chapter otherwise) with Play next and Skip credits, then a 10-second countdown at the end of the episode; [the README's Play section](../README.md#3-play--needs-mpv-bundled-with-the-windows-installer) says what cancels it and when no card shows.                                                                                                                                    |
| Player menu harvest              | 1     | Speed, chapters, audio sync, subtitle size/height/colour/backdrop, sleep timer.                                                                                                                                                                                                                                                                                                                                                                                   |
| Night mode                       | 1     | Loudness normalization, so quiet dialogue survives a loud score.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Frame step, A-B loop, screenshot | 1     | The remaining mpv capabilities, one Playback-menu section, keys `.`/`,`/`s` to match mpv/VLC muscle memory.                                                                                                                                                                                                                                                                                                                                                       |
| Subtitle hash matching           | 1     | OpenSubtitles' `moviehash`, computed by reading the first/last 64KB off the live StreamCache origin (see Revisited). Frame-accurate sync, badged "Exact match".                                                                                                                                                                                                                                                                                                   |
| Skip intro beyond anime          | 1     | Chapter-derived, for movies and series — reads the release's own chapter marks (`Opening Credits`, `Recap`, ...) rather than a community database, gated by both a literal name allowlist and a plausible position so a mislabeled or coincidental chapter is never trusted.                                                                                                                                                                                      |
| Ratings                          | 2     | 1-10 per profile, read by preferred genres, the recommender's taste profile and MAL sync.                                                                                                                                                                                                                                                                                                                                                                         |
| My Stuff tabs + history          | 2     | Eight tabs. A single viewing can be removed without un-watching the episode.                                                                                                                                                                                                                                                                                                                                                                                      |
| Stats                            | 2     | Viewings, titles, estimated hours, twelve-month chart, top genres, seen-again counted per episode.                                                                                                                                                                                                                                                                                                                                                                |
| Custom lists                     | 2     | Named lists in My Stuff's Lists tab, separate from Planned, with an add-to-list menu on every title page. One gap: Next up, item 1.                                                                                                                                                                                                                                                                                                                               |
| Scrobble depth                   | 2     | start / pause / stop to Simkl and Trakt, on transitions. Off by default, because each scrobble spends Simkl's daily request allowance; [the README's Sync section](../README.md#5-sync--optional-one-account-per-service) says where to turn it on.                                                                                                                                                                                                               |
| Trakt sync                       | 2     | Device-code sign-in; history pushed alongside Simkl, plus ratings and (when turned on) scrobbles, for films and series only (anime is not sent). Mirrors the Simkl split (pure builders in `trakt.ts`, I/O in `traktClient.ts`).                                                                                                                                                                                                                                  |
| Trakt import                     | 2     | Pulls an existing Trakt account's history and ratings in; viewings keep their original dates, ratings are dated the day of the import. Never overwrites a local play or rating, and pressing Import again adds nothing it brought in before. It does not skip viewings held here, though: one played here and sent to Trakt comes back with Trakt's time as a second play (see [Trakt's history](WATCHLIST-SYNC.md#trakts-history)).                              |
| IMDb ratings import              | 2     | Reads IMDb's own "export your ratings" CSV. Matched by IMDb id straight from the file — no title lookup, no guessing — and it only fills in what is missing.                                                                                                                                                                                                                                                                                                      |
| Letterboxd import                | 2     | Reads a Letterboxd "Export Your Data" zip's diary and ratings. No id in the export at all, unlike Trakt or IMDb — each row is resolved to an IMDb id by a strict TMDB title+year match (exactly one confident candidate or the row is skipped), cached 90 days so a second run doesn't re-search what it already knows.                                                                                                                                           |
| Person pages                     | 3     | Cast and crew names open what else of theirs the catalog holds.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Search by credits                | 3     | Typing a director's name finds their films, not films with their name in the title.                                                                                                                                                                                                                                                                                                                                                                               |
| ~~Where to watch~~ (removed)     | 3     | Shipped as streaming, rent and buy for your region, from JustWatch via TMDB, and since removed: the panel was deleted, and the region setting now only picks the content-rating country (see `watchProviders.ts`).                                                                                                                                                                                                                                                |
| Calendar                         | 3     | A week back and six weeks forward, from air dates already on disk.                                                                                                                                                                                                                                                                                                                                                                                                |
| Collection pages                 | 3     | The rest of a film's series, from TMDB data the similar-titles pass already fetched and discarded.                                                                                                                                                                                                                                                                                                                                                                |
| Content ratings                  | 3     | The age certificate for your region, and the prerequisite for parental controls.                                                                                                                                                                                                                                                                                                                                                                                  |
| Saved filters                    | 3     | Name a filter combination on any browse page; it comes back as a chip. The value saved is the URL's own filter-state string, so nothing the filter bar learns to express needs a second schema. One gap: Next up, item 1.                                                                                                                                                                                                                                         |
| Home rows with a reason          | 3     | Each suggestion says why: a franchise continuation, a director or actor who recurs in what you have watched, a genre match. Emitted by the ranker itself, from the same numbers the score is made of, so the reason can't disagree with the ordering.                                                                                                                                                                                                             |
| More catalogs                    | 3     | A deeper pool, not a new page: the crawl merges Simkl trending with Cinemeta walked about 2,000 titles deep, into the same catalog every browse sort, search and recommendation already reads from, so every existing surface benefits at once. Anime comes from Kitsu. TMDB's now-playing, upcoming and top-rated lists were part of it once and were taken out on purpose: they needed a TMDB key and cost up to 120 id lookups per build for about 120 titles. |
| Sonarr/Radarr requests           | 4     | Lookup by IMDb id through the server, add with a chosen profile and folder, search on add.                                                                                                                                                                                                                                                                                                                                                                        |
| qBittorrent control              | 4     | Pause, resume and remove, with keeping or deleting the files asked separately.                                                                                                                                                                                                                                                                                                                                                                                    |
| Notifications                    | 4     | New episodes of tracked shows, off by default, deferred while watching.                                                                                                                                                                                                                                                                                                                                                                                           |
| Indexer visibility               | 4     | Connect Prowlarr as a service; the control centre's Services card counts indexers currently in a failure backoff, so "no results" from Sonarr/Radarr stops being unexplained.                                                                                                                                                                                                                                                                                     |

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
wiring of mpv chapters and night mode, a live Sonarr add, a live qBittorrent
pause and a real notification. None of it is drivable without the app, a
media source and those services. The autoplay handoff has run: hands-on
testing of `v1.0.83-preview.70` found problems with its skip banners and its
countdown, fixed in #106.

## Ground rules

Five constraints every item obeys. They exist because the failure mode here is not shipping too
little — it is shipping all of it and ending up with a slower, noisier app than the one we have.

1. **The navigation stays at eight.** Home, For You, Movies, Series, Anime, My Stuff, Calendar,
   Settings (`NAV_ITEMS` in `data/constants.ts`). History, stats and lists land as tabs inside My
   Stuff; Calendar is the one exception, with an entry of its own. People and collections are
   drill-downs from a detail page. A new top-level destination requires a genuinely new mode, not a
   new noun.
2. **Nothing new runs at launch.** `recommendations.ts` set the precedent: rank in a background job,
   store the row, read it on open; the taste profile is built inside that job. Stats (from SQL) and
   the calendar (from metadata read cache-first) are computed when they are opened. Opening the app
   paints from what is stored and waits on nothing, but it is not only a read: the window shows the
   last session's snapshot while a catalog older than six hours is re-crawled behind it. The Simkl
   and Trakt catch-ups are also an exception to this rule, not an example of it
   ([the README's Sync section](../README.md#5-sync--optional-one-account-per-service)). The
   window starts one once it has rendered and again when it regains focus (at most every ten
   minutes). Its Simkl requests run at `visible` priority, so a first catalog crawl does not hold
   up films and series from Simkl, and the window paints without waiting for it. Two things do wait
   on that crawl: anime, until the catalog has been grouped (a Trakt pull that holds any anime
   writes nothing until then), and Trakt's history pages, which read at `background` priority.
3. **One schema migration, not five.** Four phases want new columns and three want new tables. The
   style this rule was written against (a `PRAGMA table_info` probe appended per column) does not
   survive that. The versioned runner was built once, up front, and new schema goes through it:
   `src/main/media-hub/migrations.ts`, on `PRAGMA user_version`.
4. **Every feature is free when unused.** New recurring work registers with `registerRecurringJob`
   and declares its pressure ceiling, so it never competes with a cold catalog crawl. New panels
   fetch on mount.
5. **Extend a surface before adding one.** Speed, chapters, subtitle styling, and audio delay go into
   the player's existing menu row. Ratings went into the Ratings panel the detail page already had,
   beside the crowd scores, not a new page. Resist a settings tab per feature.

Effort marks below are relative: **S** is a sitting, **M** is a few days, **L** is a week or more
with real design decisions inside it.

## Phase 0 — Foundations

Do this in one pass and do not split it. Four later phases add columns, three add tables, and
per-profile scoping rewrites every key in `database.ts`. A half-migrated schema is worse than no
migration at all. Apart from backup and restore, nothing here is user-visible.

**Done.** See the Progress table above; where what was built differs from the plan, the row says so.

| Work                        | Effort | What it is                                                                                                                                                                                                                                                          |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned migration runner  | M      | `PRAGMA user_version`, an ordered migration array, each step in its own transaction. The ad-hoc `PRAGMA table_info` probes in `database.ts` are gone; the only ones left are `addColumnIfMissing` inside the baseline migration in `migrations.ts`.                 |
| Schema v2 — profile scoping | L      | A `profile_id` on `tracked`, `watch_history`, `playback_positions`, and `disliked`; composite keys; every existing row backfilled to the default profile. The follow-up the header comment of `profiles.ts` named and deferred, and which this migration delivered. |
| Schema v2 — `plays` table   | M      | Append-only, one row per play. `watch_history` is the "have I seen this" index and `plays` the record, so a second viewing is a second row rather than replacing the first.                                                                                         |
| Schema v2 — `ratings`       | S      | A 1-10 score per title per profile, with a timestamp. There is no zero: clearing a rating sends 0, which removes it, as does any other out-of-range score, and an import skips out-of-range rows.                                                                   |
| Schema v2 — `lists`         | M      | `lists` and `list_items`: named, ordered, per-profile, holding only the lists people create. The plan-to-watch set never became a row here; it stays in `tracked` (see Custom lists in the Progress table).                                                         |
| Backup and restore          | M      | The library out to one JSON file and back in; what it carries is in the Progress table. De-risks every migration after this one, and closes the hole where a local SQLite file is the only copy of everything a person has watched.                                 |
| Thread the active profile   | M      | One accessor resolving the active profile, passed through the `tracking.ts` / `catalog.ts` / `torbox.ts` / `malSync.ts` call sites. Mechanical, but it touches many files — hence the same pass as the schema.                                                      |

**Verification:** `tests/migrations.test.ts` opens a database with the schema as it stood before
versioning, runs the runner, and checks row counts and that every row comes out attributed to a
profile; `npm test` runs it.

## Phase 1 — The player people already expect

The best return in the plan. Almost every item is a property mpv already exposes; the work is a menu
in the overlay and a case in the `PlayerCommand` union, not new playback engineering.

**Done.** See the Progress table above. Real fingerprint detection for a chapter-less release
(scanning a season for a recurring intro segment) was always scoped out of this phase as its own
project, and no phase below holds it yet: a movie or series release without an intro or credits
chapter gets no skip button.

## Phase 2 — Tracking that tells the truth

Two things here were wrong rather than merely missing: a rewatch destroyed the record of the first
viewing, and My Stuff showed only My List. Both were fixed first, then parity.

**Done.** Trakt now covers both push and pull, and IMDb's and Letterboxd's own exports both read
straight in; see the Progress table above. One gap remains (Next up, item 1).

## Phase 3 — Discovery on data we already cache

Mostly rendering work, not fetching work. Cast, creators, TMDB keywords, AniList tags, collection
records, and airing state were already cached; search ignored them and in some cases nothing
rendered them at all.

**Done.** See the Progress table above. One gap remains (Next up, item 1).

## Phase 4 — Make the connected services do something

Four services were connected and mostly watched rather than used. Independent of every other phase —
the best standalone win if you want something to ship this week.

Request/queue control, notifications and indexer visibility shipped — see the Progress table.

**Jellyfin is a playback source.** `mediaSources.ts` looks a title up on the server and returns a
real `StreamCandidate`; `rankStreams` scores it against TorBox weighted by the user's
`SourcePreference`; `jellyfin.ts` covers id-and-title matching for films, episodes and the anime
special case; `tests/jellyfin.test.ts` pins it; and a rootless Jellyfin on `192.168.88.237` is there
to verify against.
[The README's Choose a source section](../README.md#2-choose-a-source--needs-torbox-or-a-jellyfin-server)
gives the order `stream:resolve` follows.

What is not built is **browsing** a library. Nothing lists what the Jellyfin server or the TorBox
account holds (the `library:list` / `library:play` IPC pair is gone), so both are one feature,
listed once below.

| Work                        | Effort | What it is                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse a connected library  | M      | A page that lists what a source actually holds, rather than only resolving titles found in the catalog, for both Jellyfin and the TorBox account. Jellyfin has no library read at all: the only live calls are the per-title lookups playback makes and the connection test, and `getResumeItems` in the renderer's `lib/api/jellyfin.ts` is an unused scaffold. |
| Debrid provider abstraction | L      | Extract a provider interface (resolve, cache status, play URL) from `torbox.ts` and add Real-Debrid and AllDebrid behind it. An adoption ceiling more than a feature. Still deliberately deferred: it touches `stream:resolve`, where a mistake breaks what already works rather than merely leaving something missing.                                          |

## Phase 5 — Reach beyond this window

Bets, not tickets. Each is weeks of work and each changes the shape of the app. Listed so they get
decided deliberately rather than drifted into halfway.

- **Casting.** DLNA/UPnP first — `upnp.ts` already exists for port mapping and discovery lives beside
  it. Chromecast needs a receiver app and a real protocol implementation. An "open in VLC/Infuse"
  handoff is the cheap version and buys most of the benefit for an afternoon.
- **Companion remote.** A phone driving the desktop player. `rooms.ts` (Rooms grew out of the
  friends group in #131) and the party relay already do authenticated, encrypted, host-less
  messaging between devices — this is that channel with a different payload, not new
  infrastructure. The most under-priced item here.
- **Offline pinning.** `streamCache.ts` keeps a title only briefly: closed before it is marked
  watched, it stays on disk for about a day, whole only when the cache size allows, so it can resume
  or replay from this machine's own cache; it is deleted once marked watched. Pinning means an
  eviction exemption, a deliberate download queue with its own quota, and a quality choice per
  download.
- **Parental controls.** A Kids profile is only a badge, and a PIN is optional, separate from it and
  not a lock ([the README's Known limitations](../README.md#known-limitations)). Real controls need
  a per-profile ceiling on the content ratings Phase 3 added, time limits, and a PIN another profile
  cannot remove; history is already profile-scoped (Phase 0).
- **A second platform.** Partly taken. One Android APK covers phones and Android TV / Google TV:
  it runs the desktop's own `src/main` headless behind a bridge on `127.0.0.1`, with the phone/TV
  UI from `src/app-ui` in front, and every desktop release carries it (see `android/README.md`). A
  phone links to a desktop by QR code (Control Centre → Media servers → Link a phone). What is
  still not taken is an account of our own: desktops share a library only through the tracking
  services (Simkl, Trakt, MyAnimeList), and a linked phone only through Simkl.
- **An addon system.** Stremio's actual moat. Opening catalogs and scrapers to third parties is a
  trust problem before it is a feature: `ipcGuard.ts` assumes only our own renderer ever speaks to
  main. Worth doing, worth doing slowly.

## Phase 4.5 — Viewer and Server Control

Agreed 2026-08-29, deliberately scheduled AFTER the next major release: a navigation split is the
highest-risk-to-polish change there is, and none of it is a new capability. Written down now so it
is built from a decision rather than assembled in pieces.

**Status.** Part of step 1 below has shipped as the Control Centre
(`src/renderer/src/components/controlcentre/**`, #124, #125 and #141), and step 3 in another shape:
every settings category lives in the Control Centre, and the Settings page keeps only what you
change while watching (see [the README's Using the app](../README.md#using-the-app)). The split by
ownership in the table below has not happened: tracking accounts, profiles, notifications and backup
sit in the Control Centre beside the services.

### The problem

The app had quietly grown a second audience. Six settings categories, eleven service cards,
qBittorrent, two \*arr queues, Prowlarr indexer health and cached streams (the Control Centre's
Services and Caching sections), plus cache-server pairing, relay config, stream-cache sizing, update
channels and a speed test. That was an operator console living inside a viewing app, and the person
who wanted to watch something had to walk past all of it. Every competitor separates these — Plex
has a server dashboard, Jellyfin a Dashboard, the \*arrs a System page.

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

1. **The Server dashboard, as one new destination.** _Half shipped._ This is the only part that is a
   NEW capability rather than a relocation, and it is the part that was asked for: which component
   is doing what, live connection health, throughput, and errors in one place. What exists: Control
   Centre → Services shows each connected service's connection status and embeds
   `BackgroundActivitySection`, which reads the running work `activityGet` / `activityChanged`
   report (see `taskScheduler.ts`). What does not: an error-log surface. `logError` is called
   everywhere and nothing surfaces it yet, so a failing subtitle provider is still invisible unless
   somebody happens to be watching the right card.
2. **Owner labels on the shared parts.** _Done differently._ The plan was a daemon protocol addition
   so the cache server's queue could say whose fetch is running. What was built scopes the list
   instead of annotating it: a member device sees only its own jobs plus an `othersJobCount`
   for the rest, and the admin sees the whole queue with each job's `ownerName`
   (`src/shared/lancache/protocol.ts`, `othersJobCount` and `ownerName`; `daemon/server.ts`).
3. **Move the operator settings behind it**, once the grouping has been lived with.
   _Done differently._ Every settings category moved into the Control Centre, not only the
   operator's, and the Settings page keeps only what you change while watching.
4. **The mode toggle last**, if it is still wanted — by then it is a nav change over an already
   correct grouping, not a redesign.

### One or two people operate the shared parts

Added 2026-08-29, and it changes the shape of this: the split is not "my machine's admin screen".
Some of what moves is genuinely **shared between people** — the cache server, Rooms, and the
download stack when several installs point at the same qBittorrent/\*arr box. In a household one or
two people run those and everybody else just watches.

**Operator is mostly a property of an installation.** This app has no central account, so for
qBittorrent, Sonarr, Radarr and TorBox whoever holds the credentials IS the operator on that
machine, by construction. Two shared parts do hold a role: the r3-cache daemon, whose administrator
device alone approves, removes and configures devices (see `daemon/README.md`), and a Room, whose
creator is its admin (see [ROOMS.md](ROOMS.md)). So Server Control should appear when an install
actually has operator-owned services configured, with an explicit toggle to hide it (the lounge
machine is paired to the cache server and should still not offer to reconfigure it). Its cache
section follows the daemon's own administrator check instead of inventing a second one.

**Say plainly what is and is not enforced.** The cache daemon has real per-person isolation and
already implements it: credentials are stored per paired device (`credentials.ts`, keyed by a hash
of the pairing token), every job records `ownerDeviceId`, and a fetch only ever bills its own
owner's TorBox account — never a housemate's. That is a genuine boundary. qBittorrent, Sonarr,
Radarr and TorBox have none: two people who both hold the credentials both have full control, which
is true today and does not change. A screen called "Server Control" must not imply an authorization
model the app does not have, so the dashboard should show _who_ an action belongs to and never
suggest it is gating one.

**The one protocol gap — closed, differently.** The job list carried no owner, so a household view
could not say whose fetch was running; step 2 above says how that was closed.

**The one real hole — closed.** Ownership used to be enforced for spending and ignored for seeing:
`GET /api/catalog` with no `keys` filter handed every cached item, with titles, to any paired
device, and `/stream/{infoHash}` authorised on "is this token paired" rather than on who owned the
item. [CACHE-PERMISSIONS.md](CACHE-PERMISSIONS.md) was built on 2026-08-29: `GET /api/catalog` now
returns nothing without `?keys=` and filters what it does return by `isEntitled`, `/stream` uses the
same `isEntitled` check, and the pairing code is gone, replaced by in-app approval. That document
is the reference for private-by-default items, sharing, per-device allocation and the Super Admin
claim.

**The build order there was followed: entitlement first, then the code removed.** Before
entitlement, "paired" meant "may stream everything", so dropping the code first would have let
anyone on the LAN watch the whole cache. CACHE-PERMISSIONS.md records that order as the one it was
built in.

**Rooms are the existing precedent, not a new problem.** A party already has a host who holds the
member-control toggles (`SessionHub.tsx`); its Queue tab exists, but nothing adds a title to it
([the README's Known limitations](../README.md#known-limitations)). Rooms are host-less presence
channels, so they survive anyone going offline (`rooms.ts`). Server Control surfaces both rather
than redesigning them.

### Constraints that are already decided

- **Kids profiles never see Server Control.** `profiles.ts` already models `isKid`, so hiding it is
  reuse. Keeping a Kids profile from switching to one that sees it is not: the PIN is asked for only
  on a switch and can be removed from another profile without it, so that part is new work.
- **No new IPC for step 1.** Everything the dashboard needs is already crossing the bridge; it is a
  presentation problem. An error log is the one addition, and it belongs beside `logger.ts` rather
  than as a new subsystem.
- **The Downloads page was absorbed.** `/downloads` redirects Home, and its contents live in the
  Control Centre: Caching for cached streams, Services for queues and background activity. The
  constraint it stood for still holds — what must not happen is two pages that both half-answer
  "what is happening".

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
| Social layer      | L      | A persistent activity feed, follows, shareable profiles. `rooms.ts` keeps standing membership but provides only live presence. |
| Party reach       | L      | A web-join link for someone without the app, plus reactions and voice.                                                         |

## Order of operations (historical)

Kept as the record of how the phases were sequenced, not as a plan still to run: Progress above
says which phases are complete, and Next up below says what is open.

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

## Next up

This section first listed five tickets, and all five have shipped — see the Shipped table under
Progress: autoplay next episode, the migration runner and schema v2, ratings wired into the
recommender, Sonarr and Radarr requests, and the player menu harvest.

What is still open:

1. **Name prompts on the desktop (Phases 2 and 3).** Save view on a category page and Rename on a
   list in My Stuff both open a browser name prompt the desktop app does not support, so neither
   does anything there. Replace both with an in-app field.
2. **Phase 4: browse a connected library.** A page that lists what a source actually holds — the
   part of that phase that did not land.
3. **Phase 4: the debrid provider abstraction.** Still deliberately deferred, for the reason that
   phase gives.
4. **Phase 4.5: Viewer and Server Control.** Part of step 1 has shipped as the Control Centre, and
   the Settings page is cut down to what a viewer changes; the split by ownership has not.
5. **Phase 5.** Bets, one at a time.

Every phase ships behind the checks listed in
[the README's What CI checks section](../README.md#what-ci-checks).
