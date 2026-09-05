# State-propagation audit — 2026-09-05

The question this audit set out to answer: when something about a title
changes in one place — it is marked watched, planned, rated, played to the
end — does every surface that shows that state agree, without a restart or
a lucky refetch? And, alongside it, why a film stopped at about 80% for
Graham on 2026-09-04 with two dead Play clicks after it.

Method: three multi-agent workflow runs over the tree at `1768aa9`
(preview). The one that completed mapped seven subsystems (main writes,
the renderer state hub, every renderer surface, the IPC contract, the
player pipeline, external sync, and the derivation rules), hunted with
eight lenses, and put every candidate through two adversarial verifiers.
Of 38 candidates, 18 were confirmed by both verifiers, 14 were split, 6
were rejected. Everything confirmed is fixed on this branch; the split
items are listed below for a decision.

## How state propagates

Main never told the renderer about library writes. The only pushes from
main are for playback, parties, rooms, updates, activity, downloads and
the reconcile queue. After any write the renderer refetches from its own
call site: `refreshWatchStatus()` in `AppStateContext.tsx` re-runs the
home feed and the watched-id set and bumps `watchStatusVersion`, and each
mutation action (`toggleMyList`, `toggleDisliked`, `markContinueWatching`,
`resolveSyncDiscrepancy`) calls the refreshes it knows about. Every
library hook in `lib/mediaHub/hooks.ts` is keyed by
`libraryKey = activeProfileId:libraryEpoch`, so a profile switch or a
restore re-keys them all.

That rule has no answer for writes the renderer never asked for. The
hourly watchlist pull tracks titles; a MAL reconcile marks whole seasons
and pulls scores down; the anime id repair moves history under merged
shows; the household title sync grows the browse index. Before this
branch each of those reached the screen only when something unrelated
happened to refetch.

**What changed:** main now pushes `mediahub:library:changed`
(`notifyLibraryChanged(source, ...scopes)` in `rendererBridge.ts`,
scopes `history | planned | ratings | index | all`, coalesced over 300 ms).
`AppStateContext` refreshes the home feed and watched ids for `history`
and `planned`, re-keys the ratings hook for `ratings`, and re-keys the
whole library for `all`; the browse pages bump their index token on
`index`. Any new main-initiated library write must call it.

## Confirmed and fixed

Grouped by commit. Finding ids are the audit's own.

### Stream cache integrity — `4a01c1e`

- **C6** `streamCache.ts` wrote whatever a range fetch answered with into
  chunk files: a whole-file 200 from byte 0, an expired link's error page,
  a 206 for another file. The bytes were served as the film and decoded as
  pictures jumping and smearing. `inspectRangeReply` now refuses anything
  that is not the bytes asked for (tests in `tests/streamCache.test.ts`).
- **C1** A region that could not be filled ended mpv's body cleanly: the
  502 guards sat after the header had gone out, so the film looked
  finished. The ranged reply now carries `content-length`, and a starved
  reader has its connection destroyed so mpv's HTTP layer reconnects
  (`--stream-lavf-o=reconnect…` in `mpv.ts`).
- **C2 / C7** `serveRange` read chunks through the live session token,
  which `stop()` clears; a reader still draining resolved to
  `stream-cache/chunk-N.bin` with no session directory — the ENOENT in the
  log. Readers capture their token, and an empty token is refused.
- **C8** A short chunk marked ready mid-file made the server serve zero
  bytes forever. A short body before the known end is a failed chunk, and
  a session with no known length learns it from the ranged reply.

### TorBox resolve — `88d338b`

- **C5** A resumed session dropped the add-on's file index and trackers,
  so a replay guessed the file by name. `CacheSourceRef` now carries both.
- **S2** The forced retry never bypassed TorBox's own listing cache, so
  both attempts of a click got the same stale body. It passes
  `bypass_cache` now.
- **S9** A torrent listed before its file list arrived was pinned for six
  hours as a torrent with no video. File-less entries are no longer cached.

### Player end-of-stream — `690ce7f`, `b7c2542`

- **S1** An end of file with the playhead nowhere near the end is a broken
  stream, not a finished film: the overlay's eof effect now checks
  `WATCHED_FRACTION` before raising mark-watched, so a truncated stream is
  not recorded as watched and the cache a resume needs is not deleted.
- **S3** Error toasts carrying an action stay until dismissed
  (`OverlayContext.tsx`); a Retry that vanished in 4.2 s was invisible.
- **C12** A controls renderer that dies is reloaded onto the running title
  (`playerWindow.ts`) instead of leaving mpv playing with no controls.
- **C11** Quitting the app writes the live playhead to the resume bookmark
  from main (`flushPlaybackPosition` in `playerBridge.ts`); no renderer
  gets a turn on the way out.
- **S5** Dropped-frame bursts are logged with position and buffer lead
  (`media-hub:player:frames`) so judder leaves a trace.
