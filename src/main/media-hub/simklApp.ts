/**
 * This app's own Simkl developer app. Built in so Connect is one click: the
 * person signs in to Simkl in the browser and never registers an app or
 * copies an ID. A Simkl client ID is public by design (it rides in the query
 * string of every API call, and the sign-in flows take no secret), so it is
 * safe to ship. An ID saved in settings by an older build still wins, so a
 * connection made with it keeps working.
 */
export const SIMKL_APP_CLIENT_ID =
  '2888d5d026cdb98e49d9a1d68c4b11e06ce19381b42a42a2fd87ee9643c1e781'
