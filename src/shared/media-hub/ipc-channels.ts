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
  logout: 'mediahub:account:logout',
  torboxConnect: 'mediahub:torbox:connect',
  torboxDisconnect: 'mediahub:torbox:disconnect',
  torboxUnauthorized: 'mediahub:torbox:unauthorized', // push event
  tmdbConnect: 'mediahub:tmdb:connect',
  tmdbDisconnect: 'mediahub:tmdb:disconnect',
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

  // Streaming / playback
  streamResolve: 'mediahub:stream:resolve',
  playStream: 'mediahub:play:stream',
  playbackCompatibility: 'mediahub:playback:compatibility',
  playbackSelectTracks: 'mediahub:playback:select-tracks',
  playbackStop: 'mediahub:playback:stop',
  playbackThumbnail: 'mediahub:playback:thumbnail',
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

  // Watch Party
  partyHost: 'mediahub:party:host',
  partyJoin: 'mediahub:party:join',
  partyLeave: 'mediahub:party:leave',
  partyStatus: 'mediahub:party:status',
  partySuggest: 'mediahub:party:suggest',
  partyRemove: 'mediahub:party:remove',
  partyVote: 'mediahub:party:vote',
  partyQueue: 'mediahub:party:queue',
  partyNowPlaying: 'mediahub:party:now-playing',
  partyPlaybackAction: 'mediahub:party:playback-action',
  partySyncConnect: 'mediahub:party-sync:connect',
  partySyncDisconnect: 'mediahub:party-sync:disconnect',
  partyEvent: 'mediahub:party:event', // push event

  // Window
  windowToggleFullscreen: 'mediahub:window:toggle-fullscreen',
  windowFullscreenChanged: 'mediahub:window:fullscreen-changed' // push event
} as const

export type MediaHubChannel = (typeof MEDIA_HUB_CHANNELS)[keyof typeof MEDIA_HUB_CHANNELS]
