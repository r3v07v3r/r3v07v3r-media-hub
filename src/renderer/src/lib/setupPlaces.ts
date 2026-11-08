// Where each service is set up, for the controls that depend on one.
//
// The maintainer's rule (2026-11-08): nothing may be offered, or switched
// on, when it needs another service to be set up first, unless it says so
// and offers the way there. The saying is <RequiresSetup> (components/
// layout/RequiresSetup.tsx); the way there is openControlCentre(section,
// anchor) in AppStateContext. This file is the one list both read, so a
// section that moves in the control centre is corrected in one place.
//
// Anchors are the heading ids the settings sections already carry
// (MediaHubSettingsSections.tsx: `settings-simkl` and so on; the subtitle
// providers sit under Accounts, with the other keys). The control
// centre scrolls the named heading into view once the section is showing.

import type { ControlCentreSectionId } from '@renderer/components/controlcentre/sections'

export type SetupService =
  | 'torbox'
  | 'simkl'
  | 'trakt'
  | 'mal'
  | 'tmdb'
  | 'omdb'
  | 'subdl'
  | 'opensubtitles'
  | 'subtitles'
  | 'ollama'
  | 'relay'
  | 'mediaServer'
  | 'lanCache'
  | 'anime4k'

export interface SetupPlace {
  /** How the service is named in a sentence. */
  name: string
  section: ControlCentreSectionId
  /** The heading id to scroll to; none means the section's top. */
  anchor?: string
}

export const SETUP_PLACES: Record<SetupService, SetupPlace> = {
  torbox: { name: 'TorBox', section: 'media-services', anchor: 'settings-torbox' },
  mediaServer: {
    name: 'a media server',
    section: 'media-services',
    anchor: 'settings-services-title'
  },
  simkl: { name: 'Simkl', section: 'accounts', anchor: 'settings-simkl' },
  trakt: { name: 'Trakt', section: 'accounts', anchor: 'settings-trakt' },
  mal: { name: 'MyAnimeList', section: 'accounts', anchor: 'settings-mal' },
  tmdb: { name: 'a TMDB key', section: 'accounts', anchor: 'settings-tmdb' },
  omdb: { name: 'an OMDb key', section: 'accounts', anchor: 'settings-omdb' },
  subdl: { name: 'SubDL', section: 'accounts', anchor: 'settings-subdl' },
  opensubtitles: { name: 'OpenSubtitles', section: 'accounts', anchor: 'settings-opensubtitles' },
  /** Either subtitle provider; the button lands on the first of the two. */
  subtitles: { name: 'a subtitle provider', section: 'accounts', anchor: 'settings-subdl' },
  ollama: { name: 'Ollama', section: 'ai', anchor: 'settings-ollama' },
  relay: { name: 'the party relay', section: 'community', anchor: 'settings-party-sync' },
  lanCache: { name: 'a cache server', section: 'caching' },
  /** Not a service: the shader pack download in General. */
  anime4k: { name: 'the Anime4K shader pack', section: 'general', anchor: 'settings-anime4k' }
}

/** "Simkl", "Simkl or Trakt", "Simkl, Trakt or MyAnimeList". */
export function nameServices(services: readonly SetupService[]): string {
  const names = services.map((service) => SETUP_PLACES[service].name)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
