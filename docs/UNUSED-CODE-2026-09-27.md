# Unused code and shipped bloat, verified list (2026-09-27)

Produced by the 2026-09-27 audit (see [AUDIT-2026-09-27.md](AUDIT-2026-09-27.md)). Method: a grep-based scan proposed candidates; one agent per batch classified each by reading the defining file and grepping the whole tree (imports, re-exports, string names, esbuild aliases, CSS-module access, tests, scripts, workflows, electron-builder.yml); every proposed deletion was then checked again by an adversarial verifier that defaulted to "keep" unless it could confirm safety. Only items that survived both passes are listed as deletable. Line numbers were correct at commit 7a3ee9c; re-grep before editing.

| Category                                                          | Count |
| ----------------------------------------------------------------- | ----- |
| Dead exports, functions, constants and types                      | 21    |
| Dead CSS-module classes                                           | 62    |
| Orphaned files                                                    | 2     |
| Orphaned assets shipped in the installer                          | 22    |
| Exports used only inside their own file (drop the export keyword) | 203   |
| Lines removable by the items in sections 3 and 4 alone            | 979   |

## 1. Structural removals

### embed-spike (verdict: remove)

The embed work embedSpike.ts was a spike for has shipped in production (PR #143, cf2d04d, 2026-08-31) via mpvEmbed.ts + playerBridge.ts. embedSpike.ts is unreferenced by anything except a dev-only env-var gate in index.ts, and its own header says it is "throwaway by design (deleted once the embed ships)." Two win32.ts exports exist only to serve it.

Remove:

- src/main/media-hub/embedSpike.ts (entire file, 458 lines)
- src/main/index.ts:168-173 (the R3_EMBED_SPIKE gate block and its dynamic import of embedSpike, 6 lines)
- src/main/media-hub/win32.ts:239-244 (moveCursorTo, 6 lines — docstring says 'spike only')
- src/main/media-hub/win32.ts:246-256 (clickAtScreenPoint, 11 lines — docstring says 'spike only')

Keep:

- src/main/media-hub/mpvEmbed.ts (the shipped production embed module)
- src/main/media-hub/mpv.ts and playerWindow.ts (production callers of mpvEmbed)
- src/main/media-hub/playerBridge.ts (wires mpvEmbed into the app)
- src/main/media-hub/win32.ts's other exports (hwndOf, isWindowAlive, classNameOf, windowPidOf, windowStyleOf, addWindowStyle, removeWindowStyle, listChildTree, findChildByPid, getClientSize, setChildRect, raiseToTopOfSiblings, setShown, win32Available) — all still used by mpvEmbed.ts in production

Risks: Low. embedSpike.ts is gated behind an undocumented env var that nothing in package.json, CI workflows, or docs mentions, so removing it doesn't change any documented or automated entry point. The only real risk is if a developer still runs `R3_EMBED_SPIKE=1` manually to diagnose a regression in the embed (the spike is a useful diagnostic harness even post-ship, since it isolates window-stacking behavior from the rest of the player stack) — if that workflow is still valued, keep the file (or move it to a docs/spikes note) rather than delete outright; otherwise it is safe to delete along with the two win32.ts helpers it alone calls. Double-check no other worktree/branch currently depends on R3_EMBED_SPIKE before deleting, since parallel PRs are known to drift from main per project memory (feedback_pr_workflow.md).

### preview-build (verdict: replace)

The single-file browser-preview pipeline (vite.preview.config.ts + scripts/build-preview.mjs + vite-plugin-singlefile) is wired into nothing — no package.json script, no CI workflow, no test references it, reachable only by manually running the .claude/launch.json "r3-browser-preview" entry. It has been functionally superseded by the web bundle (vite.web.config.ts / npm run build:web), which IS CI-gated (.github/workflows/verify.yml "web" job runs tests/webBundle.e2e.ts and tests/headlessApp.e2e.ts on every PR) and covers the exact same "renderer with no Electron behind it, honest empty states" property the preview build's comments describe. Since the demo catalogue was deleted, the preview no longer has any real content to showcase either — it just paints the same empty states the CI-tested web bundle already proves out, so its remaining ~172 lines of TMDB-image-fetching/caching, CSP-stripping and sandboxed-iframe-origin-shim logic serve no distinguishing purpose. Separately, its only CSS-image dependency chain left two dead JPEGs behind: ai-orb-core.jpg (referenced only in a build-preview.mjs comment describing an AIOrb component removed in commit 331a402) and ai-orb-core-previous.jpg (zero references anywhere) — both still ship in the real Electron app too, since electron-builder copies src/renderer/public/ verbatim with no exclusion for them. Also confirmed: the .claude/launch.json "r3-party-sync" entry points at "../r3v07v3r-party-sync", which does not exist relative to this worktree at all, and even relative to the main checkout resolves to a separate, stale 2-commit scaffold repo (last touched Jul 18) that has been superseded by the actively-developed in-repo party-sync-worker/ (same Cloudflare Worker name "r3-party-sync" in its wrangler.toml, far more history: rate limiting, hibernation, DO migrations, security hardening).

Remove:

- vite.preview.config.ts
- scripts/build-preview.mjs
- src/renderer/public/media/ambient/ai-orb-core.jpg
- src/renderer/public/media/ambient/ai-orb-core-previous.jpg
- package.json:75 ("vite-plugin-singlefile": "^2.3.3" devDependency line, plus its package-lock.json entries)

Keep:

- vite.web.config.ts (the CI-verified no-Electron renderer build — keep as the one no-Electron preview path)
- tests/webBundle.e2e.ts and tests/headlessApp.e2e.ts (already cover the property the singlefile preview claimed to)
- party-sync-worker/ (the real, actively-maintained relay implementation)
- src/renderer/public/media/ambient/nebula-field.jpg (actively used by BackgroundEffects.module.css:17)

Risks: Removing the preview pipeline outright drops the one build that yields a single self-contained HTML file embeddable in a sandboxed iframe/artifact viewer with no server (web-bundle output is multi-file and needs an http origin for its CSP to mean anything) — if anyone relies on that specific "paste one HTML file into a sandboxed viewer" capability (vs. `npx vite preview` against dist-web, which needs a server), that use case has no direct replacement and should be confirmed dead before deleting scripts/build-preview.mjs's sandboxed-origin shim logic. Re-pointing .claude/launch.json's r3-party-sync entry to party-sync-worker/ is low-risk (same worker name, same protocol, actively maintained) but should still be smoke-tested with `wrangler dev` once before relying on it, since the two implementations have diverged (rate limiting, hibernation) and any local dev workflow tuned to the old scaffold's behavior would need to adjust. Deleting the two dead JPEGs is safe (zero code references either), but confirm no external doc/screenshot/marketing asset still points at the old AIOrb art before deleting ai-orb-core-previous.jpg specifically, since its name suggests it was kept as a deliberate before/after reference at some point.

### ai-loop (verdict: user-decision)

The Claude/GPT review loop (.ai/** + scripts/ai-_.ts) is a real, well-documented, self-contained dev tool — but STATE.json and CHANGELOG.md prove it has never once been run since it was added on 2026-07-25 (initial commit), and REQUIREMENTS.md is still the unedited template. It touches nothing in src/, daemon/, or party-sync-worker/ and nothing outside the .ai-_.ts files imports scripts/ai-utils.ts, so removing it is zero-risk to the app. One item is unconditional regardless of the loop's fate: .ai/screenshots/anime-library-qa.png (85,590 bytes) is unreferenced anywhere and was committed by accident inside an unrelated PR (#111, LAN cache daemon) — it doesn't even live in the documented current/ or reference/ subfolder.

Remove:

- `.ai/README.md` (143 lines)
- `.ai/REQUIREMENTS.md` (36 lines)
- `.ai/STATE.json` (8 lines)
- `.ai/CHANGELOG.md` (3 lines)
- `.ai/config.json` (26 lines)
- `.ai/prompts/implementer.md` (27 lines)
- `.ai/prompts/reviewer.md` (49 lines)
- `.ai/screenshots/anime-library-qa.png` (85,590 bytes — remove regardless of the overall verdict; it is stray/unreferenced)
- `.ai/screenshots/current/.gitkeep`
- `.ai/screenshots/reference/.gitkeep`
- `.ai/reports/.gitkeep`
- `scripts/ai-loop.ts` (306 lines)
- `scripts/ai-review.ts` (344 lines)
- `scripts/ai-qa.ts` (134 lines)
- `scripts/ai-screenshots.ts` (247 lines)
- `scripts/ai-utils.ts` (313 lines)
- `package.json:28-31` — the 4 `ai:qa`/`ai:screenshot`/`ai:review`/`ai:loop` script lines
- `eslint.config.mjs:56-59` — the 4-line comment specific to '.ai/ review-loop scripts'; also drop the `'scripts/ai-*.ts'` entry from the `files` array on line 60 (keep `'scripts/**/*.mjs'` on that line — do not delete the whole override block)
- `.gitignore:17-21` — the 'AI development review loop' comment block
- `.gitignore:22-24` — `.ai/reports/*.json`, `.ai/screenshots/current/*.png`, `.ai/screenshots/current/*.jpg`
- `.gitignore:35` — `.ai/spike/`

Keep:

- `playwright` devDependency (package.json:66) — used independently by tests/headlessApp.e2e.ts and tests/webBundle.e2e.ts
- `.gitignore:13-15` — `.env`, `.env.local`, `.env.*.local` — stay because TMDB_API_KEY (used by src/renderer/src/lib/artwork/providers/tmdbProvider.ts) also lives there; only the comment at .gitignore:9-12 needs rewording to drop the OPENAI_API_KEY / .ai/ mention, not deletion
- `eslint.config.mjs:49-55,60-64` — the override for `scripts/**/*.mjs` (TMDB art fetcher, preview post-processor, etc.) stays; only the ai-loop-specific comment lines and glob entry go
- `tsx` devDependency — used everywhere else (tests, all other scripts), unaffected by this candidate

Risks: Zero technical/runtime risk either way: no CI workflow, `npm test`, `npm run build`, or app source (src/, daemon/, party-sync-worker/) references any ai:* script or scripts/ai-utils.ts, so removal cannot break a build or test run. The only real risk is a product/process one — this is a deliberately built, well-documented framework (not accidental cruft), and its two months of inactivity may simply reflect that no one has set up an OPENAI_API_KEY / gotten around to trying it yet, not that it was tried and abandoned. That's a call about Graham's intended workflow, not something inferable from the code alone — hence user-decision rather than an outright remove. The stray screenshot (.ai/screenshots/anime-library-qa.png) carries no such ambiguity and should go either way.

### placeholder-artwork (verdict: user-decision)

Audited 4 assigned candidates in the R3 Media Hub renderer. Two are dead and safe to remove outright (ComingSoonSection, and the tmdb/selfHosted artwork-provider stubs). Two are fully live and should be kept (the six hooks; UserEnvironmentStatus/PerformanceWidget/telemetry chain). Along the way I found a concrete README accuracy bug (a removed feature still advertised) and a permanently-mocked weather widget that's live but fake — both worth a human call, not a mechanical delete.

Remove:

- src/renderer/src/components/placeholder/ComingSoonSection.tsx
- src/renderer/src/components/placeholder/ComingSoonSection.module.css
- src/renderer/src/lib/artwork/providers/tmdbProvider.ts
- src/renderer/src/lib/artwork/providers/selfHostedProvider.ts

Keep:

- src/renderer/src/lib/artwork/index.ts (trim to just the demo pass-through once the two stub files are gone)
- src/renderer/src/lib/artwork/types.ts
- src/renderer/src/lib/artwork/config.ts (trim ArtworkProviderId/ACTIVE_ARTWORK_PROVIDER to drop the dead 'tmdb' branch)
- src/renderer/src/lib/artwork/providers/demoProvider.ts
- src/renderer/src/hooks/useWeather.ts
- src/renderer/src/hooks/useClock.ts
- src/renderer/src/hooks/useMotionSuspended.ts
- src/renderer/src/hooks/useMotionUserDisabled.ts
- src/renderer/src/hooks/useReducedMotion.ts
- src/renderer/src/hooks/useDashboardLayoutMode.ts
- src/renderer/src/components/topbar/UserEnvironmentStatus.tsx
- src/renderer/src/components/home/PerformanceWidget.tsx
- src/renderer/src/hooks/usePerformanceMetrics.ts
- src/main/ipc/telemetry.ts
- src/main/media-hub/telemetryWorker.ts
- systeminformation dependency (package.json)

Risks: Removing tmdbProvider.ts/selfHostedProvider.ts is low-risk: confirmed zero live call sites and an unreachable switch (no env var anywhere sets VITE_ARTWORK_PROVIDER away from 'demo'). Trimming index.ts/config.ts to drop the ArtworkProvider abstraction is slightly higher-touch since types.ts's ArtworkProvider interface is public API surface (re-exported) — a bot should grep for `ArtworkProvider`/`ArtworkProviderId` consumers outside this directory before deleting the interface itself, not just the two provider files. ComingSoonSection removal is essentially zero-risk (no importers, confirmed via full-repo grep). The weather mock and the README staleness are NOT mechanical fixes: deleting the weather readout is a product/UX call (it's a real, visible, always-on feature people may expect even if fake), and the README TMDB claim needs a human to confirm there's no plan to reintroduce "where to watch" before the line is deleted rather than reworded. This audit covered only the four assigned candidates plus what surfaced incidentally (README + Next.js-leftover comments) — a full-repo dead-export sweep (e.g. via a tool like knip/ts-prune, which I could not run — read-only, no npm) would likely surface more, and was out of scope here.

### headless-stubs-styles (verdict: remove)

Audited 5 dead-code candidates in the R3 Media Hub renderer/headless tree. Verdict per candidate: (1) headless stubs — KEEP, false positive (wired via esbuild alias). (2) tokens.scss + sass devDependency — REMOVE, genuinely dead (only .scss file in the repo, zero importers, no build config consumes it, and its values are a stale fork of the live CSS custom properties in global.css). (3) MoviesPage/SeriesPage/AnimePage route wrappers — KEEP, deliberate thin routing adapters (5-6 lines each) that let three routes share one underlying library-page implementation; consistent with every other entry in routes/ being a 1:1 route-to-file mapping. (4) components/downloads/ — KEEP both files, both actively imported into Control Centre's ServicesSection; nothing dead inside the directory, but the directory name is stale relative to its current role (flag for docs, not for deletion). (5) LanCacheSection.tsx vs CachingSection.tsx — KEEP both; confirmed BOTH are simultaneously reachable (standalone /settings via NAV_ITEMS' 'settings' entry renders LanCacheSection when not embedded; Control Centre renders CachingSection). This is intentional per LanCacheSection's own header comment (short card vs. full admin panel) but it is a real duplication risk: the discover/pair/unpair client logic against window.api.mediaHub.lanCache is independently reimplemented in both files rather than shared, so a change to the pairing flow can silently drift between them.

