/**
 * This app's own MyAnimeList API app (App Type "other": no client secret,
 * PKCE sign-in, redirect URL http://127.0.0.1:48765/mal/callback). Built in
 * so Connect is one click: the person signs in to MyAnimeList in the browser
 * and never registers an app or copies an ID. A client ID of this app type
 * is public by design (it rides in the authorize URL), so it is safe to ship.
 *
 * Empty until the app is registered at myanimelist.net/apiconfig; while it
 * is empty, Settings keeps asking for the person's own client ID. While a
 * sign-in made with another saved ID is still stored, that ID is used
 * instead (malSync's mal:start), so those connections keep refreshing.
 */
export const MAL_APP_CLIENT_ID = ''
