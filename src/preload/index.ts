import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IPC_CHANNELS,
  ProxyRequest,
  ProxyResponse,
  ServiceSettings,
  SystemSnapshot
} from '../shared/ipc-types'
import { MEDIA_HUB_CHANNELS } from '../shared/media-hub/ipc-channels'
import type {
  BlockedDownload,
  BootstrapResult,
  CatalogItem,
  ConnectResult,
  ConnectionTestResult,
  DislikedListResult,
  HomePersonalizedResult,
  LibraryItem,
  MalReconcileApplyResult,
  MalReconcilePreview,
  MalStartPayload,
  MalStatus,
  MarkWatchedResult,
  MediaHubSettingsSnapshot,
  MediaKind,
  MediaTracks,
  NetworkInfoResult,
  PartyEventPayload,
  PartyHostResult,
  PartyMode,
  FriendActivity,
  FriendMessage,
  FriendsStatus,
  PartyNowPlayingPayload,
  PartyPreparingPayload,
  PartyPlaybackAction,
  PartyQueueEntry,
  PartyStatusResult,
  PlaybackPositionResult,
  PlaybackPrepareProgress,
  PlaybackResult,
  PlaybackSelection,
  ProfilePublic,
  ProfilesListResult,
  ProfileSetActiveResult,
  ProfileVerifyPinResult,
  ReconcileCheckResult,
  ReconcileResolution,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  WatchStatusDiscrepancy,
  SkipTimes,
  CacheSessionMeta,
  StreamCacheEntry,
  StreamCandidate,
  StreamResolveResult,
  SubtitleResult,
  SubtitleSelection,
  SubtitlesApplyResult,
  TorBoxConnectResult,
  TrackingListResult,
  UpdateCheckResult,
  UpdateChannel,
  UpdateStatusPayload
} from '../shared/media-hub/types'
import type { PlaybackPosition, SimklPushItem } from '../main/media-hub/simkl'
import type {
  OpenSubtitlesSearchItem,
  OpenSubtitlesSearchPlayback
} from '../main/media-hub/opensubtitles'

// --- media-hub backend: payload shapes mirrored from the main-process
// handlers' own (module-private) argument interfaces in
// src/main/media-hub/*.ts — kept structurally identical so a call built
// here always matches what the handler on the other end actually reads.
// See MEDIA_HUB_CHANNELS for the channel-name source of truth.

type TrackableItem = Partial<CatalogItem> & { id: string }

interface MarkWatchedPayload {
  item: SimklPushItem
  playback?: PlaybackPosition
}

interface MarkSeasonWatchedPayload {
  item: SimklPushItem
  season?: number
  episodes?: Array<{ season?: number; episode: number }>
}

interface GetPositionPayload {
  id: string
  playback?: PlaybackPosition
}

interface SavePositionPayload {
  id: string
  playback?: PlaybackPosition
  positionSeconds: number
  durationSeconds?: number
}

interface ReconcileResolvePayload {
  discrepancy: WatchStatusDiscrepancy
  resolution: ReconcileResolution
}

