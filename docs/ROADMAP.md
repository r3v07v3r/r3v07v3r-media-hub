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

The first five tickets are done and on `claude/competitive-feature-analysis-4de25a`.

| Shipped                      | Phase | What landed                                                                                                                                                                                                                   |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autoplay next episode        | 1     | Post-play card, ten-second countdown, off under Settings → Playback → Episodes. Also fixed `eof-reached` being reported in one direction only, which marked the second title played in a session as watched at position zero. |
| Migration runner + schema v2 | 0     | `PRAGMA user_version` migrations in transactions; `profile_id` on every library table; append-only `plays`; `ratings`, `lists`, `list_items`.                                                                                 |
| Backup and restore           | 0     | Whole library to one JSON file and back. No credentials, no PIN, no cache.                                                                                                                                                    |
| Ratings                      | 2     | 1-10 per profile, weighting both preferred genres and the taste profile.                                                                                                                                                      |
| Sonarr/Radarr requests       | 4     | Lookup by IMDb id through the server, add with a chosen quality profile and root folder, search on add.                                                                                                                       |
| Player menu harvest          | 1     | Speed, chapters, audio sync, subtitle size/height/colour/backdrop, sleep timer.                                                                                                                                               |

Seek preview thumbnails, listed under Phase 1 below, turned out to already
exist — the scrub bar has had them since the mpv port.

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

| Work                               | Effort | What it is                                                                                                                                                                                                       |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autoplay next episode              | M      | The largest behavioural gap against Netflix, Plex, Jellyfin, and Stremio. The session already knows the title and `Episode.unplayable` already marks what to skip. Post-play card, countdown, and an off switch. |
| Playback speed                     | S      | `set-speed` exists at `player.ts:145` and is used only for watch-party drift correction. Expose 0.5x-2x, and hide it during a party so nobody fights the sync law.                                               |
| Chapters                           | S      | mpv's `chapter-list` as a menu, plus next/previous keys.                                                                                                                                                         |
| Subtitle styling                   | S      | Size, colour, background, position, persisted as settings. The harder one — delay, at `PlayerOverlayWindow.tsx:556` — already ships.                                                                             |
| Audio delay                        | S      | The counterpart to that subtitle delay, and the fix for a badly muxed release.                                                                                                                                   |
| Subtitle hash matching             | S      | `opensubtitles.ts:47` searches by IMDb id or title query only. Adding `moviehash` is what makes subtitles land in sync rather than merely exist.                                                                 |
| Loudness normalization             | S      | mpv's `dynaudnorm` behind a "Night mode" toggle. Pairs with the 200% volume ceiling already shipped for quiet mixes.                                                                                             |
| Sleep timer                        | S      | 15 / 30 / 60 minutes, or end of episode.                                                                                                                                                                         |
| Frame step, A-B repeat, screenshot | S      | Three more mpv capabilities, one menu, effectively free once the menu exists.                                                                                                                                    |
| Seek preview thumbnails            | L      | A sprite generated from the cached file and stored beside its stream-cache entry, evicted with it. Schedule as a background job so it never blocks playback starting.                                            |
| Skip intro beyond anime            | L      | Chapter-derived first, since many releases carry usable marks. Real detection (fingerprinting across a season) is its own project — ship the chapter path here and let the detector be a later bet.              |

## Phase 2 — Tracking that tells the truth

Two things here are wrong rather than merely missing: a rewatch destroys the record of the first
viewing, and `MyStuffPage.tsx` shows only My List while the README promises watched, liked, disliked,
and in-progress. Fix those, then reach parity.

