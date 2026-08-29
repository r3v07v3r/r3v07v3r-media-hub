// What the pipeline is made of.
//
// The stages a title passes through, and the things that can occupy each
// one. Kept apart from the component so the diagram, the tab strip and the
// config panel all read the same list — three views of one pipeline that
// disagreed about what is in it would be worse than no diagram.
//
// EVERY NODE HERE IS REAL. There is no entry for Jellyseerr, Bazarr,
// SABnzbd, NZBGet, Unpackerr or a transcoder, because this app integrates
// with none of them: a node you can click that cannot do anything is worse
// than an empty slot, and subtitles are fetched by the app itself, so there
// is nothing for Bazarr to do here even if somebody ran one.
//
// R3'S OWN FUNCTION COMES FIRST in every stage that has one, because it is
// what runs when nothing else is set up — and a stage whose only live node
// sat below two dark ones read as though nothing was doing the job at all.
// Something always is. R3 tracks what you are watching and works out what is
// wanted next (shared/lancache/wantedList.ts) whether or not Sonarr exists,
// and the player reads the subtitle tracks inside a file whether or not a
// subtitle service is linked. Those are real steps and they are drawn.

import type { ServiceId } from '@shared/ipc-types'

/** Where a node's settings actually live, which decides what the panel
 *  below the diagram can offer for it. */
export type NodeConfig =
  /** One of the five servers in ServiceSettings: address, key, on/off, and
   *  a connection test — all editable right here. */
  | { kind: 'service'; service: ServiceId }
  /** An account linked elsewhere in the app (TorBox, the subtitle
   *  providers). Shown with its live state and a pointer to where it is
   *  linked, rather than a second copy of a credential form. */
  | { kind: 'account'; where: string }
  /** The app itself, or something it ships with. Nothing to configure. */
  | { kind: 'builtin' }

export interface PipelineNode {
  id: string
  label: string
  /** One line on what this specific thing does at this stage. */
  detail: string
  icon: string
  config: NodeConfig
}

export interface PipelineStage {
  id: string
  label: string
  icon: string
  /** What this step is for, in the person's terms. */
  blurb: string
  nodes: PipelineNode[]
  /** Shown when no OUTSIDE service is filling this stage — R3's own function
   *  does not count, or the hint would vanish the moment the stage stopped
   *  being empty and take its suggestion with it. Says what adding something
   *  would buy, rather than reporting a deficiency. */
  hint: string
}

export const PIPELINE: PipelineStage[] = [
  {
    id: 'request',
    label: 'Request',
    icon: 'search',
    blurb: 'You ask for something',
    hint: '',
    nodes: [
      {
        id: 'r3-browse',
        label: 'R3',
        detail: 'Search and browse',
        icon: 'home',
        config: { kind: 'builtin' }
      }
    ]
  },
  {
    id: 'index',
    label: 'Discovery',
    icon: 'planet',
    blurb: 'Something finds releases',
    hint: '',
    nodes: [
      {
        id: 'r3-scrapers',
        label: 'R3 scrapers',
        detail: 'Built in',
        icon: 'stack',
        config: { kind: 'builtin' }
      },
      {
        id: 'prowlarr',
        label: 'Prowlarr',
        detail: 'Indexer manager',
        icon: 'net',
        config: { kind: 'service', service: 'prowlarr' }
      }
    ]
  },
  {
    id: 'manage',
    label: 'Management',
    icon: 'calendar',
    blurb: 'Something decides what to keep',
    hint: 'Sonarr or Radarr can take this over, with their own quality rules and release profiles.',
    nodes: [
      {
        id: 'r3-tracking',
        label: 'R3 tracking',
        detail: 'My List, next up',
        icon: 'tracked',
        config: { kind: 'builtin' }
      },
      {
        id: 'sonarr',
        label: 'Sonarr',
        detail: 'Series',
        icon: 'tv',
        config: { kind: 'service', service: 'sonarr' }
      },
      {
        id: 'radarr',
        label: 'Radarr',
        detail: 'Films',
        icon: 'movies',
        config: { kind: 'service', service: 'radarr' }
      }
    ]
  },
  {
    id: 'download',
    label: 'Download',
    icon: 'downloads',
    blurb: 'Something fetches it',
    hint: 'Nothing can fetch a release yet. Link TorBox or connect qBittorrent.',
    nodes: [
      {
        id: 'torbox',
        label: 'TorBox',
        detail: 'Debrid',
        icon: 'lightning',
        config: { kind: 'account', where: 'Settings → Accounts' }
      },
      {
        id: 'qbittorrent',
        label: 'qBittorrent',
        detail: 'Torrent client',
        icon: 'downloads',
        config: { kind: 'service', service: 'qbittorrent' }
      }
    ]
  },
  {
    id: 'process',
    label: 'Process',
    icon: 'waveform',
    blurb: 'Subtitles are found',
    hint: 'Only what is already in the file. Link a subtitle service to search for more.',
    nodes: [
      {
        id: 'embedded-subs',
        label: 'In the file',
        detail: 'Embedded tracks',
        icon: 'name',
        config: { kind: 'builtin' }
      },
      {
        id: 'opensubtitles',
        label: 'OpenSubtitles',
        detail: 'Subtitles',
        icon: 'name',
        config: { kind: 'account', where: 'Settings → Accounts' }
      },
      {
        id: 'subdl',
        label: 'SubDL',
        detail: 'Subtitles',
        icon: 'name',
        config: { kind: 'account', where: 'Settings → Accounts' }
      }
    ]
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: 'stack',
    blurb: 'It is kept on the way past',
    hint: '',
    nodes: [
      {
        id: 'playback-cache',
        label: 'Playback cache',
        detail: 'Rolling, local',
        icon: 'cpu',
        config: { kind: 'builtin' }
      },
      {
        id: 'lan-cache',
        label: 'Cache server',
        detail: 'On your network',
        icon: 'wifi',
        config: { kind: 'account', where: 'the Caching section' }
      },
      {
        id: 'jellyfin-library',
        label: 'Jellyfin',
        detail: 'Library',
        icon: 'grid',
        config: { kind: 'service', service: 'jellyfin' }
      }
    ]
  },
  {
    id: 'play',
    label: 'Stream / play',
    icon: 'play-outline',
    blurb: 'It plays',
    hint: '',
    nodes: [
      {
        id: 'mpv',
        label: 'mpv',
        detail: 'Bundled player',
        icon: 'play',
        config: { kind: 'builtin' }
      },
      {
        id: 'jellyfin-play',
        label: 'Jellyfin',
        detail: 'Media server',
        icon: 'tv',
        config: { kind: 'service', service: 'jellyfin' }
      }
    ]
  }
]

/** Flat lookup, so a tab strip or a deep link does not have to walk the
 *  stages to resolve an id. */
export const PIPELINE_NODES: Record<string, { node: PipelineNode; stage: PipelineStage }> =
  Object.fromEntries(
    PIPELINE.flatMap((stage) => stage.nodes.map((node) => [node.id, { node, stage }]))
  )