Remove:

- src/renderer/src/styles/tokens.scss
- package.json (devDependencies entry: "sass": "^1.102.0")

Keep:

- src/headless/stubs/electronUpdater.ts
- src/headless/stubs/koffi.ts
- src/renderer/src/routes/MoviesPage.tsx
- src/renderer/src/routes/SeriesPage.tsx
- src/renderer/src/routes/AnimePage.tsx
- src/renderer/src/components/downloads/BackgroundActivitySection.tsx
- src/renderer/src/components/downloads/BackgroundActivity.module.css
- src/renderer/src/routes/LanCacheSection.tsx
- src/renderer/src/components/controlcentre/sections/CachingSection.tsx

Risks: Removing tokens.scss/sass is low-risk (confirmed zero consumers, run a final repo-wide grep for "tokens.scss" and "\.scss" right before deleting in case something was added mid-review, and re-run the renderer build once to be sure Vite's implicit scss handling wasn't silently depended on by a dynamic import). Do NOT remove anything from components/downloads/ or the three route wrapper files — they are live and removing them breaks /movies, /series, /anime and the Control Centre Services face. Do NOT delete either LanCacheSection.tsx or CachingSection.tsx — both are reachable UI, and collapsing them without care would either remove the lightweight standalone-settings pairing card or lose the Control Centre's richer admin controls (budget, household devices, jobs, updater). The real risk there is silent behavioral drift between the two duplicated pairing implementations, not dead code.