| Work                  | Effort | What it is                                                                                                                                                                                                                    |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ratings, 0-10         | M      | In the detail hero and context menu that already exist. Then wire the score into `catalog-logic.ts:741` as a ranking weight — the recommender reads genre, year, cast, and tags, and has no idea how much anything was liked. |
| Rewatch-aware history | M      | Writes go to `plays`; the history read becomes plays newest-first, with a count per title.                                                                                                                                    |
| History view          | M      | A tab inside My Stuff, per rule 1. Remove a play, re-date one, jump to its title. The data and its index have been there all along with nothing rendering them.                                                               |
| My Stuff, as promised | M      | Tabs for List, Watched, History, Liked, and Dropped — replacing a page that renders one grid and a "nothing saved yet" message.                                                                                               |
| Custom lists          | M      | Create, rename, reorder, delete. My List becomes list one.                                                                                                                                                                    |
| Stats                 | M      | Watch time, titles finished, genre and decade split, per-year totals. Computed in a background job and stored, per rule 2.                                                                                                    |
| Scrobble depth        | S      | `tracking.ts:1345` posts `/scrobble/start` and nothing else. Add pause and stop so a partial watch is reported honestly.                                                                                                      |
| Trakt                 | L      | The largest tracking network we do not support. Mirror the Simkl split (pure builders in `simkl.ts`, I/O in `simklClient.ts`) so the reconcile machinery in `tracking.ts` is reused, not rebuilt.                             |
| Import and export     | M      | Trakt, Letterboxd, and IMDb CSV in. Our own data out, from Phase 0. The thing that makes switching to this app cheap.                                                                                                         |

## Phase 3 — Discovery on data we already cache

Mostly rendering work, not fetching work. Cast, creators, TMDB keywords, AniList tags, collection
records, and airing state are already cached; search ignores them and in some cases nothing renders
them at all.

| Work                           | Effort | What it is                                                                                                                                                         |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where to watch                 | M      | TMDB watch providers, with a region setting. The gap nobody expects a media app to have.                                                                           |
| Search by person, keyword, tag | M      | `credits.ts` caches cast, creators, TMDB keywords, and AniList tags per title. `assistantSearch.ts` is title-substring only. The index is sitting there unqueried. |
| Person pages                   | M      | `AboutPanel.tsx:97` renders the cast as a comma-joined string. Make each name a link to a filmography built from the same cache.                                   |
| Collections and franchises     | S      | `catalog.ts:886` already fetches TMDB's collection record. Nothing displays it.                                                                                    |
| Calendar                       | M      | `airing` and `newEpisodeCount` are computed today and drive a single badge. A week and month grid inside My Stuff.                                                 |
| Home rows with a reason        | M      | "Because you watched...", "New this week", "Finish these" — all served from the stored ranking, so each row costs a read.                                          |
| More catalogs                  | M      | New releases, in theatres, coming soon, top rated. Today the pool is trending plus a popularity crawl, which makes everything feel like the same twenty titles.    |
| Saved filters                  | S      | Name a filter combination and pin it. `categoryFilters.ts` already exists; only persistence is missing.                                                            |
| Content ratings                | S      | Age and maturity ratings from TMDB and Simkl. Useful alone, and a hard prerequisite for parental controls.                                                         |

## Phase 4 — Make the connected services do something

Four services are connected and mostly watched rather than used. Independent of every other phase —
the best standalone win if you want something to ship this week.

| Work                        | Effort | What it is                                                                                                                                                                                              |
| --------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request via Sonarr / Radarr | S      | `servarr.ts` is a client factory and a queue read. Add `POST /series` and `POST /movie` with quality-profile and root-folder pickers. This is the entire reason Overseerr and Jellyseerr exist.         |
| qBittorrent control         | S      | Pause, resume, delete, add. `qbittorrent.ts` is read-only today.                                                                                                                                        |
| Jellyfin as a real source   | L      | `jellyfin.ts` is `testConnection` plus `getResumeItems`. Browse the library, and make it an actual playback candidate — the README's local → server → download order is not what `stream:resolve` does. |
| Debrid provider abstraction | L      | Extract a provider interface (resolve, cache status, play URL) from `torbox.ts` and add Real-Debrid and AllDebrid behind it. An adoption ceiling more than a feature.                                   |
| Notifications               | M      | The permission is denied wholesale at `main/index.ts:108`. New episode of a tracked show, download ready, friend starting something. Off by default, one settings group, no badges.                     |
| Indexer visibility          | S      | Surface Prowlarr alongside the Servarr pair, so a failed search says which indexer failed.                                                                                                              |

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
