// Channel names for the media-hub backend integration — a straight port of
// r3v07v3r-media-hub's channel strings (kept identical, not renamed) so the
// mapping back to the original app's main.cjs is traceable channel-for-
// channel while reviewing/debugging this port. Separate const map from
// ipc-types.ts's IPC_CHANNELS (this project's existing Jellyfin/Sonarr/
// Radarr/qBittorrent + telemetry + settings channels) — intentionally not
// merged into one object, since these two backends are unrelated and this
// keeps a clean "which backend does this channel belong to" boundary.

export const MEDIA_HUB_CHANNELS = {
  // Bootstrap / account / settings
  bootstrap: 'mediahub:app:bootstrap',
  settingsGet: 'mediahub:settings:get',
  settingsSetTheme: 'mediahub:settings:set-theme',
  settingsSetSubtitleLanguage: 'mediahub:settings:set-subtitle-language',
  settingsSetAudioLanguage: 'mediahub:settings:set-audio-language',
  settingsSetPlaybackBuffer: 'mediahub:settings:set-playback-buffer',
  settingsSetVideoScaling: 'mediahub:settings:set-video-scaling',
  settingsSetAutoSubtitles: 'mediahub:settings:set-auto-subtitles',
  settingsSetAutoplayNext: 'mediahub:settings:set-autoplay-next',
  settingsSetUiAnimations: 'mediahub:settings:set-ui-animations',
  settingsSetPerformancePanelVisible: 'mediahub:settings:set-performance-panel-visible',
  settingsSetStreamLimits: 'mediahub:settings:set-stream-limits',
  settingsSetStreamCacheSize: 'mediahub:settings:set-stream-cache-size',
  settingsChooseStreamCacheDir: 'mediahub:settings:choose-stream-cache-dir',
  settingsResetStreamCacheDir: 'mediahub:settings:reset-stream-cache-dir',
  settingsSetPartyDisplayName: 'mediahub:settings:set-party-display-name',
  settingsSetHideDefaults: 'mediahub:settings:set-hide-defaults',
  /** Write every profile's library out to a JSON file the person picks, and
   *  read one back. See main/media-hub/backup.ts for what a backup carries. */
  backupExport: 'mediahub:backup:export',
  backupImport: 'mediahub:backup:import',
  logout: 'mediahub:account:logout',
  torboxConnect: 'mediahub:torbox:connect',
  torboxDisconnect: 'mediahub:torbox:disconnect',
  torboxUnauthorized: 'mediahub:torbox:unauthorized', // push event
  tmdbConnect: 'mediahub:tmdb:connect',
  tmdbDisconnect: 'mediahub:tmdb:disconnect',
  omdbConnect: 'mediahub:omdb:connect',
  omdbDisconnect: 'mediahub:omdb:disconnect',
  clipboardWrite: 'mediahub:clipboard:write',
  openExternal: 'mediahub:open:external',
  updateCheck: 'mediahub:update:check',
  updateInstall: 'mediahub:update:install',
  updateSetChannel: 'mediahub:update:set-channel',
  updateStatus: 'mediahub:update:status', // push event

  // Catalog / search / metadata
  catalogList: 'mediahub:catalog:list',
  catalogMeta: 'mediahub:catalog:meta',
  catalogSearch: 'mediahub:catalog:search',
  catalogRelated: 'mediahub:catalog:related',
  catalogStory: 'mediahub:catalog:story',
  homePersonalized: 'mediahub:home:personalized',
  /** Pushed when the stored suggestion list has been rebuilt — see
   *  main/media-hub/recommendations.ts. The Home feed refetches on it
   *  rather than polling, so a rebuild that finishes mid-session reaches
   *  the row without waiting for the next launch. */
  recommendationsChanged: 'mediahub:recommendations:changed', // push event
  trackingList: 'mediahub:tracking:list',
  trackingToggle: 'mediahub:tracking:toggle',
  trackingMarkWatched: 'mediahub:tracking:mark-watched',
  trackingUnmarkWatched: 'mediahub:tracking:unmark-watched',
  trackingMarkSeasonWatched: 'mediahub:tracking:mark-season-watched',
  trackingGetPosition: 'mediahub:tracking:get-position',
  trackingSavePosition: 'mediahub:tracking:save-position',
  trackingListPositions: 'mediahub:tracking:list-positions',
  trackingReconcileCheck: 'mediahub:tracking:reconcile-check',
  trackingReconcileResolve: 'mediahub:tracking:reconcile-resolve',
  trackingReconcileSync: 'mediahub:tracking:reconcile-sync', // push event — a queued "keep local" batch went out (or didn't)
  /** A personal 1-10 score. Sending 0 clears it — see database.ts's `rate`
   *  and shared/media-hub/rating.ts on why "no opinion" is an absence rather
   *  than a zero. */
  ratingSet: 'mediahub:rating:set',
  ratingsList: 'mediahub:ratings:list',
  dislikedList: 'mediahub:disliked:list',
  dislikedAdd: 'mediahub:disliked:add',
  dislikedRemove: 'mediahub:disliked:remove',

  // Streaming / playback
  streamResolve: 'mediahub:stream:resolve',
  playStream: 'mediahub:play:stream',
  playbackStop: 'mediahub:playback:stop',
  playbackPrepareProgress: 'mediahub:playback:prepare-progress', // push event
  playbackThumbnail: 'mediahub:playback:thumbnail',
  playbackSkipTimes: 'mediahub:playback:skip-times',
  streamCacheClear: 'mediahub:playback:stream-cache-clear',

  // Embedded player (mpv) — see main/media-hub/playerBridge.ts.
  //
  // These exist because the player UI no longer lives in the main window.
  // mpv renders into a native child window, which on Windows always sits
  // above Chromium's web content, so the controls have to be a second,
  // transparent BrowserWindow layered over it. That window is a
  // separate renderer process with its own React tree and therefore no access
  // to AppStateContext, so everything it needs crosses this boundary instead.
  /** Overlay -> main. One request/response channel for every player operation
   *  (pause, seek, track selection, volume, speed, subtitle add). Deliberately
   *  a single discriminated-union channel rather than one channel per verb:
   *  every one of them is validated in the same place before reaching mpv. */
  playerCommand: 'mediahub:player:command',
  /** Main -> overlay push. Observed mpv properties (time-pos, pause, duration,
   *  cache state, track-list). Replaces the reads the renderer used to get for
   *  free off the <video> element. */
  playerState: 'mediahub:player:state', // push event
  /** Main -> overlay push. The session snapshot the overlay cannot derive on
   *  its own: which title is playing, its tracks, the settings that affect
   *  playback, and the party status. */
  playerSession: 'mediahub:player:session', // push event
  /** Overlay -> main, request/response. The overlay mounts *after* the session
   *  is already established, so it pulls the current session and player state
   *  once on mount rather than waiting for the next change to be pushed.
   *  Separate from playerSession above so no channel name is both an
   *  ipcMain.handle target and a webContents.send target. */
  playerSnapshot: 'mediahub:player:snapshot',
  /** Overlay -> main -> main window. Actions whose effect belongs to the main
   *  window's own state (close the player, raise a toast, refresh watch
   *  status, open the party panel). */
  playerUiEvent: 'mediahub:player:ui-event',
  /** Main -> overlay push. An input that landed on mpv's own window instead of
   *  the controls, handed over so the overlay applies it with its own party
   *  rules rather than main acting on mpv behind the party's back. */
  playerInput: 'mediahub:player:input', // push event
  /** Main -> overlay push. The controls window has just been put on screen.
   *
   *  Reported rather than observed because the overlay genuinely cannot see it:
   *  measured on Electron 39, a window created with `show: false` reports
   *  `document.visibilityState === 'visible'` the entire time it is hidden and
   *  fires no `visibilitychange` when it is finally shown. (The documented cure,
   *  `paintWhenInitiallyHidden: false`, is not available here — it suppresses
   *  `ready-to-show`, which is what the reveal itself waits on.) Without this the
   *  controls' idle countdown ran during the load and a cold stream slower than
   *  it started the film with the bar already faded out. */
  playerControlsShown: 'mediahub:player:controls-shown', // push event
  libraryList: 'mediahub:library:list',
  libraryPlay: 'mediahub:library:play',
  streamCacheList: 'mediahub:stream-cache:list',
  streamCacheDelete: 'mediahub:stream-cache:delete',

  // What the central work manager is doing right now — see
  // taskScheduler.ts and backgroundJobs.ts. Pushed rather than polled, so
  // a panel nobody has open costs nothing.
  activityGet: 'mediahub:activity:get',
  activityChanged: 'mediahub:activity:changed', // push event

  // Simkl
  simklStatus: 'mediahub:simkl:status',
  simklStart: 'mediahub:simkl:start',
  simklPoll: 'mediahub:simkl:poll',
  simklDisconnect: 'mediahub:simkl:disconnect',
  simklScrobbleStart: 'mediahub:simkl:scrobble-start',

  // MyAnimeList
  malStatus: 'mediahub:mal:status',
  malStart: 'mediahub:mal:start',
  malDisconnect: 'mediahub:mal:disconnect',
  malReconcilePreview: 'mediahub:mal:reconcile-preview',
  malReconcileApply: 'mediahub:mal:reconcile-apply',

  // OpenSubtitles
  osConnect: 'mediahub:os:connect',
  osDisconnect: 'mediahub:os:disconnect',
  subdlConnect: 'mediahub:subdl:connect',
  subdlDisconnect: 'mediahub:subdl:disconnect',
  subtitlesSearch: 'mediahub:subtitles:search',
  subtitlesApply: 'mediahub:subtitles:apply',
  subtitlesClearCache: 'mediahub:subtitles:clear-cache',

  // Local AI (Ollama) — see main/media-hub/ollamaService.ts
  ollamaStatus: 'mediahub:ollama:status',
  ollamaConnect: 'mediahub:ollama:connect',
  ollamaDisconnect: 'mediahub:ollama:disconnect',
  ollamaAsk: 'mediahub:ollama:ask',
  ollamaCancel: 'mediahub:ollama:cancel',
  ollamaRecommend: 'mediahub:ollama:recommend',
  /** Pushed when the answer to "is a local model connected?" changed on its
   *  own — i.e. auto-detection found (or lost) an Ollama at the default
   *  address after the renderer had already read its settings snapshot. */
  ollamaChanged: 'mediahub:ollama:changed',

  // Network
  networkInfo: 'mediahub:network:info',
  networkSpeedTest: 'mediahub:network:speed-test',

  // Watch Party
  partyHost: 'mediahub:party:host',
  partyJoin: 'mediahub:party:join',
  partyLeave: 'mediahub:party:leave',
  partyStatus: 'mediahub:party:status',
  partySuggest: 'mediahub:party:suggest',
  partyRemove: 'mediahub:party:remove',
  partyVote: 'mediahub:party:vote',
  partyQueue: 'mediahub:party:queue',
  partyPreparing: 'mediahub:party:preparing',
  partyNowPlaying: 'mediahub:party:now-playing',
  partyPlaybackAction: 'mediahub:party:playback-action',
  partySetMemberControl: 'mediahub:party:set-member-control',
  partyRequestPlay: 'mediahub:party:request-play',
  partyChat: 'mediahub:party:chat',
  friendsStatus: 'mediahub:friends:status',
  friendsCreate: 'mediahub:friends:create',
  friendsJoin: 'mediahub:friends:join',
  friendsLeave: 'mediahub:friends:leave',
  friendsSetSharing: 'mediahub:friends:set-sharing',
  friendsSetActivity: 'mediahub:friends:set-activity',
  friendsSend: 'mediahub:friends:send',
  friendsEvent: 'mediahub:friends:event', // push event
  friendsMessage: 'mediahub:friends:message', // push event — peer-to-peer requests
  partySyncConnect: 'mediahub:party-sync:connect',
  partySyncDisconnect: 'mediahub:party-sync:disconnect',
  partyEvent: 'mediahub:party:event', // push event

  // Window
  windowToggleFullscreen: 'mediahub:window:toggle-fullscreen',
  windowExitFullscreen: 'mediahub:window:exit-fullscreen',
  windowIsFullscreen: 'mediahub:window:is-fullscreen',
  windowFullscreenChanged: 'mediahub:window:fullscreen-changed', // push event

  // Downloads
  downloadBlocked: 'mediahub:download:blocked', // push event — a file was refused
  downloadBlockedList: 'mediahub:download:blocked-list',

  // Profiles
  profilesList: 'mediahub:profiles:list',
  profilesGetActive: 'mediahub:profiles:get-active',
  profilesSetActive: 'mediahub:profiles:set-active',
  profilesCreate: 'mediahub:profiles:create',
  profilesUpdate: 'mediahub:profiles:update',
  profilesDelete: 'mediahub:profiles:delete',
  profilesVerifyPin: 'mediahub:profiles:verify-pin'
} as const

export type MediaHubChannel = (typeof MEDIA_HUB_CHANNELS)[keyof typeof MEDIA_HUB_CHANNELS]
