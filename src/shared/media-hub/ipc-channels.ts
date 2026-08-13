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
  settingsSetAutoSubtitles: 'mediahub:settings:set-auto-subtitles',
  settingsSetUiAnimations: 'mediahub:settings:set-ui-animations',
  settingsSetPerformancePanelVisible: 'mediahub:settings:set-performance-panel-visible',
  settingsSetVideoTranscode: 'mediahub:settings:set-video-transcode',
  settingsSetStreamLimits: 'mediahub:settings:set-stream-limits',
  settingsSetStreamCacheSize: 'mediahub:settings:set-stream-cache-size',
  settingsChooseStreamCacheDir: 'mediahub:settings:choose-stream-cache-dir',
  settingsResetStreamCacheDir: 'mediahub:settings:reset-stream-cache-dir',
  settingsSetPartyDisplayName: 'mediahub:settings:set-party-display-name',
  settingsSetHideDefaults: 'mediahub:settings:set-hide-defaults',
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
  homePersonalized: 'mediahub:home:personalized',
  trackingList: 'mediahub:tracking:list',
  trackingToggle: 'mediahub:tracking:toggle',
  trackingMarkWatched: 'mediahub:tracking:mark-watched',
  trackingUnmarkWatched: 'mediahub:tracking:unmark-watched',
  trackingMarkSeasonWatched: 'mediahub:tracking:mark-season-watched',
  trackingGetPosition: 'mediahub:tracking:get-position',
  trackingSavePosition: 'mediahub:tracking:save-position',
  trackingReconcileCheck: 'mediahub:tracking:reconcile-check',
  trackingReconcileResolve: 'mediahub:tracking:reconcile-resolve',
  dislikedList: 'mediahub:disliked:list',
  dislikedAdd: 'mediahub:disliked:add',
  dislikedRemove: 'mediahub:disliked:remove',

  // Streaming / playback
  streamResolve: 'mediahub:stream:resolve',
  playStream: 'mediahub:play:stream',
  playbackCompatibility: 'mediahub:playback:compatibility',
  playbackSelectTracks: 'mediahub:playback:select-tracks',
  playbackStop: 'mediahub:playback:stop',
  playbackThumbnail: 'mediahub:playback:thumbnail',
  playbackSkipTimes: 'mediahub:playback:skip-times',
  playbackExtractSubtitle: 'mediahub:playback:extract-subtitle',
  streamCacheClear: 'mediahub:playback:stream-cache-clear',
  libraryList: 'mediahub:library:list',
  libraryPlay: 'mediahub:library:play',

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
  subtitlesSearch: 'mediahub:subtitles:search',
  subtitlesApply: 'mediahub:subtitles:apply',
  subtitlesClearCache: 'mediahub:subtitles:clear-cache',

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