/** Subscribes to a push-only (main -> renderer) event channel; returns an unsubscribe function. Unlike system.subscribe, these channels have no corresponding "start sending" message — main pushes opportunistically whenever the underlying event occurs, so this is a plain listener wrapper. */
function subscribe<T>(channel: string, onEvent: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => onEvent(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer — a small typed surface rather than exposing
// ipcRenderer wholesale, so the renderer can't send/listen on arbitrary
// channels (see src/preload/index.d.ts for the matching type contract).
const api = {
  system: {
    getSnapshot: (): Promise<SystemSnapshot> => ipcRenderer.invoke(IPC_CHANNELS.systemSnapshot),
    subscribe: (onSnapshot: (snapshot: SystemSnapshot) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: SystemSnapshot): void =>
        onSnapshot(snapshot)
      ipcRenderer.on(IPC_CHANNELS.systemSnapshot, listener)
      ipcRenderer.send('system:subscribe')
      return () => {
        ipcRenderer.send('system:unsubscribe')
        ipcRenderer.removeListener(IPC_CHANNELS.systemSnapshot, listener)
      }
    }
  },
  settings: {
    get: (): Promise<ServiceSettings> => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (next: ServiceSettings): Promise<ServiceSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsSet, next)
  },
  http: {
    request: <T = unknown>(req: ProxyRequest): Promise<ProxyResponse<T>> =>
      ipcRenderer.invoke(IPC_CHANNELS.httpRequest, req)
  },
  // The r3v07v3r-media-hub backend integration (TorBox/Simkl/Kitsu/
  // Cinemeta/MAL/OpenSubtitles/Watch Party/VLC) — a separate typed surface
  // from the rest of `api` above, mirroring how MEDIA_HUB_CHANNELS is kept
  // separate from IPC_CHANNELS (see that file's header comment). Grouped
  // by backend domain, not by channel-name prefix 1:1, so callers read
  // naturally (`api.mediaHub.torbox.connect(...)`, not
  // `api.mediaHub.torboxConnect(...)`).
  mediaHub: {
    bootstrap: (): Promise<BootstrapResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.bootstrap),

    settings: {
      get: (): Promise<MediaHubSettingsSnapshot> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsGet),
      setTheme: (theme: string): Promise<{ theme: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetTheme, theme),
      setSubtitleLanguage: (language: string): Promise<{ subtitleLanguage: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetSubtitleLanguage, language),
      setAudioLanguage: (language: string): Promise<{ audioLanguage: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetAudioLanguage, language),
      setPlaybackBuffer: (preset: string): Promise<{ playbackBuffer: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetPlaybackBuffer, preset),
      setAutoSubtitles: (enabled: boolean): Promise<{ autoSubtitlesEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetAutoSubtitles, enabled),
      setUiAnimations: (enabled: boolean): Promise<{ uiAnimationsEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetUiAnimations, enabled),
      setPerformancePanelVisible: (
        enabled: boolean
      ): Promise<{ performancePanelVisible: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetPerformancePanelVisible, enabled),
      setVideoTranscode: (enabled: boolean): Promise<{ videoTranscodeEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetVideoTranscode, enabled),
      setStreamLimits: (limits: {
        maxStreamResolution: number
        maxStreamSizeGb: number
        connectionSpeedMbps?: number
      }): Promise<MediaHubSettingsSnapshot> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetStreamLimits, limits),
      setStreamCacheSize: (streamCacheMaxGb: number): Promise<{ streamCacheMaxGb: number }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetStreamCacheSize, { streamCacheMaxGb }),
      chooseStreamCacheDir: (): Promise<{
        streamCacheDir?: string
        cancelled?: boolean
        error?: string
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsChooseStreamCacheDir),
      resetStreamCacheDir: (): Promise<{ streamCacheDir?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsResetStreamCacheDir),
      setPartyDisplayName: (name: string): Promise<{ partyDisplayName: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetPartyDisplayName, name),
      setHideDefaults: (
        partial: Partial<{
          hideWatchedDefault: boolean
          hideCompletedDefault: boolean
          hideDislikedDefault: boolean
        }>
      ): Promise<{
        hideWatchedDefault: boolean
        hideCompletedDefault: boolean
        hideDislikedDefault: boolean
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetHideDefaults, partial)
    },

    account: {
      logout: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.logout)
    },

    torbox: {
      connect: (token: string): Promise<TorBoxConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.torboxConnect, token),
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.torboxDisconnect),
      onUnauthorized: (onEvent: () => void): (() => void) =>
        subscribe<undefined>(MEDIA_HUB_CHANNELS.torboxUnauthorized, () => onEvent())
    },

    downloads: {
      /** Everything the download guard has refused this run. */
      blocked: (): Promise<BlockedDownload[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.downloadBlockedList),
      onBlocked: (onEvent: (item: BlockedDownload) => void): (() => void) =>
        subscribe<BlockedDownload>(MEDIA_HUB_CHANNELS.downloadBlocked, onEvent)
    },

    tmdb: {
      connect: (apiKey: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.tmdbConnect, apiKey),
      disconnect: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.tmdbDisconnect)
    },

    omdb: {
      connect: (apiKey: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.omdbConnect, apiKey),
      disconnect: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.omdbDisconnect)
    },

    clipboard: {
      write: (value: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.clipboardWrite, value)
    },

    openExternal: (url: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(MEDIA_HUB_CHANNELS.openExternal, url),

    update: {
      check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateCheck),
      install: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateInstall),
      setChannel: (channel: UpdateChannel): Promise<{ ok: true; channel: UpdateChannel }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateSetChannel, channel),
      onStatus: (onEvent: (status: UpdateStatusPayload) => void): (() => void) =>
        subscribe<UpdateStatusPayload>(MEDIA_HUB_CHANNELS.updateStatus, onEvent)
    },

    catalog: {
      list: (kind: MediaKind, force: boolean = false): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogList, { kind, force }),
      meta: (type: MediaKind, id: string): Promise<CatalogItem> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogMeta, { type, id }),
      search: (kind: MediaKind, query: string): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogSearch, { kind, query }),
      related: (type: MediaKind, id: string): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogRelated, { type, id })
    },

    home: {
      personalized: (): Promise<HomePersonalizedResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.homePersonalized)
    },

    tracking: {
      list: (): Promise<TrackingListResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingList),
      toggle: (item: TrackableItem): Promise<{ tracked: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingToggle, item),
      markWatched: (payload: MarkWatchedPayload): Promise<MarkWatchedResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingMarkWatched, payload),
      unmarkWatched: (payload: MarkWatchedPayload): Promise<MarkWatchedResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingUnmarkWatched, payload),
      markSeasonWatched: (payload: MarkSeasonWatchedPayload): Promise<MarkWatchedResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingMarkSeasonWatched, payload),
      getPosition: (payload: GetPositionPayload): Promise<PlaybackPositionResult | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingGetPosition, payload),
      savePosition: (payload: SavePositionPayload): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingSavePosition, payload),
      reconcileCheck: (): Promise<ReconcileCheckResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingReconcileCheck),
      reconcileResolve: (payload: ReconcileResolvePayload): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingReconcileResolve, payload)
    },

    disliked: {
      list: (): Promise<DislikedListResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedList),
      add: (item: TrackableItem): Promise<{ disliked: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedAdd, item),
      remove: (id: string): Promise<{ disliked: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedRemove, { id })
    },

    stream: {
      resolve: (type: string, id: string, title?: string): Promise<StreamResolveResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamResolve, { type, id, title }),
      // `type`/`resolveId` are optional and only used so the main process
      // can remember "the stream that actually worked" under the exact key
      // stream:resolve looked it up by (see torbox.ts's lastStreamKey) —
      // omit them and playback still works, it just won't get remembered.
      play: (
        stream: StreamCandidate,
        mediaId?: string,
        type?: string,
        resolveId?: string,
        meta?: CacheSessionMeta
      ): Promise<PlaybackResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playStream, {
          stream,
          mediaId,
          type,
          resolveId,
          catalogId: meta?.catalogId,
          title: meta?.title,
          posterUrl: meta?.posterUrl,
          season: meta?.seasonNumber,
          episode: meta?.episodeNumber
        })
    },

    streamCache: {
      list: (): Promise<StreamCacheEntry[]> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheList),
      delete: (token: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheDelete, { token })
    },

    playback: {
      // Both handlers start (or restart) the ffmpeg transcoder, so their
      // resolved payload spreads FfmpegTranscoderResult (url/engine/
      // compatibility: true) alongside the fields named below — see
      // main/media-hub/playbackSession.ts's PlaybackCompatibilityResult /
      // PlaybackSelectTracksResult.
      compatibility: (
        selection: PlaybackSelection = {}
      ): Promise<{ tracks: MediaTracks; url: string; engine: string; compatibility: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackCompatibility, selection),
      selectTracks: (
        selection: PlaybackSelection
      ): Promise<{
        tracks: MediaTracks
        selection: PlaybackSelection
        url: string
        engine: string
        compatibility: true
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackSelectTracks, selection),
      stop: (options?: { watched?: boolean }): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackStop, options),
      thumbnail: (seconds: number): Promise<string | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackThumbnail, seconds),
      skipTimes: (
        kitsuId: string,
        episode: number,
        episodeLengthSeconds: number
      ): Promise<SkipTimes | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackSkipTimes, {
          kitsuId,
          episode,
          episodeLengthSeconds
        }),
      extractSubtitle: (ordinal: number): Promise<string | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playbackExtractSubtitle, ordinal),
      clearStreamCache: (): Promise<{ ok: true; freedBytes: number }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheClear),
      /** Live sub-status while `stream.play` is in flight — see
       *  PlaybackPrepareProgress. Push-only; the preparation card is the
       *  only consumer and it ignores anything that arrives outside a
       *  preparation. */
      onPrepareProgress: (onEvent: (payload: PlaybackPrepareProgress) => void): (() => void) =>
        subscribe<PlaybackPrepareProgress>(MEDIA_HUB_CHANNELS.playbackPrepareProgress, onEvent)
    },

    library: {
      list: (): Promise<LibraryItem[]> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.libraryList),
      play: (item: Record<string, unknown>): Promise<PlaybackResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.libraryPlay, item)
    },

    simkl: {
      status: (): Promise<SimklStatus> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklStatus),
      start: (clientId: string): Promise<SimklPinStart> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklStart, clientId),
      poll: (userCode: string): Promise<SimklPollResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklPoll, userCode),
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklDisconnect),
      scrobbleStart: (
        item: SimklPushItem,
        playback?: PlaybackPosition
      ): Promise<{ connected: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklScrobbleStart, { item, playback })
    },

    mal: {
      status: (): Promise<MalStatus> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.malStatus),
      start: (
        payload: MalStartPayload
      ): Promise<{ connected: true; user?: Record<string, unknown> }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.malStart, payload),
      disconnect: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.malDisconnect),
      reconcilePreview: (): Promise<MalReconcilePreview> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.malReconcilePreview),
      reconcileApply: (diff: MalReconcilePreview): Promise<MalReconcileApplyResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.malReconcileApply, diff)
    },

    openSubtitles: {
      connect: (apiKey: string, username: string, password: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.osConnect, { apiKey, username, password }),
      disconnect: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.osDisconnect)
    },

    subdl: {
      connect: (apiKey: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subdlConnect, { apiKey }),
      disconnect: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subdlDisconnect)
    },

    subtitles: {
      search: (
        item: OpenSubtitlesSearchItem,
        playback?: OpenSubtitlesSearchPlayback
      ): Promise<SubtitleResult[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subtitlesSearch, { item, playback }),
      // Takes the whole provider-identifying slice of the chosen result
      // rather than a bare id: which field identifies a subtitle depends on
      // the provider it came from (see SubtitleSelection).
      apply: (
        subtitle: SubtitleSelection,
        compatibility: boolean,
        selection?: PlaybackSelection
      ): Promise<SubtitlesApplyResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subtitlesApply, {
          ...subtitle,
          compatibility,
          selection
        }),
      clearCache: (): Promise<{ ok: true; freedBytes: number }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subtitlesClearCache)
    },

    network: {
      info: (): Promise<NetworkInfoResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.networkInfo),
      speedTest: (screenHeight: number): Promise<ConnectionTestResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.networkSpeedTest, { screenHeight })
    },

    party: {
      host: (name: string, mode?: PartyMode): Promise<PartyHostResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyHost, { name, mode }),
      join: (code: string, name: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyJoin, { code, name }),
      leave: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyLeave),
      status: (): Promise<PartyStatusResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyStatus),
      suggest: (item: {
        id: unknown
        type?: string
        title?: string
        poster?: string
        year?: string
      }): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySuggest, item),
      remove: (queueId: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyRemove, queueId),
      vote: (queueId: string, direction: 1 | -1): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyVote, { queueId, direction }),
      queue: (): Promise<{ queue: PartyQueueEntry[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyQueue),
      preparing: (payload: PartyPreparingPayload): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyPreparing, payload),
      nowPlaying: (payload: PartyNowPlayingPayload): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyNowPlaying, payload),
      playbackAction: (action: PartyPlaybackAction): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyPlaybackAction, action),
      setMemberControl: (allow: boolean): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySetMemberControl, { allow }),
      requestPlay: (item: {
        id: string
        type: string
        title: string
        poster?: string
      }): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyRequestPlay, { item }),
      syncConnect: (url: string, inviteKey: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySyncConnect, { url, inviteKey }),
      syncDisconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySyncDisconnect),
      onEvent: (onEvent: (payload: PartyEventPayload) => void): (() => void) =>
        subscribe<PartyEventPayload>(MEDIA_HUB_CHANNELS.partyEvent, onEvent)
    },

    friends: {
      status: (): Promise<FriendsStatus> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsStatus),
      create: (): Promise<{ ok: true; code: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsCreate),
      join: (code: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsJoin, { code }),
      leave: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsLeave),
      setSharing: (sharing: boolean): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsSetSharing, { sharing }),
      setActivity: (activity: FriendActivity | null): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsSetActivity, { activity }),
      send: (message: FriendMessage): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.friendsSend, { message }),
      onEvent: (onEvent: (payload: FriendsStatus) => void): (() => void) =>
        subscribe<FriendsStatus>(MEDIA_HUB_CHANNELS.friendsEvent, onEvent),
      onMessage: (onEvent: (payload: FriendMessage) => void): (() => void) =>
        subscribe<FriendMessage>(MEDIA_HUB_CHANNELS.friendsMessage, onEvent)
    },

    window: {
      toggleFullscreen: (): Promise<{ fullScreen: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.windowToggleFullscreen),
      onFullscreenChange: (onEvent: (payload: { fullScreen: boolean }) => void): (() => void) =>
        subscribe<{ fullScreen: boolean }>(MEDIA_HUB_CHANNELS.windowFullscreenChanged, onEvent)
    },

    profiles: {
      list: (): Promise<ProfilesListResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesList),
      getActive: (): Promise<ProfileSetActiveResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesGetActive),
      setActive: (id: string, pin?: string): Promise<ProfileSetActiveResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesSetActive, { id, pin }),
      create: (payload: {
        name: string
        avatarTint?: [string, string]
        isKid?: boolean
        pin?: string
      }): Promise<ProfilePublic> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesCreate, payload),
      update: (payload: {
        id: string
        name?: string
        avatarTint?: [string, string]
        isKid?: boolean
        pin?: string | null
      }): Promise<ProfilePublic> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesUpdate, payload),
      remove: (id: string): Promise<ProfilesListResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesDelete, { id }),
      verifyPin: (id: string, pin: string): Promise<ProfileVerifyPinResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.profilesVerifyPin, { id, pin })
    }
  }
}

export type Api = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