## 2. Orphaned files and assets

Everything under src/renderer/public/ is copied verbatim into every build, so the assets below ship in the installer today.

- `src/renderer/src/components/placeholder/ComingSoonSection.tsx`: git rm src/renderer/src/components/placeholder/ComingSoonSection.tsx and its ComingSoonSection.module.css; 29 lines
- `src/renderer/src/styles/tokens.scss`: git rm; 67 lines
- `src/renderer/public/media/ambient/ai-orb-core-previous.jpg`: git rm; 385 KB
- `src/renderer/public/media/ambient/ai-orb-core.jpg`: git rm; 128 KB
- `src/renderer/public/media/backdrops/blade-runner-2049.jpg`: git rm; 55 KB
- `src/renderer/public/media/backdrops/dune-part-two.jpg`: git rm; 57 KB
- `src/renderer/public/media/backdrops/interstellar.jpg`: git rm; 58 KB
- `src/renderer/public/media/backdrops/last-of-us-s2.jpg`: git rm; 59 KB
- `src/renderer/public/media/posters/arrival.jpg`: git rm; 13 KB
- `src/renderer/public/media/posters/blade-runner-2049.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/dune-part-two.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/ex-machina.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/grand-budapest-hotel.jpg`: git rm; 13 KB
- `src/renderer/public/media/posters/her.jpg`: git rm; 13 KB
- `src/renderer/public/media/posters/interstellar.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/john-wick.jpg`: git rm; 12 KB
- `src/renderer/public/media/posters/last-of-us-s2.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/mad-max-fury-road.jpg`: git rm; 14 KB
- `src/renderer/public/media/posters/paddington-2.jpg`: git rm; 13 KB
- `src/renderer/public/media/posters/stranger-things.jpg`: git rm; 13 KB
- `src/renderer/public/media/posters/the-martian.jpg`: git rm; 14 KB
- `src/renderer/public/media/thumbnails/dark.jpg`: git rm; 8 KB
- `src/renderer/public/media/thumbnails/fallout.jpg`: git rm; 9 KB
- `src/renderer/public/media/thumbnails/the-last-of-us.jpg`: git rm; 8 KB

## 3. Dead exports, functions, constants and types

### `src/main/media-hub/anime4kInstall.ts`

- `ANIME4K_ASSET_BYTES` (const, about 2 lines): delete lines 39-40 (doc comment + declaration); if the byte count should actually surface in Settings, that's a separate follow-up to add a bytes field to Anime4kStatus and thread it through appIpc.ts/the renderer

### `src/main/media-hub/core.ts`

- `createRoomCode` (function, about 8 lines): delete function createRoomCode (core.ts:56-62) and its now-unused helper const ROOM_ALPHABET (core.ts:54)

### `src/main/media-hub/mpvEmbed.ts`

- `embedAvailable` (function, about 3 lines): delete the function (lines 50-52); no doc comment sits directly above it to remove

### `src/main/media-hub/playback.ts`

- `CreatePlaybackProxyOptions` (interface, about 5 lines): Delete along with `createPlaybackProxy` (see that finding) — this options type has no purpose without it.
- `PlaybackProxy` (interface, about 4 lines): Delete along with `createPlaybackProxy`.
- `createPlaybackProxy` (function, about 117 lines): Delete the function. Also delete the now-unused non-exported `interface PlaybackSession` (playback.ts:273-276, 4 lines) that only this function used — it wasn't in the candidate list but becomes dead the moment createPlaybackProxy is removed. Combined removable block: playback.ts lines 273-405 (133 lines total, including PlaybackSession + CreatePlaybackProxyOptions + PlaybackProxy + createPlaybackProxy and their separating blank lines).

### `src/main/media-hub/playerBridge.ts`

- `getPlayer` (function, about 3 lines): delete lines 328-330

### `src/main/media-hub/remoteLists.ts`

- `RemoteListService` (type, about 1 lines): delete line 33

### `src/main/media-hub/trakt.ts`

- `TRAKT_PUSHABLE_KINDS` (const, about 2 lines): Delete lines 239-240 (the doc comment and the declaration).

### `src/main/media-hub/win32.ts`

- `GWLP_HWNDPARENT` (const, about 1 lines): delete line 24
- `WS_VISIBLE` (const, about 1 lines): delete line 26
- `WS_CLIPCHILDREN` (const, about 1 lines): delete line 30
- `WS_EX_TOOLWINDOW` (const, about 1 lines): delete line 31

### `src/renderer/src/components/placeholder/ComingSoonSection.tsx`

- `ComingSoonSection` (function, about 98 lines): delete src/renderer/src/components/placeholder/ComingSoonSection.tsx and its co-located ComingSoonSection.module.css (also unused, verified 69 lines with no other consumer); the whole placeholder/ directory becomes empty and can go too

