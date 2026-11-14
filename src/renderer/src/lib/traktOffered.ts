// Whether Trakt is offered to somebody who has not set it up.
//
// Off since 2026-11-14. Connecting asks for a client ID and secret from a
// Trakt API app, which takes a developer account no ordinary user has, so the
// card was a dead end for everyone but the maintainer. Until the app ships
// its own client ID, nothing points a person at Trakt: no card, no "requires
// Trakt" notice, no mention in the copy, and no export-file import.
//
// Nothing is removed. An install that already has Trakt credentials saved
// keeps its card and keeps syncing (TraktSection shows itself when
// configured), and main is untouched. Set this to true to bring it all back.

export const TRAKT_OFFERED: boolean = false

/** The trackers a watchlist can come from, as a sentence names them. */
export const TRACKERS_NAMED = TRAKT_OFFERED
  ? 'Simkl, Trakt and MyAnimeList'
  : 'Simkl and MyAnimeList'

/** The services that are told what is playing. */
export const SCROBBLERS_NAMED = TRAKT_OFFERED ? 'Simkl and Trakt' : 'Simkl'
