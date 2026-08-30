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
  LanCacheDevicesResponse,
  LanCacheOwnItem,
  LanCacheUpdateNowResponse,
  LanCacheStatusResponse
} from '../shared/lancache/protocol'
import type {
  ActivitySnapshot,
  AnimeStoryResult,
  BlockedDownload,
  BootstrapResult,
  CacheMode,
  CacheSessionMeta,
  CalendarEntry,
  CatalogFacets,
  DeepScanEvent,
  DeepScanReport,
  CatalogItem,
  CatalogListing,
  CatalogQuery,
  CatalogQueryResult,
  ConnectResult,
  ConnectionTestResult,
  CustomList,
  CustomListItem,
  DislikedListResult,
  EpisodePlaybackPosition,
  RoomActivity,
  RoomInboundMessage,
  RoomMessage,
  RoomsStatus,
  HomePersonalizedResult,
  ImportSummary,
  MalReconcileApplyResult,
  MalReconcilePreview,
  MalStartPayload,
  MalStatus,
  MarkWatchedResult,
  MediaHubSettingsSnapshot,
  MediaKind,
  NetworkInfoResult,
  OllamaAskResult,
  OllamaRecommendResult,
  OllamaStatus,
  PartyChatMessage,
  PartyEventPayload,
  PartyHostResult,
  PartyMode,
  PartyNowPlayingPayload,
  PartyPlaybackAction,
  PartyPreparingPayload,
  PartyQueueEntry,
  PartyStatusResult,
  PersonCreditsResult,
  PlayRecord,
  PlaybackPositionResult,
  PlaybackPrepareProgress,
  PlaybackResult,
  ProfilePublic,
  ProfileSetActiveResult,
  ProfileVerifyPinResult,
  ProfilesListResult,
  RecommendationsChanged,
  ReconcileCheckResult,
  ReconcileResolution,
  ReconcileResolveResult,
  ReconcileSyncReport,
  ReleaseNotesResult,
  SavedFilter,
  SimklPinStart,
  SimklPollResult,
  SimklStatus,
  SkipTimes,
  SourcePreference,
  StreamCacheEntry,
  PlannedSyncReport,
  RemoteList,
  StreamCacheUsage,
  StreamCandidate,
  StreamResolveResult,
  SubtitleResult,
  SubtitleSelection,
  SubtitlesApplyResult,
  TitleCollectionResult,
  TorBoxConnectResult,
  TrackingListResult,
  TraktPollResult,
  TraktStartResult,
  TraktStatusResult,
  UpdateChannel,
  UpdateCheckResult,
  UpdateStatusPayload,
  ViewingStats,
  WatchStatusDiscrepancy
} from '../shared/media-hub/types'
import type { OllamaTitleRef } from '../shared/media-hub/ollama'
import type {
  PlayerCommand,
  PlayerCommandResult,
  PlayerInputEvent,
  PlayerSessionSnapshot,
  PlayerStatePatch,
  PlayerUiEvent
} from '../shared/media-hub/player'
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
  /** The 0-2 multiplier the player was at — stored with the bookmark so a
   *  resumed title comes back at the loudness it was left at. */
  volume?: number
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
      setVideoScaling: (preset: string): Promise<{ videoScaling: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetVideoScaling, preset),
      setAutoSubtitles: (enabled: boolean): Promise<{ autoSubtitlesEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetAutoSubtitles, enabled),
      setAutoplayNext: (enabled: boolean): Promise<{ autoplayNextEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetAutoplayNext, enabled),
      setWatchRegion: (region: string): Promise<{ watchRegion: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetWatchRegion, region),
      setNotifications: (enabled: boolean): Promise<{ notificationsEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetNotifications, enabled),
      saveFilter: (
        name: string,
        kind: MediaKind,
        query: string
      ): Promise<{ savedFilters: SavedFilter[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSaveFilter, { name, kind, query }),
      deleteFilter: (id: string): Promise<{ savedFilters: SavedFilter[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsDeleteFilter, { id }),
      exportBackup: (): Promise<{ filePath: string | null }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.backupExport),
      importBackup: (): Promise<{
        restored: number
        createdAt: string
        activeProfileId: string
      } | null> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.backupImport),
      /** Reads IMDb's own "export your ratings" CSV, picked with a native
       *  file dialog. Null when the picker was cancelled. */
      importImdbRatings: (): Promise<ImportSummary | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.importImdbRatings),
      /** Reads a Letterboxd "Export Your Data" zip, picked with a native
       *  file dialog. Null when the picker was cancelled; throws (needs a
       *  connected TMDB key to resolve titles) if TMDB is not configured. */
      importLetterboxd: (): Promise<ImportSummary | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.importLetterboxd),
      setUiAnimations: (enabled: boolean): Promise<{ uiAnimationsEnabled: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetUiAnimations, enabled),
      setPerformancePanelVisible: (
        enabled: boolean
      ): Promise<{ performancePanelVisible: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetPerformancePanelVisible, enabled),
      setSourcePreference: (
        sourcePreference: SourcePreference
      ): Promise<{ sourcePreference: SourcePreference }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetSourcePreference, { sourcePreference }),
      /** The storage question. Answers with the mode actually in force, not
       *  the one saved — saying "disk" back to somebody who just chose
       *  stream only would be the contradiction this setting exists to
       *  prevent. */
      setStoreMedia: (
        storeMedia: boolean
      ): Promise<{ storeMedia: boolean; cacheMode: CacheMode }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetStoreMedia, { storeMedia }),
      setCacheMode: (
        cacheMode: CacheMode,
        memoryCacheMaxMb?: number
      ): Promise<{ cacheMode: CacheMode; memoryCacheMaxMb: number }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.settingsSetCacheMode, {
          cacheMode,
          memoryCacheMaxMb
        }),
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

    lanCache: {
      discover: (): Promise<{
        daemons: Array<{ name: string; host: string; port: number; url: string }>
        paired: string | null
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheDiscover),
      pair: (payload: {
        url: string
        shareTorboxToken?: boolean
      }): Promise<{ ok: boolean; message: string; pending?: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCachePair, payload),
      unpair: (): Promise<{ ok: true }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheUnpair),
      status: (): Promise<{
        connected: boolean
        status?: LanCacheStatusResponse
        error?: string
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheStatus),
      /** Poll while a request waits for approval. Flips itself to
       *  'approved' — and grants the player access — the moment the server
       *  says yes, so the UI only has to ask. */
      pairStatus: (): Promise<{
        state: 'none' | 'pending' | 'approved'
        name?: string
        error?: string
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCachePairStatus),
      claim: (): Promise<{ ok: boolean; message: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheClaim),
      devices: (): Promise<
        ({ ok: true } & LanCacheDevicesResponse) | { ok: false; message: string }
      > => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheDevices),
      deviceAction: (payload: {
        id: string
        action: 'approve' | 'deny' | 'revoke' | 'quota'
        quotaBytes?: number | null
      }): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheDeviceAction, payload),
      adminSettings: (payload: {
        openJoin?: boolean
        defaultQuotaPercent?: number
      }): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheAdminSettings, payload),
      /** Admin only. Checks the feed now and installs as soon as nobody is
       *  watching — see the daemon's /api/admin/update for why an open
       *  stream still stops it. */
      updateNow: (): Promise<
        ({ ok: true } & LanCacheUpdateNowResponse) | { ok: false; message: string }
      > => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheUpdateNow),
      /** The caller's OWN cached titles. Never anyone else's — see the
       *  daemon's /api/items/mine. */
      myItems: (): Promise<{ ok: boolean; items: LanCacheOwnItem[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheMyItems),
      setSharing: (payload: {
        infoHash: string
        visibility: 'private' | 'shared'
      }): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheSetSharing, payload),
      removeItem: (payload: { infoHash: string }): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheRemoveItem, payload),
      cancelJob: (payload: { contentKey: string }): Promise<{ ok: boolean; message?: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.lanCacheCancelJob, payload)
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

    // Local AI. Every one of these fails loudly when there is no model to
    // ask — an Ollama at its own default address is found and used without
    // being configured, but nothing else is, and there is deliberately no
    // hosted model to silently fall back to (see
    // main/media-hub/ollamaService.ts).
    ollama: {
      /** Probes an instance and lists its installed models. Pass `baseUrl` to check an address that hasn't been saved yet; omit it to check the one in use, which on an unconfigured install is Ollama's default address. Never rejects for an unreachable server — read `reachable`/`error`. */
      status: (baseUrl?: string): Promise<OllamaStatus> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaStatus, baseUrl ? { baseUrl } : undefined),
      /** Saves the address + model, after verifying the server is up and has that model. Rejects with the reason if not. */
      connect: (baseUrl: string, model: string): Promise<OllamaStatus> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaConnect, { baseUrl, model }),
      /** Forgets the model AND stops the app looking for one at the default address, since otherwise it would simply find the same one again. */
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaDisconnect),
      /** Fires when a model was found (or lost) without anyone asking — re-read the settings snapshot, the `ollamaConnected` in hand is stale. */
      onChanged: (onEvent: () => void): (() => void) =>
        subscribe<undefined>(MEDIA_HUB_CHANNELS.ollamaChanged, () => onEvent()),
      /** One assistant question, with the app's own search results for it
       *  (`matches`, already on screen), what this person has watched
       *  (`watched`), and a sample of the catalog (`library`). All three are
       *  context for grounding the answer, never a menu the model must pick
       *  from. `requestId` is what `cancel` below abandons it by. */
      ask: (
        question: string,
        context: {
          matches: OllamaTitleRef[]
          library: OllamaTitleRef[]
          watched: OllamaTitleRef[]
        },
        requestId: string
      ): Promise<OllamaAskResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaAsk, { question, ...context, requestId }),
      /** Abandons an `ask` that is still generating. Local models run on the person's own hardware, so a dismissed question must actually stop, not just have its answer discarded on arrival. */
      cancel: (requestId: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaCancel, { requestId }),
      /** Asks the model to pick one of `candidates`. An empty `id` back means it answered with something not on the list — fall back rather than treating it as a failure. */
      recommend: (
        kindLabel: string,
        candidates: OllamaTitleRef[],
        requestId: string
      ): Promise<OllamaRecommendResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ollamaRecommend, { kindLabel, candidates, requestId })
    },

    clipboard: {
      write: (value: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.clipboardWrite, value)
    },

    openExternal: (url: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke(MEDIA_HUB_CHANNELS.openExternal, url),

    update: {
      check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateCheck),
      /** What the running build changed. Read once when the card mounts —
       *  it cannot change while the app is running. */
      notes: (): Promise<ReleaseNotesResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateNotes),
      install: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateInstall),
      setChannel: (channel: UpdateChannel): Promise<{ ok: true; channel: UpdateChannel }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.updateSetChannel, channel),
      onStatus: (onEvent: (status: UpdateStatusPayload) => void): (() => void) =>
        subscribe<UpdateStatusPayload>(MEDIA_HUB_CHANNELS.updateStatus, onEvent)
    },

    catalog: {
      list: (kind: MediaKind, force: boolean = false): Promise<CatalogListing> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogList, { kind, force }),
      /** One filtered, sorted, paged slice of the library. Unlike `list`,
       *  this never triggers a crawl — it reports what the index already
       *  holds, so it is safe on a keystroke-driven path. */
      query: (query: CatalogQuery): Promise<CatalogQueryResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogQuery, query),
      facets: (kind: MediaKind): Promise<CatalogFacets> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogFacets, { kind }),
      /** Rows for exactly these ids from the index, every kind a shared
       *  id exists under — the id-matching path that replaced scanning
       *  the loaded array (stage 4). */
      byIds: (ids: string[]): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogByIds, { ids }),
      /** One chunk of the user-triggered deep scan (stage 5). */
      deepScan: (kind: MediaKind): Promise<DeepScanReport> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogDeepScan, { kind }),
      onDeepScanEvent: (onEvent: (payload: DeepScanEvent) => void): (() => void) =>
        subscribe<DeepScanEvent>(MEDIA_HUB_CHANNELS.catalogDeepScanEvent, onEvent),
      meta: (type: MediaKind, id: string): Promise<CatalogItem> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogMeta, { type, id }),
      search: (kind: MediaKind, query: string): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogSearch, { kind, query }),
      related: (type: MediaKind, id: string): Promise<CatalogItem[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogRelated, { type, id }),
      story: (type: MediaKind, id: string): Promise<AnimeStoryResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogStory, { type, id }),
      person: (person: string): Promise<PersonCreditsResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogPerson, { person }),
      collection: (id: string): Promise<TitleCollectionResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogCollection, { id }),
      rating: (type: MediaKind, id: string): Promise<{ rating: string; region: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.catalogRating, { type, id }),
      calendar: (): Promise<{ entries: CalendarEntry[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.calendarGet)
    },

    home: {
      personalized: (): Promise<HomePersonalizedResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.homePersonalized),
      /** Fires when the background job has rebuilt the stored suggestion
       *  list. Carries no rows on purpose — the subscriber refetches
       *  through personalized() above, so there is one path to that data
       *  rather than two that can disagree. */
      onRecommendationsChanged: (
        onEvent: (payload: RecommendationsChanged) => void
      ): (() => void) =>
        subscribe<RecommendationsChanged>(MEDIA_HUB_CHANNELS.recommendationsChanged, onEvent)
    },

    tracking: {
      list: (): Promise<TrackingListResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingList),
      /** Pull plan-to-watch from every connected tracking service now,
       *  rather than waiting for the background pass. */
      syncPlanned: (): Promise<PlannedSyncReport> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingPlannedSync),
      /** The last pull's result, so a panel has something to show
       *  before anybody presses the button. */
      plannedReport: (): Promise<PlannedSyncReport | null> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingPlannedReport),
      /** Turn two-way watchlist sync on or off — see
       *  docs/WATCHLIST-SYNC.md for what each direction does. */
      setWatchlistTwoWay: (enabled: boolean): Promise<{ watchlistTwoWay: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingSetTwoWay, { enabled }),
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
      /** Every resume bookmark stored for one title, in one call — what
       *  the detail page's episode grid draws its per-tile "N min left"
       *  slivers from. */
      listPositions: (payload: { id: string }): Promise<EpisodePlaybackPosition[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingListPositions, payload),
      reconcileCheck: (): Promise<ReconcileCheckResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingReconcileCheck),
      reconcileResolve: (payload: ReconcileResolvePayload): Promise<ReconcileResolveResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.trackingReconcileResolve, payload),
      /** Fires when a batch of "keep local" decisions has been pushed out
       *  to the tracking services — or has failed to be. The resolve call
       *  itself only queues the decision (see tracking.ts), so this is
       *  where the actual outcome arrives. */
      onReconcileSync: (onEvent: (report: ReconcileSyncReport) => void): (() => void) =>
        subscribe<ReconcileSyncReport>(MEDIA_HUB_CHANNELS.trackingReconcileSync, onEvent)
    },

    plays: {
      list: (): Promise<{ plays: PlayRecord[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playsList),
      remove: (playId: number): Promise<{ plays: PlayRecord[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playDelete, { playId })
    },

    stats: {
      get: (): Promise<ViewingStats> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.statsGet)
    },

    lists: {
      /** Named lists from Trakt and Simkl, read-only. */
      remoteLists: (): Promise<{ lists: RemoteList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsRemote),
      list: (): Promise<{ lists: CustomList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsList),
      create: (name: string): Promise<{ lists: CustomList[]; created: CustomList }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsCreate, { name }),
      rename: (listId: string, name: string): Promise<{ lists: CustomList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsRename, { listId, name }),
      remove: (listId: string): Promise<{ lists: CustomList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsDelete, { listId }),
      items: (listId: string): Promise<{ items: CustomListItem[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsItems, { listId }),
      add: (listId: string, item: TrackableItem): Promise<{ lists: CustomList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsAdd, { listId, item }),
      removeItem: (listId: string, contentId: string): Promise<{ lists: CustomList[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsRemove, { listId, contentId }),
      containing: (contentId: string): Promise<{ listIds: string[] }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.listsContaining, { contentId })
    },

    ratings: {
      list: (): Promise<{ ratings: Record<string, number> }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ratingsList),
      /** 1-10, or 0 to clear. */
      set: (
        id: string,
        score: number,
        media?: { type: MediaKind; title: string }
      ): Promise<{ ratings: Record<string, number> }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.ratingSet, { id, score, ...media })
    },

    disliked: {
      list: (): Promise<DislikedListResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedList),
      add: (item: TrackableItem): Promise<{ disliked: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedAdd, item),
      remove: (id: string): Promise<{ disliked: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.dislikedRemove, { id })
    },

    stream: {
      // `cacheKey` carries the SAME catalogId/season/episode that play()
      // stores on the cache session, so resolve's local-cache tier can
      // identify an existing session without reconstructing the identity
      // from `id` — a reconstruction that silently misses for anime, whose
      // id is `kitsuId:episode` with no season segment.
      resolve: (
        type: string,
        id: string,
        title?: string,
        cacheKey?: { catalogId?: string; seasonNumber?: number; episodeNumber?: number }
      ): Promise<StreamResolveResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamResolve, { type, id, title, cacheKey }),
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

    /** What the central work manager is doing — see taskScheduler.ts. */
    activity: {
      get: (): Promise<ActivitySnapshot> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.activityGet),
      onChanged: (onEvent: (snapshot: ActivitySnapshot) => void): (() => void) =>
        subscribe<ActivitySnapshot>(MEDIA_HUB_CHANNELS.activityChanged, onEvent)
    },

    streamCache: {
      list: (): Promise<StreamCacheEntry[]> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheList),
      delete: (token: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheDelete, { token }),
      /** What is held and what is left, for the Downloads page's one
       *  space line. */
      usage: (): Promise<StreamCacheUsage> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheUsage)
    },

    playback: {
      // What used to be here — `compatibility` and `selectTracks` — started or
      // restarted the ffmpeg transcoder. Track selection and seeking are player
      // properties now (see the `player` group above), so nothing in this group
      // touches the stream itself anymore.
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
      clearStreamCache: (): Promise<{ ok: true; freedBytes: number }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.streamCacheClear),
      /** Live sub-status while `stream.play` is in flight — see
       *  PlaybackPrepareProgress. Push-only; the preparation card is the
       *  only consumer and it ignores anything that arrives outside a
       *  preparation. */
      onPrepareProgress: (onEvent: (payload: PlaybackPrepareProgress) => void): (() => void) =>
        subscribe<PlaybackPrepareProgress>(MEDIA_HUB_CHANNELS.playbackPrepareProgress, onEvent)
    },

    /** The embedded mpv player. Consumed almost entirely by the player-overlay
     *  window (a separate renderer — see main/media-hub/playerWindow.ts for why
     *  the controls cannot live in the main window); the main window only
     *  listens for onUiEvent, which is how the overlay reaches back into its
     *  state. */
    player: {
      command: (command: PlayerCommand): Promise<PlayerCommandResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playerCommand, command),
      uiEvent: (event: PlayerUiEvent): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playerUiEvent, event),
      /** Pulled once when the overlay mounts — it comes up after the session
       *  already exists, so there is nothing to wait for it to be pushed. */
      snapshot: (): Promise<{
        session: PlayerSessionSnapshot | null
        state: PlayerStatePatch
      }> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.playerSnapshot),
      /** Observed mpv properties. A partial patch: an absent key means
       *  unchanged, not null. */
      onState: (onEvent: (patch: PlayerStatePatch) => void): (() => void) =>
        subscribe<PlayerStatePatch>(MEDIA_HUB_CHANNELS.playerState, onEvent),
      onSession: (onEvent: (snapshot: PlayerSessionSnapshot) => void): (() => void) =>
        subscribe<PlayerSessionSnapshot>(MEDIA_HUB_CHANNELS.playerSession, onEvent),
      /** Input that reached mpv's window instead of the controls — the overlay
       *  applies it through its own handlers so the party rules still hold. */
      onInput: (onEvent: (event: PlayerInputEvent) => void): (() => void) =>
        subscribe<PlayerInputEvent>(MEDIA_HUB_CHANNELS.playerInput, onEvent),
      /** This window has just been put on screen. The overlay cannot detect
       *  that for itself — see the channel's own comment. */
      onControlsShown: (onEvent: () => void): (() => void) =>
        subscribe<void>(MEDIA_HUB_CHANNELS.playerControlsShown, onEvent),
      /** Main-window side of the bridge: actions the overlay raised that belong
       *  to this window's state (close the player, toast, refresh watch
       *  status, open the party panel). */
      onUiEvent: (onEvent: (event: PlayerUiEvent) => void): (() => void) =>
        subscribe<PlayerUiEvent>(MEDIA_HUB_CHANNELS.playerUiEvent, onEvent)
    },

    simkl: {
      status: (): Promise<SimklStatus> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklStatus),
      start: (clientId: string): Promise<SimklPinStart> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklStart, clientId),
      poll: (userCode: string): Promise<SimklPollResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklPoll, userCode),
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklDisconnect),
      scrobble: (
        action: 'start' | 'pause' | 'stop',
        item: SimklPushItem,
        playback?: PlaybackPosition,
        progress?: number
      ): Promise<{ connected: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.simklScrobble, {
          action,
          item,
          playback,
          progress
        })
    },

    trakt: {
      status: (): Promise<TraktStatusResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktStatus),
      /** Saves the app credential. The secret never comes back out. */
      configure: (clientId: string, clientSecret: string): Promise<TraktStatusResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktConfigure, { clientId, clientSecret }),
      start: (): Promise<TraktStartResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktStart),
      poll: (): Promise<TraktPollResult> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktPoll),
      /** Pulls this account's history and ratings in. Repeatable — see db.importWatched. */
      import: (): Promise<ImportSummary> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktImport),
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.traktDisconnect)
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
      disconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subdlDisconnect)
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
      // The `compatibility` flag and playback `selection` this used to take are
      // gone with the transcode: applying a subtitle writes the .srt and hands
      // it to the player, which loads it in place. It never touches playback.
      apply: (subtitle: SubtitleSelection): Promise<SubtitlesApplyResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.subtitlesApply, { ...subtitle }),
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
      chat: (payload: {
        id: string
        text: string
        sentAt: number
      }): Promise<{ ok: true; chat: PartyChatMessage }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partyChat, payload),
      syncConnect: (url: string, inviteKey: string): Promise<ConnectResult> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySyncConnect, { url, inviteKey }),
      syncDisconnect: (): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.partySyncDisconnect),
      onEvent: (onEvent: (payload: PartyEventPayload) => void): (() => void) =>
        subscribe<PartyEventPayload>(MEDIA_HUB_CHANNELS.partyEvent, onEvent)
    },

    rooms: {
      status: (): Promise<RoomsStatus> => ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsStatus),
      create: (name: string): Promise<{ ok: true; code: string }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsCreate, { name }),
      join: (code: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsJoin, { code }),
      leave: (roomId: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsLeave, { roomId }),
      rename: (roomId: string, name: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsRename, { roomId, name }),
      kick: (roomId: string, friendId: string): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsKick, { roomId, friendId }),
      setSharing: (roomId: string, sharing: boolean): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsSetSharing, { roomId, sharing }),
      setActivity: (activity: RoomActivity | null): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsSetActivity, { activity }),
      send: (roomId: string, message: RoomMessage): Promise<{ ok: true }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.roomsSend, { roomId, message }),
      onEvent: (onEvent: (payload: RoomsStatus) => void): (() => void) =>
        subscribe<RoomsStatus>(MEDIA_HUB_CHANNELS.roomsEvent, onEvent),
      onMessage: (onEvent: (payload: RoomInboundMessage) => void): (() => void) =>
        subscribe<RoomInboundMessage>(MEDIA_HUB_CHANNELS.roomsMessage, onEvent)
    },

    window: {
      toggleFullscreen: (): Promise<{ fullScreen: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.windowToggleFullscreen),
      exitFullscreen: (): Promise<{ wasFullScreen: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.windowExitFullscreen),
      isFullscreen: (): Promise<{ fullScreen: boolean }> =>
        ipcRenderer.invoke(MEDIA_HUB_CHANNELS.windowIsFullscreen),
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