### `src/renderer/src/lib/api/qbittorrent.ts`

- `isPaused` (function, about 13 lines): delete the function and its doc comment (lines 66-78)

### `src/renderer/src/lib/mediaHub/adapters.ts`

- `trackedItemToMediaItem` (function, about 24 lines): delete lines 346-369 (its doc comment plus the function body)

### `src/renderer/src/lib/mediaHub/categoryConfig.ts`

- `CATEGORY_CONFIGS` (const, about 1 lines): delete line 84

### `src/renderer/src/lib/mediaHub/categoryFilters.ts`

- `availableStatuses` (function, about 6 lines): delete lines 258-263 (its doc comment plus the function)

### `src/shared/lancache/protocol.ts`

- `LANCACHE_DEFAULT_PORT` (const, about 1 lines): Delete the export; if a shared default-port constant is wanted, have daemon/config.ts import LANCACHE_DEFAULT_PORT instead of hardcoding 8945.

### `src/shared/media-hub/language.ts`

- `releaseLocalisedInto` (function, about 11 lines): delete lines 315-325 (doc comment + function)

### `src/shared/media-hub/types.ts`

- `PlaybackSelection` (interface, about 8 lines): delete the interface (lines 317-324); no doc comment sits directly above it to remove as well.

## 4. Dead CSS-module classes

- `src/renderer/src/components/category/AnimeLibraryPage.module.css`: `.eyebrow`, `.noResults`, `.actionWatched`, `.actionPlanned` (about 15 lines)
- `src/renderer/src/components/controlcentre/ControlCentre.module.css`: `.header` (about 3 lines)
- `src/renderer/src/components/home/ContinueWatchingPanel.module.css`: `.ratingStar`, `.ratingDivider`, `.ratingImdb` (about 24 lines)
- `src/renderer/src/components/home/FeaturedHero/FeaturedHero.module.css`: `.myList` (about 29 lines)
- `src/renderer/src/components/home/MoodBrowser.module.css`: `.heading` (about 34 lines)
- `src/renderer/src/components/home/RecommendationCarousel/RecommendationCarousel.module.css`: `.ratingStar`, `.ratingDivider`, `.ratingImdb` (about 24 lines)
- `src/renderer/src/components/overlays/Overlays.module.css`: `.modalArt`, `.modalArtTitle`, `.modalBody`, `.metaRow`, `.metaRating`, `.genreChip`, `.description`, `.playback`, `.playbackContent`, `.playPauseButton`, `.playbackScrubberWrap`, `.playbackScrubberTrack`, `.playbackScrubberFill`, `.playbackTimes`, `.playbackClose`, `.skipButton`, `.videoSurface`, `.playerAutoNote`, `.playerBuffering`, `.playerBufferingSpinner`, `.playerControls`, `.playerControlsHidden`, `.playerScrubberTrack`, `.playerScrubberFill`, `.playerScrubberLocked`, `.scrubPreview`, `.scrubPreviewThumb`, `.scrubPreviewImage`, `.scrubPreviewPlaceholder`, `.scrubPreviewTime`, `.playerButtonRow`, `.playerIconButton`, `.playerPartyBadge`, `.playerPartyBadgeWarning`, `.playerFitButton`, `.playerFitLabel`, `.playerTimeLabel`, `.playerTitleLabel`, `.playerMenuWrap`, `.playerMenu`, `.playerMenuHeading`, `.playerMenuItem`, `.playerMenuItemActive`, `.playerVolumeRange` (about 390 lines)
- `src/renderer/src/components/party/RoomsSection.module.css`: `.connState`, `.footerRow` (about 10 lines)
- `src/renderer/src/routes/MyStuff.module.css`: `.calGridEntry` (about 27 lines)
- `src/renderer/src/styles/global.css`: `.breathing-glow`, `.sweep-active` (about 16 lines)

## 5. Exports used only inside their own file

Not dead, but the export keyword misleads readers and tooling. Drop it; no behaviour changes.

