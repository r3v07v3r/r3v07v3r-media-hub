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
    id: 'caching',
    label: 'Caching',
    icon: 'stack',
    /** Read by the nav for its aria-description and by the section header,
     *  so the two cannot describe the same surface differently. */
    blurb: 'The cache server on your network — what it holds, and who may use it.'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    blurb: 'Playback, services, accounts and the rest of your R3 experience.'
  }
] as const

export type ControlCentreSectionId = (typeof CONTROL_CENTRE_SECTIONS)[number]['id']

export const DEFAULT_CONTROL_CENTRE_SECTION: ControlCentreSectionId = 'settings'
