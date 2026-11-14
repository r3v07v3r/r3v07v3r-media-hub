/**
 * This app's own Simkl developer app (AUTH V2, "TV, devices & command line",
 * device-code sign-in). Built in so Connect is one click: the person signs in
 * to Simkl in the browser and never registers an app or copies an ID. A
 * Simkl client ID is public by design (it rides in the query string of every
 * API call, and this app type has no client secret), so it is safe to ship.
 * While a sign-in made with another saved ID is still stored, that ID is
 * used instead (see settingsStore's simklCredentials and tracking's
 * simkl:start), so those connections keep refreshing.
 */
export const SIMKL_APP_CLIENT_ID =
  '24946124b1c40c5d9b57781b587b9ad78f0d6218d3003cabf975aa73620b7174'