- `daemon/activity.ts`: `RestartDecisionInput`
- `daemon/config.ts`: `defaultDataDir`, `DEFAULTS`
- `daemon/fetcher.ts`: `FetcherDeps`
- `daemon/jobs.ts`: `JOB_EXPIRY_MS`
- `daemon/launcher.ts`: `PlanBootOptions`, `pruneKeepList`, `LauncherOptions`
- `daemon/mdns.ts`: `MdnsAnnouncer`
- `daemon/roomsHop.ts`: `RoomsHop`
- `daemon/server.ts`: `ServerDeps`
- `daemon/storage.ts`: `DISK_PRESSURE_MARGIN_BYTES`
- `daemon/titleCrawler.ts`: `MAX_CINEMETA_PAGES`, `MAX_KITSU_PAGES`, `PageFetcher`, `fetchCatalogPage`
- `daemon/updateFeed.ts`: `UPDATE_ASSET`, `UPDATE_CHECKSUM_ASSET`
- `party-sync-worker/src/room.ts`: `MAX_ROOM_CONNECTIONS`, `MAX_BANNED_MEMBERS`, `isValidMemberId`, `AdmissionVerdict`
- `src/headless/electronShim/index.ts`: `HEADLESS_RENDERER_URL`, `PushSink`, `HeadlessWebContents`
- `src/main/media-hub/anilist.ts`: `AnilistAiringNode`
- `src/main/media-hub/anime4kInstall.ts`: `ANIME4K_RELEASE_TAG`, `ANIME4K_ASSET`, `ANIME4K_SHA256`, `anime4kDir`
- `src/main/media-hub/animeSeasons.ts`: `TvdbMapping`
- `src/main/media-hub/animeSyncRepair.ts`: `animeRepairDone`
- `src/main/media-hub/aniskip.ts`: `kitsuMalId`, `aniskipTimes`
- `src/main/media-hub/backgroundJobs.ts`: `RecurringJob`, `registerRecurringJob`, `requestJobRun`, `activitySnapshot`
- `src/main/media-hub/backup.ts`: `BACKUP_TABLES`
- `src/main/media-hub/catalog.ts`: `catalogListing`
- `src/main/media-hub/continuations.ts`: `RECENT_WATCH_WINDOW_MS`, `RECENT_WATCH_LIMIT`
- `src/main/media-hub/core.ts`: `StreamLimits`, `isUnsafeStream`, `CHECKCACHED_BATCH`, `RankOptions`, `ANIME_STORY_ORDER`, `ParsedReleaseName`, `parseReleaseName`
- `src/main/media-hub/credits.ts`: `cachedCredits`
- `src/main/media-hub/downloadGuard.ts`: `blockedDownloads`
- `src/main/media-hub/episodeAiring.ts`: `SeasonNumbering`
- `src/main/media-hub/httpClient.ts`: `FetchScheduling`
- `src/main/media-hub/lanCacheTitleSync.ts`: `TitleSyncReport`
- `src/main/media-hub/logger.ts`: `redactUrls`
- `src/main/media-hub/mal.ts`: `MalListEntry`, `MalListStatus`
- `src/main/media-hub/movieHash.ts`: `StreamMovieHash`
- `src/main/media-hub/mpv.ts`: `BUFFER_PROFILES`, `bufferProfileFor`
- `src/main/media-hub/notifications.ts`: `checkForNewEpisodes`
- `src/main/media-hub/ollamaService.ts`: `OllamaConfig`
- `src/main/media-hub/party.ts`: `isValidEndpoint`, `deriveKey`, `queueScore`, `sortQueue`
- `src/main/media-hub/playerWindow.ts`: `getPlayerOverlay`
- `src/main/media-hub/roomIdentity.ts`: `rawPublicKey`, `publicKeyFromRaw`
- `src/main/media-hub/roomRules.ts`: `KICKED_MEMBERS_KEPT`
- `src/main/media-hub/rooms.ts`: `setRoomsActivity`
- `src/main/media-hub/settingsStore.ts`: `malAccountMark`
- `src/main/media-hub/simkl.ts`: `SimklMediaRef`, `SimklEpisodeRef`, `SimklSeasonEntry`, `SimklShowRef`, `SimklScrobblePayload`, `mediaIds`, `SimklHistoryEntry`
- `src/main/media-hub/simklClient.ts`: `SimklWatchedSnapshot`
- `src/main/media-hub/streamCache.ts`: `ChunkStore`, `RangeReplyVerdict`, `RetentionParams`, `StreamCacheStartResult`, `CreateStreamCacheOptions`, `LocalCacheCandidate`
- `src/main/media-hub/subdl.ts`: `SUBDL_DOWNLOAD_ORIGIN`, `SubdlRawEntry`
- `src/main/media-hub/taskScheduler.ts`: `LaneConfig`, `ScheduleOptions`, `SchedulerSnapshot`
- `src/main/media-hub/titleStatusRules.ts`: `SeasonEpisodes`, `TitleState`, `TitleStatusStep`
- `src/main/media-hub/trakt.ts`: `TraktIds`, `TraktSyncPayload`, `TraktScrobblePayload`, `TraktHistoryRow`, `TraktRatingRow`
- `src/main/media-hub/traktClient.ts`: `TraktDeviceCode`, `TraktStatus`, `clearTraktTokens`, `requestDeviceCode`, `TraktPollOutcome`, `pollDeviceToken`
- `src/main/media-hub/watchlists.ts`: `PLANNED_SOURCES_CACHE_KEY`, `PlannedEntry`, `PlannedSources`, `twoWaySyncEnabled`
- `src/main/media-hub/win32.ts`: `GW_HWNDNEXT`, `GW_CHILD`, `SW_HIDE`, `SW_SHOWNA`, `GWL_STYLE`, `GWL_EXSTYLE`, `HWND_TOP`, `classNameOf`, `windowPidOf`, `windowStyleOf`
- `src/renderer/src/components/category/CategoryFilterBar.tsx`: `CategoryFilterBarProps`
- `src/renderer/src/components/category/MediaGrid.tsx`: `MediaGridProps`
- `src/renderer/src/components/detail/ContextBackButton.tsx`: `ContextBackButtonProps`
- `src/renderer/src/components/detail/DetailHero.tsx`: `DetailHeroProps`
- `src/renderer/src/components/detail/EpisodesSection.tsx`: `EpisodesSectionProps`
- `src/renderer/src/components/detail/ProgressPanel.tsx`: `ProgressPanelProps`
- `src/renderer/src/components/detail/SimilarPanel.tsx`: `SimilarPanelProps`
- `src/renderer/src/components/home/CompactAIAssistant/RecommendationActions.tsx`: `RecommendationActionsProps`
- `src/renderer/src/components/home/CompactAIAssistant/index.tsx`: `CompactAIAssistantProps`
- `src/renderer/src/components/home/ContinueWatchingPanel.tsx`: `ContinueWatchingPanelProps`
- `src/renderer/src/components/home/FeaturedHero/FeaturedHero.tsx`: `FeaturedHeroProps`
- `src/renderer/src/components/home/RecommendationCarousel/index.tsx`: `PlannedRail`
- `src/renderer/src/components/media/ArtworkImage.tsx`: `ArtworkImageProps`
- `src/renderer/src/components/media/TitleStatusButton.tsx`: `TitleStatusButtonProps`
- `src/renderer/src/components/media/artworkRetry.ts`: `ArtworkLoadStatus`
- `src/renderer/src/context/OverlayContext.tsx`: `ContextMenuTarget`, `OverlayActions`, `OverlayState`
- `src/renderer/src/context/PlayerWindowContext.tsx`: `PlayerWindowValue`
- `src/renderer/src/hooks/updateStatusStore.ts`: `UpdateStoreState`
- `src/renderer/src/hooks/useAsyncAction.ts`: `AsyncActionOptions`, `AsyncActionResult`
- `src/renderer/src/hooks/useDashboardLayoutMode.ts`: `DashboardLayoutMode`, `SHORT_QUERY`
- `src/renderer/src/hooks/usePartySync.ts`: `PartySyncNotice`, `PartySync`
- `src/renderer/src/hooks/usePlayerTracking.ts`: `PlayerTracking`
- `src/renderer/src/hooks/useUpdateManager.ts`: `UPDATE_STATE_LABEL`, `UpdateManager`
- `src/renderer/src/hooks/useYoutubeEmbedControls.ts`: `YoutubeEmbedControls`
- `src/renderer/src/lib/api/jellyfin.ts`: `JellyfinResumeItem`
- `src/renderer/src/lib/api/prowlarr.ts`: `FailingIndexer`
- `src/renderer/src/lib/api/servarr.ts`: `ServarrSystemStatus`, `ServarrQueueItem`, `createServarrClient`
- `src/renderer/src/lib/artwork/config.ts`: `ArtworkProviderId`
- `src/renderer/src/lib/floatingPanel.ts`: `FloatingPanelPosition`
- `src/renderer/src/lib/mediaHub/assistantSearch.ts`: `MAX_ASSISTANT_RESULTS`
- `src/renderer/src/lib/mediaHub/categoryConfig.ts`: `CategoryFilterFields`
- `src/renderer/src/lib/mediaHub/categoryFilters.ts`: `NO_HIDE_DEFAULTS`
- `src/renderer/src/lib/mediaHub/detailAdapters.ts`: `MOVIE_DETAIL_CONFIG`, `SERIES_DETAIL_CONFIG`, `ANIME_DETAIL_CONFIG`
- `src/renderer/src/lib/mediaHub/moodSpotlight.ts`: `MoodWatchStateFilters`, `MoodSpotlightShuffle`
- `src/renderer/src/lib/mediaHub/startupSnapshot.ts`: `HomeFeedSnapshot`, `TrackingState`
- `src/renderer/src/lib/mediaHub/useCatalogBrowse.ts`: `BROWSE_PAGE_SIZE`, `CatalogBrowseResult`
- `src/renderer/src/types/index.ts`: `MatchTier`
- `src/renderer/src/web/transport.ts`: `BridgeState`
- `src/shared/lancache/mdnsWire.ts`: `CLASS_IN`, `CLASS_IN_FLUSH`, `DnsQuestion`, `DnsRecordData`, `DnsMessage`
- `src/shared/lancache/titleSync.ts`: `SanitizedTitleRow`
- `src/shared/media-hub/anime4k.ts`: `DEFAULT_ANIME4K_MODE`, `isAnime4kMode`
- `src/shared/media-hub/catalog-logic.ts`: `FilterCatalogOptions`, `EpisodeWatchState`, `WatchableItem`, `SimilarSource`, `RAIL_MIN_ITEMS`, `RAIL_MAX_ITEMS`, `RAILS_MAX`, `CadenceShares`, `CadenceProfile`, `WeightedCredits`, `TasteProfile`, `CONTINUATION_BOOST`
- `src/shared/media-hub/partySync.ts`: `RATE_GAIN`
- `src/shared/media-hub/playbackBuffer.ts`: `PLAYBACK_BUFFER_SECONDS`
- `src/shared/media-hub/skipChapters.ts`: `ChapterMark`, `ChapterSkipWindows`
- `src/shared/media-hub/speedTest.ts`: `FIRST_SAMPLE_BYTES`, `MIN_SAMPLE_SECONDS`, `MAX_SAMPLE_BYTES`
- `src/shared/media-hub/subtitleStyle.ts`: `SubtitleColor`
- `src/shared/media-hub/types.ts`: `AnimeStoryRelation`, `SubtitleProvider`
- `src/shared/media-hub/unsafeFiles.ts`: `BLOCKED_EXTENSIONS`, `BLOCKED_MIME_TYPES`
- `src/shared/media-hub/upcomingEpisodes.ts`: `MarkUpcomingOptions`