- **S8** An mpv `end-file` error gets one reload at the playhead before it
  closes the player.

### Library-changed push — `97a1c10`

- **C3 / C9 / C14 / C15** MAL reconcile Apply wrote watched rows and ratings
  the Settings panel never refreshed.
- **C4** Sync lists wrote tracked rows the Planned grid never showed.
- **S14** The hourly title sync grew the index with no renderer signal.
- Also the anime id repair (`all`) and the background watchlist pull.

### Watchlist evidence — `d972f13`

- **C13** A title planned here and un-planned before the next pull had no
  record of ever reaching Simkl, so the removal there was skipped and the
  next pull planned it again. A successful add now records the services
  that took it (`rememberPushedSources`).

### Surfaces that lagged a write — `a854bec`, `a665b77`

- **S13** Marking an episode or season watched on the detail page now calls
  `refreshWatchStatus()` like the movie toggle beside it.
- **C16** History and Stats tabs are re-keyed by `watchStatusVersion`.
- **C18** The franchise panel passes `watchedIds`, so sibling films show
  their badge.
- **C10** `continueWatchingList` counts only aired, playable episodes, the
  same set the Completed badge and the detail page use.
- **C17** Search results keep the IMDb id when Simkl has one; a `simkl:` id
  exists nowhere in watch state.

### Profiles — `977c550`

- **R3** (unverified by the workflow, confirmed by hand) The startup
  snapshot is one entry for the whole app and nothing cleared it on a
  profile switch. It and the session fallbacks are cleared on a
  successful switch.

## The playback report

What the log shows for 2026-09-04 (UTC): scrobble at 20:17:27, another at
20:17:47, then the stream cache reading a chunk path with no session
directory at 20:17:51 — a stop had already run — then two Play attempts
at 20:18:44 and 20:18:48 both failing with "No matching video file was
found in the TorBox torrent".

Established from code: the cache could end a stream as a clean end of file
(C1) and could store a bad reply as picture data (C6); the failed clicks
came from a torrent re-created without its file list yet, retried against
TorBox's own cache (S2, S9). The 80% watched mark itself is harmless: it
writes a row, requests a recommendations rebuild and awaits Simkl and MAL.
Which of C1 or C6 broke this particular stream cannot be told from a log
that recorded neither; both now log (`streamCache:starved`,
`streamCache:rangeReply`), as do dropped frames.

## Split verdicts

One verifier called each real, the other did not. Graham decided on
2026-09-05; the follow-up branch carries the ones taken.

Taken:

- **S4** Standard scaling now leaves mpv's own scalers in place: the preset
  sets nothing, mpv is launched with `--reset-on-next-file=scale,dscale,cscale`
  so a title after a High or Sharp one starts from the defaults, and the
  presets that do set filters do so after the load.
- **S6** Scrub-bar thumbnail captures run one at a time, only the latest
  request is served, and a position not yet on disk answers nothing rather
  than pulling the connection away from the playhead.
- **S11** A file that ends well short of the runtime shows "The stream
  ended early" with Resume (a fresh resolve at the saved position) and
  Stop, and suppresses the next-episode card.
- **S12** Scrobbles carry the title's release year from the main window's
  MediaItem, and the first rejection in a session is shown as a warning
  toast with Simkl's reason.

Left as they are:

- **S7** A main-window reload during playback resets `playbackMedia`; the
  overlay keeps every mouse event, so the practical effect is the
  click-through guard attribute, not navigation.
- **S10** A second Play click before the button disables cancels the first
  preparation silently.

## Follow-ups the maps raised

Taken on the follow-up branch:

- `useMediaHubLists` refetches on a new `lists` scope of `library:changed`,
  which the remote-list read announces.
- `toggleDisliked` re-reads the disliked hook once the write lands.
- A failed watchlist *add* push is queued and retried like a removal, and
  counts as evidence of presence once it lands (docs/WATCHLIST-SYNC.md,
  rule 6).
- The dead `catalogProviders` channel and its result types are gone.

Still open:

- `MyStuffPage`'s Lists view and `WatchlistSyncSection` each fetch the
  planned report independently with no shared refresh.
- `catalog-logic.ts`'s `isItemWatched` matches by several id forms, a
  second watched rule beside `adapters.ts`'s `watchedIds.has(id)`.

The film in the playback report was served by the household cache server,
and no toast appeared when it stopped — consistent with the silent
end-of-file path (C1) rather than the error path.

## Rejected

- Calendar stale after My List toggle — the page refetches on every visit
  and cannot be mounted when the toggle fires.
- Anime id repair orphaning planned/disliked rows — the pull never enters
  the merged id space, so the rows keep matching.
- No frame-timing policy on mpv — state verified, no causal trace.
- Speed not reset per session, resize handler undebounced — no verifier
  completed before the session limit; both low.
