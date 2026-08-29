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
  /** An account with credentials, linked and unlinked right here. The
   *  `account` id selects which fields and which bridge call — those live in
   *  the section, because this file is the shape of the pipeline and not a
   *  place to put IPC. */
  | { kind: 'account'; account: 'torbox' | 'opensubtitles' | 'subdl' }
  /** The cache server, whose setup is a multi-step join-and-be-approved flow
   *  that already has a section of its own. The ONLY node that sends you
   *  somewhere else, and it is a button that takes you there rather than a
   *  sentence telling you to go: two places holding a pending pairing would
   *  be two places for it to disagree. */
  | { kind: 'section'; section: 'caching' }
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
  /** What this step does, as a label rather than a sentence — it sits under
   *  the stage name in the diagram and heads the add list, so it is never
   *  punctuated as prose. */
  blurb: string
  nodes: PipelineNode[]
}

export const PIPELINE: PipelineStage[] = [
  {
    id: 'request',
    label: 'Request',
    icon: 'search',
    blurb: 'Ask for Something',
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
    blurb: 'Find Releases',
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
    blurb: 'Decide what to keep',
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
    blurb: 'Fetch it',
    nodes: [
      {
        id: 'torbox',
        label: 'TorBox',
        detail: 'Debrid',
        icon: 'lightning',
        config: { kind: 'account', account: 'torbox' }
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
    blurb: 'Extra Subtitles',
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
        config: { kind: 'account', account: 'opensubtitles' }
      },
      {
        id: 'subdl',
        label: 'SubDL',
        detail: 'Subtitles',
        icon: 'name',
        config: { kind: 'account', account: 'subdl' }
      }
    ]
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: 'stack',
    blurb: 'Keep what & where',
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
        config: { kind: 'section', section: 'caching' }
      },
      {
        id: 'jellyfin-library',
        label: 'Jellyfin',
        detail: 'Library, resume points',
        icon: 'grid',
        config: { kind: 'service', service: 'jellyfin' }
      }
    ]
  },
  {
    id: 'play',
    label: 'Stream / play',
    icon: 'play-outline',
    blurb: 'Playback',
    nodes: [
      // The ONLY node in this stage, because this app has exactly one
      // player. Jellyfin used to sit here too and that was simply wrong:
      // its whole surface is testConnection and getResumeItems, and in the
      // main process it is jellyfinCandidate — a stream SOURCE. Nothing ever
      // hands it a title to play. It is a place a copy lives, which is what
      // its node under Storage says, and having a second one here implied a
      // choice of player that does not exist.
      {
        id: 'mpv',
        label: 'mpv',
        detail: 'Bundled player',
        icon: 'play',
        config: { kind: 'builtin' }
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
