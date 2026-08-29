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
  settingsSetWatchRegion: 'mediahub:settings:set-watch-region',
  settingsSetNotifications: 'mediahub:settings:set-notifications',
  /** Named filter combinations for the browse pages — see SavedFilter. */
  settingsSaveFilter: 'mediahub:settings:save-filter',
  settingsDeleteFilter: 'mediahub:settings:delete-filter',
  settingsSetUiAnimations: 'mediahub:settings:set-ui-animations',
  settingsSetPerformancePanelVisible: 'mediahub:settings:set-performance-panel-visible',
  settingsSetSourcePreference: 'mediahub:settings:set-source-preference',
  settingsSetCacheMode: 'mediahub:settings:set-cache-mode',
  /** The one-time storage question, answerable again from Settings. */
  settingsSetStoreMedia: 'mediahub:settings:set-store-media',
  lanCacheDiscover: 'mediahub:lancache:discover',
  lanCachePair: 'mediahub:lancache:pair',
  lanCacheUnpair: 'mediahub:lancache:unpair',
  lanCacheStatus: 'mediahub:lancache:status',
  /** Poll while a pairing request waits for the server's administrator. */
  lanCachePairStatus: 'mediahub:lancache:pair-status',
  /** Take Super Admin of an unclaimed cache server. */
  lanCacheClaim: 'mediahub:lancache:claim',
  /** Admin only: the device list, one device's approve/deny/revoke/quota,
   *  and the server-wide join and allocation settings. */
  lanCacheDevices: 'mediahub:lancache:devices',
  lanCacheDeviceAction: 'mediahub:lancache:device-action',
  lanCacheAdminSettings: 'mediahub:lancache:admin-settings',
  /** The caller's own cached titles, and the sharing control over them. */
  lanCacheMyItems: 'mediahub:lancache:my-items',
  lanCacheSetSharing: 'mediahub:lancache:set-sharing',
  /** Remove one of your own cached titles, or cancel one of your own
   *  fetches. Both scoped to the caller by the daemon, not by the UI. */
  lanCacheRemoveItem: 'mediahub:lancache:remove-item',
  lanCacheCancelJob: 'mediahub:lancache:cancel-job',
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
  /** Reads IMDb's "export your ratings" CSV — a file the person downloads
   *  from IMDb themselves, picked with a native file dialog. See
   *  shared/media-hub/importCsv.ts for why this needs no title matching. */
  importImdbRatings: 'mediahub:import:imdb-ratings',
  /** Reads a Letterboxd "Export Your Data" zip, picked with a native file
   *  dialog. See main/media-hub/letterboxdImport.ts for the title/year
   *  resolution this needs that IMDb's import does not. */
  importLetterboxd: 'mediahub:import:letterboxd',
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
  /** The short 'what changed' note for the running build, and for an
   *  offered update once one is known. See media-hub/releaseNotes.ts. */
  updateNotes: 'mediahub:update:notes',
  updateSetChannel: 'mediahub:update:set-channel',
  updateStatus: 'mediahub:update:status', // push event

  // Catalog / search / metadata
  catalogList: 'mediahub:catalog:list',
  /** One filtered, sorted, paged slice of the library, straight out of
   *  catalog_index — the browse grid's data source once it stops holding the
   *  whole catalog in memory. Returns the page AND the total number of
   *  matches, which is what the category hero quotes. */
  catalogQuery: 'mediahub:catalog:query',
  /** The genre/year/status values that actually occur for one kind, for the
   *  filter bar's dropdowns. Over the whole library, not over the slice that
   *  happens to be loaded. */
  catalogFacets: 'mediahub:catalog:facets',
  catalogMeta: 'mediahub:catalog:meta',
  catalogSearch: 'mediahub:catalog:search',
  catalogRelated: 'mediahub:catalog:related',
  catalogStory: 'mediahub:catalog:story',
  /** Everything in the catalog this person appears in, from the credits cache
   *  — see main/media-hub/credits.ts's titlesFeaturing on why it is local. */
  catalogPerson: 'mediahub:catalog:person',
  /** Where a title can be streamed, rented or bought, in the person's own
   *  region — see main/media-hub/watchProviders.ts. */
  catalogProviders: 'mediahub:catalog:providers',
  /** The film series a title belongs to — see main/media-hub/collection.ts. */
  catalogCollection: 'mediahub:catalog:collection',
  /** The age certificate for a title in the person's region — see
   *  main/media-hub/contentRating.ts. */
  catalogRating: 'mediahub:catalog:rating',
  /** Episodes of tracked shows around now — see main/media-hub/calendar.ts. */
  calendarGet: 'mediahub:calendar:get',
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
  /** The append-only viewing record — one entry per play, so a rewatch is
   *  listed twice. See main/media-hub/database.ts's `plays`. */
  playsList: 'mediahub:plays:list',
  playDelete: 'mediahub:plays:delete',
  /** What the viewing adds up to — see database.ts's `viewingStats`. */
  statsGet: 'mediahub:stats:get',
  /** Named collections somebody made themselves — distinct from My List,
   *  which is the watchlist the tracking services sync against. */
  listsList: 'mediahub:lists:list',
  listsCreate: 'mediahub:lists:create',
  listsRename: 'mediahub:lists:rename',
  listsDelete: 'mediahub:lists:delete',
  listsItems: 'mediahub:lists:items',
  listsAdd: 'mediahub:lists:add',
  listsRemove: 'mediahub:lists:remove',
  listsContaining: 'mediahub:lists:containing',
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
  /** start / pause / stop, which is the shape Simkl's scrobble endpoints
   *  actually are — a state machine rather than a heartbeat. */
  simklScrobble: 'mediahub:simkl:scrobble',

  // Trakt — device-code sign-in, mirroring Simkl's PIN flow. See
  // main/media-hub/traktClient.ts.
  traktStatus: 'mediahub:trakt:status',
  traktConfigure: 'mediahub:trakt:configure',
  traktStart: 'mediahub:trakt:start',
  traktPoll: 'mediahub:trakt:poll',
  /** Pulls a connected Trakt account's history and ratings into this profile. */
  traktImport: 'mediahub:trakt:import',
  traktDisconnect: 'mediahub:trakt:disconnect',

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
