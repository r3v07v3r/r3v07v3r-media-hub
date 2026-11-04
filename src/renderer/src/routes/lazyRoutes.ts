import { lazy } from 'react'

/**
 * Every page except Home, loaded on first visit rather than in the launch
 * bundle.
 *
 * The renderer used to be one ~2.1 MB script that the window parsed and ran
 * in full before its first paint, every page included, although launch only
 * ever shows Home. Each page is now its own chunk. prefetchRoutes() pulls
 * them all in once the window is idle after first paint, so by the time
 * somebody clicks a nav item the chunk is normally already there and the
 * page appears exactly as before. A chunk that is not there yet suspends
 * for one local file read (the app loads off disk), under the shell.
 *
 * Kept in one place so the lazy components and the prefetch list cannot
 * drift apart.
 */
const loaders = {
  forYou: () => import('./ForYouPage'),
  movies: () => import('./MoviesPage'),
  series: () => import('./SeriesPage'),
  anime: () => import('./AnimePage'),
  detail: () => import('./MediaDetailPage'),
  collections: () => import('./CollectionsPage'),
  myStuff: () => import('./MyStuffPage'),
  calendar: () => import('./CalendarPage'),
  settings: () => import('./SettingsPage'),
  moods: () => import('./MoodExplorePage'),
  person: () => import('./PersonPage'),
  controlCentre: () => import('../components/controlcentre/ControlCentreFace')
}

export const ForYouPage = lazy(loaders.forYou)
export const MoviesPage = lazy(loaders.movies)
export const SeriesPage = lazy(loaders.series)
export const AnimePage = lazy(loaders.anime)
export const MediaDetailPage = lazy(() =>
  loaders.detail().then((m) => ({ default: m.MediaDetailPage }))
)
export const CollectionsPage = lazy(loaders.collections)
export const CollectionPage = lazy(() =>
  loaders.collections().then((m) => ({ default: m.CollectionPage }))
)
export const MyStuffPage = lazy(loaders.myStuff)
export const CalendarPage = lazy(loaders.calendar)
export const SettingsPage = lazy(loaders.settings)
export const MoodExplorePage = lazy(loaders.moods)
export const PersonPage = lazy(loaders.person)
/** The cube's second face. It mounts only once the cube is first turned,
 *  and is prefetched long before anyone can do that. */
export const ControlCentreFace = lazy(() =>
  loaders.controlCentre().then((m) => ({ default: m.ControlCentreFace }))
)

let prefetched = false

/** Load every page chunk in the background. Safe to call more than once; a
 *  failed load is left for the page's own visit, where the route's error
 *  boundary reports it. */
export function prefetchRoutes(): void {
  if (prefetched) return
  prefetched = true
  for (const load of Object.values(loaders)) void load().catch(() => {})
}
