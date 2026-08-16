// Shared between main (which loads the overlay window at this hash) and the
// renderer (which branches on it before mounting the app shell). Its own module
// rather than a constant in playerWindow.ts because that file imports electron,
// which the renderer must never pull in.
//
// A hash — rather than a query string or a second HTML entry point — is what
// keeps the overlay window's origin byte-identical to the main window's. That
// matters for more than tidiness: assertTrustedSender compares sender URLs with
// the hash stripped, so this window passes the same IPC trust check as the main
// one without that check needing to learn about it.
export const PLAYER_OVERLAY_ROUTE = '#/player-overlay'
