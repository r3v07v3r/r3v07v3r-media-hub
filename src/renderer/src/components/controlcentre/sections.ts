// What the control centre is divided into.
//
// One list, in one file, because three things have to agree about it: the
// nav that renders the rail, the face that renders the active section's
// content, and the state that remembers which one you were on. Two of those
// diverging is a section that exists in the rail and shows nothing.
//
// ONLY WHAT EXISTS APPEARS. There is no greyed-out section for something
// half-built: an entry here is a promise that clicking it shows a working
// surface, and a rail full of dead links is worse than a short rail.

export const CONTROL_CENTRE_SECTIONS = [
  {
    id: 'pipeline',
    label: 'Pipeline',
    icon: 'net',
    blurb: 'How a title gets from you asking for it to it playing.'
  },
  {
    id: 'services',
    label: 'Services',
    icon: 'grid',
    blurb: 'What each connected service is doing right now.'
  },
  {
    id: 'caching',
    label: 'Caching',
    icon: 'stack',
    /** Read by the nav for its aria-description and by the section header,
     *  so the two cannot describe the same surface differently. */
    blurb: 'The cache server on your network — what it holds, and who may use it.'
  },
  // The settings page's own categories, each with its own entry rather than
  // a strip of tabs above one long scroll. Same content, reachable in one
  // click instead of two.
  {
    id: 'updates',
    label: 'Updates',
    icon: 'refresh',
    /** Its own entry rather than a tile inside General, where it used to
     *  live: "which build am I on, and why has it not updated" is a
     *  question people go looking for an answer to. */
    blurb: 'The build you are running, the channel it follows, and what changed.'
  },
  {
    id: 'general',
    label: 'General',
    icon: 'settings',
    blurb: 'Display preferences, your library and everyday behaviour.'
  },
  {
    id: 'playback',
    label: 'Playback',
    icon: 'play-outline',
    blurb: 'Language, quality, subtitles and connection preferences.'
  },
  {
    id: 'media-services',
    label: 'Media servers',
    icon: 'tv',
    /** NOT 'Services' — that is the live-status section above. The settings
     *  group's own heading is 'Media services', so the rail borrows that
     *  rather than inventing a third name for the same thing. */
    blurb: 'Servers, download clients and your streaming provider.'
  },
  {
    id: 'accounts',
    label: 'Accounts',
    icon: 'people',
    blurb: 'Accounts and metadata sources.'
  },
  {
    id: 'ai',
    label: 'AI',
    icon: 'sparkle',
    blurb: 'The local model behind the assistant and recommendations.'
  },
  {
    id: 'community',
    label: 'Community',
    icon: 'heart',
    blurb: 'Watch parties and profiles.'
  }
] as const

export type ControlCentreSectionId = (typeof CONTROL_CENTRE_SECTIONS)[number]['id']

export const DEFAULT_CONTROL_CENTRE_SECTION: ControlCentreSectionId = 'pipeline'

/** Rail entry -> the settings category it renders. Everything not listed
 *  here is a section of its own rather than a slice of the settings page. */
export const SETTINGS_CATEGORY_FOR: Partial<Record<ControlCentreSectionId, string>> = {
  general: 'general',
  playback: 'playback',
  'media-services': 'services',
  accounts: 'accounts',
  ai: 'ai',
  community: 'community'
}