## 6. Kept on purpose

- `src/shared/media-hub/language.ts` `SELECTABLE_LANGUAGES`: Defined language.ts:363-392 with the doc comment 'The languages offered in Settings' (26 codes), but nothing in the tree references it. Instead src/renderer/src/routes/SettingsPage.tsx:106-113 hand-ro
- `src/shared/media-hub/playbackBuffer.ts` `PlaybackBufferPreset`: Defined playbackBuffer.ts:8, used internally as the Record key type (line 10) and as normalizePlaybackBuffer's return type (line 16). normalizePlaybackBuffer is imported and called cross-file (src/mai
- `src/renderer/src/components/home/FeaturedHero/FeaturedHero.module.css` `w3`: Not a real CSS class definition — there is no `.w3 { }` rule anywhere in this file. The only occurrence of the substring 'w3' is inside the data-URI grain texture at line 215 (`url("data:image/svg+xml
- `src/renderer/src/components/home/FeaturedHero/FeaturedHero.module.css` `org`: Not a real CSS class definition — there is no `.org { }` rule anywhere in this file. The substring 'org' only appears inside `var(--ease-organic, ease-in-out)` at line 110 and inside the same w3.org S
- `src/renderer/src/components/layout/BackgroundEffects.module.css` `jpg`: Not an actual CSS class selector — there is no `.jpg { ... }` rule in the file. The only occurrence of the substring `jpg` is inside `background-image: url('/media/ambient/nebula-field.jpg')` at line
- `package.json` `framer-motion`: Only import site in the whole repo: src/renderer/src/components/layout/AppShell.tsx:2 ('motion', 'useAnimationControls'), with exactly one <motion.div> wrapper (lines 154-193). A ~50KB+ runtime depend
- `package.json` `vite-plugin-singlefile`: Used only by vite.preview.config.ts:4,19 to produce the single-file preview-dist build that scripts/build-preview.mjs post-processes and that scripts/ai-screenshots.ts:44 lists 'preview-dist' as a can
- `scripts/ai-utils.ts` `undici`: scripts/ai-utils.ts:256 does `const undici = await import('undici')` (only when an HTTPS_PROXY env var is set), and the code's own comment at line 259 states 'undici isn't a direct dependency of this

## 7. Duplication (not dead code, but bloat)

- **[high] Standalone settings page carries an unreachable full layout: LanCacheSection is dead, column-pack grid and category nav never run, and the control centre mounts SettingsPage six times** (about 420 lines). Files: `src/renderer/src/routes/SettingsPage.tsx`, `src/renderer/src/routes/LanCacheSection.tsx`, `src/renderer/src/components/controlcentre/ControlCentreFace.tsx`, `src/renderer/src/components/controlcentre/sections/CachingSection.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/routes/Settings.module.css`. SettingsPage is called in exactly two ways: App.tsx:125 `<SettingsPage />` (embedded=false, no category) and ControlCentreFace.tsx:153-156 `<SettingsPage embedded category=...>`. No other callers exist anywhere in src/ or tests/. The first call always takes the early return at SettingsPage.tsx:1309 (`if (!embedded && !category)`), which renders the short viewer page. So the full layout from Settin Proposed fix: Delete routes/LanCacheSection.tsx and its import and render at SettingsPage.tsx:6 and 1948. Delete useColumnPackGrid and the six calls to it, the pageHeader and categoryNav block at 1423-1465, and the .categoryNav CSS. Split SettingsPage into two components: QuickSettingsPage for the /settings route
- **[high] Connect/disconnect flow for key-based accounts is copied five times in MediaHubSettingsSections, and a sixth time in PipelineSection's AccountPanel** (about 280 lines). Files: `src/renderer/src/routes/MediaHubSettingsSections.tsx`, `src/renderer/src/components/controlcentre/sections/PipelineSection.tsx`. TorBoxSection (MediaHubSettingsSections.tsx:56-143), TmdbSection (144-232), OmdbSection (233-327), SubDLSection (712-799) and OpenSubtitlesSection (800-925) each hand-write the same body: `const [apiKey,setApiKey]`, `connect()` calling api.X.connect(key.trim()), `setStatus({ kind: 'ok', message: 'Connected.' })` on success, `result.message || 'Could not connect.'` on failure, and a catch that maps Proposed fix: Add a `useKeyedAccount({ connect: (key, extra?) => Promise<{ok,message}>, disconnect: () => Promise<void> })` hook that returns {apiKey, setApiKey, status, connect, disconnect} and calls refreshMediaHubSettings internally. Add a `<KeyedAccountCard id title description connected extraFields?>` presen
- **[medium] Service connection config (Sonarr/Radarr/qBit/Prowlarr/Bazarr/Jellyfin) has three independent loaders, three copies of TESTERS, two field editors and two copies of the merge-on-save logic** (about 130 lines). Files: `src/renderer/src/routes/MediaServicesSection.tsx`, `src/renderer/src/components/controlcentre/sections/ServicesSection.tsx`, `src/renderer/src/components/controlcentre/sections/PipelineSection.tsx`. The same TESTERS map is declared three times: MediaServicesSection.tsx:16-23, ServicesSection.tsx:46-53 and PipelineSection.tsx:42-49, each with its own six testConnection imports. SECRET_LABEL is declared twice and the two copies have already drifted in capitalisation: MediaServicesSection.tsx:25-32 says 'API Key' and 'Username:Password', while PipelineSection.tsx:50-57 says 'API key' and 'Userna Proposed fix: Create lib/api/serviceRegistry.ts exporting SERVICE_TESTERS, SECRET_LABEL (one capitalisation) and the ORDER/ROLE metadata that is currently only in ServicesSection.tsx:58-67. Add a `useServiceSettings()` hook, or a small store, that loads once, exposes {settings, patch(id, config), save()} with the
- **[medium] AppStateContext still carries write-only state from the removed PlaybackOverlay and other unused fields, duplicated by usePartySync and PlayerOverlayWindow** (about 90 lines). Files: `src/renderer/src/context/AppStateContext.tsx`, `src/renderer/src/hooks/usePartySync.ts`, `src/renderer/src/lib/mediaHub/hooks.ts`. PlaybackOverlay no longer exists: `find -name PlaybackOverlay*` returns nothing. It is still mentioned 9 times in AppStateContext comments, and its API remains in the context value. Grep of every file outside AppStateContext finds zero consumers for these fields: playbackResult, playbackTracks, setPlaybackResult and setPlaybackTracks (typed at 457-465, state at 649-650, written at 1861-1862 and 19 Proposed fix: Remove playbackResult, playbackTracks and their setters, partyPendingSeek and consumePartyPendingSeek, suggestToParty, catalogLoading and assistantQuery/setAssistantQuery from AppStateValue, the provider state, the value object and the deps array. Keep refreshPartyStatus internal-only, since nothing
- **[low] The same fetch/cancel/generation-refresh boilerplate is repeated in hooks.ts's library hooks** (about 60 lines). Files: `src/renderer/src/lib/mediaHub/hooks.ts`. useMediaHubWatchedIds (hooks.ts:511-548) and useMediaHubDislikedIds (hooks.ts:564-590) share one skeleton: a `[generation,setGeneration]` state, an effect guarded by `let cancelled=false` and `window.api?.mediaHub`, a `.then` that sets the data plus `setLoaded(true)`, a swallowed catch, a `refresh = useCallback(() => setGeneration(g=>g+1))`, and a useMemo'd result. useMediaHubPlays (708-754) and u Proposed fix: Add a private `useLibraryResource<T>(libraryKey, fetch: (api) => Promise<T>, { loadedOnError })` that returns {data, loaded, refresh}, and implement watchedIds, dislikedIds, plays and ratings on top of it. Make the loaded-on-error behaviour an explicit option, so the difference between plays and wat
- **[low] Orphaned rating CSS in two modules after both panels moved to the shared RatingBadge** (about 60 lines). Files: `src/renderer/src/components/home/ContinueWatchingPanel.module.css`, `src/renderer/src/components/home/RecommendationCarousel/RecommendationCarousel.module.css`. There is only one rating-badge implementation: components/detail/RatingBadge.tsx:59. ContinueWatchingPanel.tsx:126 and RecommendationCarousel/MediaCard.tsx:193 both render <RatingBadge>. The .ratingStar, .ratingStar svg, .ratingDivider and .ratingImdb rules are still defined in ContinueWatchingPanel.module.css:285-313 and RecommendationCarousel.module.css:423-451. No .tsx anywhere references style Proposed fix: Delete .ratingStar, .ratingStar svg, .ratingDivider and .ratingImdb from both modules, along with the cross-reference comment at ContinueWatchingPanel.module.css:274-279. Keep .ratings and .cardRatings.
- **[low] Update card presentation exists twice (AboutUpdateSection and UpdatesSection), though the logic is correctly shared** (about 40 lines). Files: `src/renderer/src/routes/AboutUpdateSection.tsx`, `src/renderer/src/components/controlcentre/sections/UpdatesSection.tsx`. Both call useUpdateManager: AboutUpdateSection.tsx:19 and UpdatesSection.tsx:43. The shared hook is the intended design, so there is no logic drift. The markup is still duplicated. The offered-versus-running notes block is at AboutUpdateSection.tsx:113-124 and UpdatesSection.tsx:126-135, with identical label logic (`What's new in v${status.version ?? 'the update'}`). The stable/preview radiogroup Proposed fix: Export UpdateNotes and an UpdateChannelPicker from one module, for example components/updates/, with a `variant: 'compact' | 'full'` prop. Use them in both surfaces and keep only the page-specific framing in each.
- **[low] AnimeLibraryPage.tsx is the generic library page for all three categories, not an anime fork; the file name misleads docs and readers** (about 5 lines). Files: `src/renderer/src/components/category/AnimeLibraryPage.tsx`, `src/renderer/src/routes/MoviesPage.tsx`, `src/renderer/src/routes/SeriesPage.tsx`, `src/renderer/src/lib/mediaHub/categoryConfig.ts`. The three routes all render the same component. MoviesPage.tsx:1-5 and SeriesPage.tsx:1-5 import `LibraryPage` from components/category/AnimeLibraryPage and pass MOVIES_CONFIG or SERIES_CONFIG. AnimeLibraryPage.tsx:1360-1362 is a three-line wrapper that passes ANIME_CONFIG to the same `LibraryPage` (defined at line 763). The code is not duplicated; the name misleads. There is also a small dead exp Proposed fix: Rename AnimeLibraryPage.tsx and its .module.css to LibraryPage.tsx and LibraryPage.module.css. Remove the AnimeLibraryPage wrapper and have routes/AnimePage.tsx render `<LibraryPage config={ANIME_CONFIG}/>` the way Movies and Series do. Delete the unused CATEGORY_CONFIGS export. Update any README th
- **[high] Two per-title serial push queues (one a hand-rolled copy of the other), so plan and history pushes are not actually ordered against each other** (about 20 lines). Files: `src/shared/media-hub/serialQueue.ts`, `src/main/media-hub/watchlists.ts`, `src/main/media-hub/tracking.ts`. src/shared/media-hub/serialQueue.ts:26-47 defines createKeyedSerialQueue. tracking.ts:160 uses it (remotePushQueue, keyed `${type}:${id}` at tracking.ts:162-164). watchlists.ts:681-689 plus :763 re-implement the same keyed promise-chain algorithm line for line (planChangeChains: a Map<string, Promise<void>>, keyed by bare id). The set-title-status 'track' step at tracking.ts:1669-1672 runs `queueR Proposed fix: Delete planChangeChains (watchlists.ts:681-689, :763). Export one shared queue: move `remotePushQueue`and`remotePushKey`into a small module such as src/main/media-hub/titlePushQueue.ts, or pass it in. Have pushLocalPlanChange run`applyPlanChange` on that queue, using the same key format as track
- **[medium] Bounded-fetch and validated-redirect logic exists in 3-6 inconsistent copies, and several main-process downloads are uncapped** (about 70 lines). Files: `src/shared/media-hub/responseLimit.ts`, `daemon/updater.ts`, `src/main/media-hub/anime4kInstall.ts`, `src/main/media-hub/subtitlesService.ts`, `src/main/media-hub/httpClient.ts`, `src/main/ipc/httpProxy.ts`, `src/main/media-hub/playback.ts`. There are two streaming byte-cap readers with the same algorithm: responseLimit.ts:19-50 (readLimitedResponseText, used only by httpProxy.ts:113) and daemon/updater.ts:145-166 (readCapped). Two call sites use the 'buffer then measure' form, which updater.ts:139-142 itself calls 'not a cap at all': anime4kInstall.ts:117-120 and subtitlesService.ts:185-193. Two paths have no cap at all: httpClient.t Proposed fix: Create src/shared/media-hub/boundedFetch.ts (Electron-free, so the daemon can import it). It should export `readCappedBytes(response, maxBytes): Promise<Uint8Array>`, `readCappedText(...)` built on top of it, and `fetchWithValidatedRedirects(url, init, validateHop: (url) => void | Promise<void>, max
- **[medium] TorBox create/list/pick-file/requestdl chain duplicated between the app and the daemon (magnet builder x3)** (about 35 lines). Files: `src/main/media-hub/torbox.ts`, `daemon/torbox.ts`, `src/main/media-hub/core.ts`. The magnet URI is built three times: torbox.ts:825-826, torbox.ts:997-1000 and daemon/torbox.ts:29-36. The 'prefer the add-on fileIdx when it names a real video file, else selectVideoFile' rule, with the same `/\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i` regex, appears at torbox.ts:1032-1043 and daemon/torbox.ts:88-95. Parsing the requestdl `data` field (string, or {url|download_url}) appears at torbox.ts Proposed fix: Add pure helpers to core.ts, which is already shared with the daemon: `torboxMagnet(infoHash, trackers)`, `pickTorBoxFile(files, fileIdx, season, episode)` (with the video-extension regex as one constant) and `requestDlUrl(payload)`. Replace the three magnet builders and both file-pick blocks with c
- **[medium] Simkl/Trakt/MAL fan-out and payload builders repeated per service; dead per-service result fields** (about 90 lines). Files: `src/main/media-hub/tracking.ts`, `src/main/media-hub/simkl.ts`, `src/main/media-hub/trakt.ts`, `src/main/media-hub/simklClient.ts`, `src/main/media-hub/malSync.ts`, `src/main/media-hub/traktClient.ts`, `src/shared/media-hub/types.ts`. The same three-service push triple `[syncSimklHistory(...), pushTrakt*(...), pushMal*(...)]` is spelled out five times: tracking.ts:244-246, 259-265, 1453-1457, 1475-1479 and 1502-1506. simkl.ts:124-296 and trakt.ts:95-233 are parallel builders (historyPayload, seasonHistoryPayload, titleHistoryPayload, scrobblePayload) that share the season/episode block logic and the season-0-safe `numberOr`. nu Proposed fix: (1) Add `numberOr` to src/shared/media-hub/ (for example next to rating.ts) and delete the five copies. (2) Export `SERVICE_USER_AGENT()` from settingsStore or simklClient and use it at all six sites. Let simklPublicRequest take an explicit clientId so the PIN start/poll handlers can use it instead
- **[medium] LAN-cache wire types re-declared in the daemon; the 'shared contract' is only enforced on the client side** (about 30 lines). Files: `src/shared/lancache/protocol.ts`, `daemon/titles.ts`, `daemon/titleCrawler.ts`, `daemon/updater.ts`, `daemon/server.ts`, `daemon/mdns.ts`. The protocol.ts:1-5 header says the daemon and the main process 'both import it' to prevent drift. In fact the daemon imports only LANCACHE_SERVICE_TYPE (daemon/mdns.ts:23), and the main side is lanCache.ts plus CachingSection.tsx. The daemon keeps its own copies: RefreshAnswer (titleCrawler.ts:24-28) matches LanCacheTitlesRefreshResponse (protocol.ts:152-159) field for field; DaemonTitleRow and T Proposed fix: Have the daemon import the shared types. Define RefreshAnswer as `LanCacheTitlesRefreshResponse`. Make TitleListPage `Omit<LanCacheTitlesResponse,'rows'> & { rows: DaemonTitleRow[] }`, with DaemonTitleRow extending LanCacheTitleRow and narrowing `item: CatalogItem`. Make UpdaterStatus `LanCacheStatu
- **[medium] Rooms/party relay: three POST /host callers, a production-unused verifyCryptogram, and stale share-code comments** (about 40 lines). Files: `src/main/media-hub/party.ts`, `src/main/media-hub/rooms.ts`, `src/main/media-hub/watchParty.ts`, `src/main/media-hub/roomIdentity.ts`, `daemon/roomsHop.ts`. POST `${url}/host` is written three times: watchParty.ts:876-883 (fetchJson), watchParty.ts:1457-1461 (the Settings 'test' handler, which mints a real relay room just to check the key) and rooms.ts:788-797. The rooms.ts copy uses raw `fetch` with no timeout, no scheduler lane and an unbounded `response.json()`; rooms.ts:984 does the same for /kick. roomIdentity.verifyCryptogram (roomIdentity.ts:15 Proposed fix: Add `requestRelayRoom(creds, { membership?: boolean })` in a small relay module (or party.ts) that goes through fetchJson and returns `{ roomId, roomToken, joinSecret? }`. Use it from watchParty host, rooms create and the Settings test. The test could use a cheaper endpoint if the worker has one; ot
- **[low] database.ts transaction/statement boilerplate and duplicated id-fold logic** (about 130 lines). Files: `src/main/media-hub/database.ts`, `src/main/media-hub/tracking.ts`. Eleven write methods repeat the same ~8-line `durable(() => { sql.exec('BEGIN'); try { ...; sql.exec('COMMIT') } catch (e) { sql.exec('ROLLBACK'); throw e } })` block. Examples: database.ts:1744, 1888, 1916, 2063-2081 (mergeContentId) and 2095-2125 (remapContentIds). The helper durable() at database.ts:979-986 wraps only the pragma. `return fail(error as Error)` appears 28 times. The PreparedQueri Proposed fix: Add `durableTx<T>(fn: () => T): T` next to durable(), running PRAGMA FULL, then BEGIN, fn, COMMIT, with ROLLBACK on throw and PRAGMA NORMAL in finally. Replace the 11 blocks with it. Declare `q` with `satisfies Record<string, StatementSync>` and derive `type PreparedQueries = typeof q` so the 70-lin
- **[low] torbox.ts (and playbackSession.ts) comments still describe the removed library:list / library:play handlers** (about 4 lines). Files: `src/main/media-hub/torbox.ts`, `src/main/media-hub/playbackSession.ts`. The torbox.ts:5-6 header lists 'the TorBox "library" (mylist) view (library:list, library:play)'. The torbox.ts:434 JSDoc says the function 'Registers app:bootstrap, torbox:connect/disconnect, stream:resolve, play:stream, and library:list/play', but the only handle() calls are at torbox.ts:436 (bootstrap), 450 (torboxConnect), 469 (torboxDisconnect), 477 (streamResolve) and 860 (playStream). ipc-c Proposed fix: Rewrite the torbox.ts header (lines 1-8) to list the handlers that actually exist: bootstrap, torbox connect/disconnect, stream:resolve and play:stream. Drop the '1:1 port' claim, or limit it to the parts that are still 1:1. Fix the JSDoc at torbox.ts:434 and the reference at playbackSession.ts:187.
