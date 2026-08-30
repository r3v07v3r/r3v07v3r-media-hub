// Realistic mock data standing in for a real catalog/recommendation API.
// Every component reads through the MediaItem / ContinueWatchingItem /
// Recommendation interfaces in src/types, never this file's shape
// directly — swapping this module for a fetch() against a real backend
// is the intended migration path (see spec section 17/21).

import {
  ContinueWatchingItem,
  MediaItem,
  MoodCategory,
  NavItem,
  Recommendation,
  UserProfile
} from '../types'
import tmdbArtwork from './tmdbArtwork.generated.json'
import aiHeroArt from './aiHeroArt.generated.json'

let uid = 0
function nextId(prefix: string) {
  uid += 1
  return `${prefix}-${uid}`
}

// ---------- Real artwork overlay (spec section 3: artwork-provider
// abstraction) ----------
// scripts/fetch-tmdb-artwork.mjs resolves real TMDB poster/backdrop/logo
// URLs for every title below and writes them to
// tmdbArtwork.generated.json, keyed the same way as `artworkKey()`
// here. Until that script has been run somewhere with outbound internet
// access, the generated file is `{}` and every item keeps using its
// local placeholder art (posterUrl/backdropUrl/thumbnailUrl set inline
// below) — this overlay is additive, never required.
type TmdbArtworkEntry = {
  posterUrl?: string
  backdropUrl?: string
  logoUrl?: string
  overview?: string
}
const TMDB_ARTWORK: Record<string, TmdbArtworkEntry> = tmdbArtwork

// scripts/generate-hero-art.mjs produces custom painted cinematic
// backdrops for the FEATURED_ITEMS hero rotation via OpenAI's image API
// — a stylistic alternative to TMDB's official stills, for whoever wants
// the hero specifically to look like painted concept art. Same
// additive-only contract as TMDB_ARTWORK: empty `{}` until the script
// has been run somewhere with internet access, and it only ever
// overrides backdropUrl (never posters — see the script's header
// comment for why the scope stops at the hero).
type AiHeroArtEntry = { backdropUrl?: string }
const AI_HERO_ART: Record<string, AiHeroArtEntry> = aiHeroArt

function normalizeTitleKey(s: string | undefined) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
function artworkKey(title: string, subtitle: string | undefined) {
  return `${normalizeTitleKey(title)}|${normalizeTitleKey(subtitle)}`
}

/** Overlays real TMDB art (if fetch-tmdb-artwork.mjs has been run) on
 *  top of an item's local placeholder art. Real art always wins when
 *  present; falls back to whatever the item already had otherwise, so
 *  this is safe to call unconditionally. */
function withRealArtwork(item: MediaItem): MediaItem {
  const artKey = artworkKey(item.title, item.subtitle)
  const real = TMDB_ARTWORK[artKey]
  const aiHero = AI_HERO_ART[artKey]
  if (!real && !aiHero) return item
  return {
    ...item,
    posterUrl: real?.posterUrl ?? item.posterUrl,
    // AI-generated hero art wins over TMDB's backdrop when both exist —
    // it's the deliberately-chosen stylistic option for this specific
    // surface (see AI_HERO_ART's doc comment above).
    backdropUrl: aiHero?.backdropUrl ?? real?.backdropUrl ?? item.backdropUrl,
    logoUrl: real?.logoUrl ?? item.logoUrl,
    // Continue Watching's 16:9 thumbnails don't have a per-episode TMDB
    // equivalent wired up here (that needs a season/episode-level
    // images call), so this uses the show/movie's general backdrop
    // instead — same 16:9 aspect, and (per this function's own "real art
    // always wins" contract, same as backdropUrl/posterUrl above) a real
    // photo beats the local placeholder blur jpgs in mockData.ts even
    // when one of those was explicitly set. Was `item.thumbnailUrl ?? ...`
    // (placeholder-first), which silently kept every Continue Watching
    // row on its flat blue/green/yellow placeholder blur even once real
    // TMDB art was available for that title.
    thumbnailUrl: aiHero?.backdropUrl ?? real?.backdropUrl ?? item.thumbnailUrl,
    // Real TMDB plot synopsis wins over the mock's short marketing-style
    // blurb — but only when the item didn't deliberately set a curated
    // one-liner (the FEATURED_ITEMS hero taglines, e.g. "Epic worlds.
    // Epic destiny.", are intentional and should never be overwritten).
    description: item.description ?? real?.overview
  }
}

function movie(
  partial: Omit<
    MediaItem,
    | 'id'
    | 'mediaType'
    | 'watched'
    | 'completed'
    | 'disliked'
    | 'inMyList'
    | 'genres'
    | 'artTint'
    | 'initials'
  > &
    Partial<Pick<MediaItem, 'watched' | 'completed' | 'disliked' | 'inMyList'>> & {
      genres: string[]
      artTint: [string, string]
      initials: string
    }
): MediaItem {
  return withRealArtwork({
    id: nextId('m'),
    mediaType: 'movie',
    watched: false,
    completed: false,
    disliked: false,
    inMyList: false,
    ...partial
  })
}

function series(
  partial: Omit<
    MediaItem,
    | 'id'
    | 'mediaType'
    | 'watched'
    | 'completed'
    | 'disliked'
    | 'inMyList'
    | 'genres'
    | 'artTint'
    | 'initials'
  > &
    Partial<Pick<MediaItem, 'watched' | 'completed' | 'disliked' | 'inMyList'>> & {
      genres: string[]
      artTint: [string, string]
      initials: string
    }
): MediaItem {
  return withRealArtwork({
    id: nextId('s'),
    mediaType: 'series',
    watched: false,
    completed: false,
    disliked: false,
    inMyList: false,
    ...partial
  })
}

// MediaType has no 'anime' member (see types/index.ts) — mock anime items
// use mediaType: 'series' (same episodic-series shape) plus mediaKind:
// 'anime' set explicitly, mirroring what the real backend adapter
// (lib/mediaHub/adapters.ts's catalogItemToMediaItem) does for live data.
// Setting mediaKind here is what lets the Anime page's mock fallback
// actually resolve to these items instead of an empty pool.
function anime(
  partial: Omit<
    MediaItem,
    | 'id'
    | 'mediaType'
    | 'mediaKind'
    | 'watched'
    | 'completed'
    | 'disliked'
    | 'inMyList'
    | 'genres'
    | 'artTint'
    | 'initials'
  > &
    Partial<Pick<MediaItem, 'watched' | 'completed' | 'disliked' | 'inMyList'>> & {
      genres: string[]
      artTint: [string, string]
      initials: string
    }
): MediaItem {
  return withRealArtwork({
    id: nextId('a'),
    mediaType: 'series',
    mediaKind: 'anime',
    watched: false,
    completed: false,
    disliked: false,
    inMyList: false,
    ...partial
  })
}

// ---------- Featured hero rotation ----------
export const FEATURED_ITEMS: MediaItem[] = [
  movie({
    title: 'DUNE',
    subtitle: 'PART TWO',
    description: 'Epic worlds. Epic destiny.\nContinue the journey.',
    releaseYear: 2024,
    runtimeMinutes: 166,
    genres: ['Sci-Fi', 'Adventure'],
    moods: ['mind-bending', 'action'],
    communityRating: 8.5,
    imdbRating: 8.5,
    artTint: ['#ff8a3d', '#3a1604'],
    initials: 'D2',
    inMyList: false,
    backdropUrl: '/media/backdrops/dune-part-two.jpg',
    posterUrl: '/media/posters/dune-part-two.jpg'
  }),
  series({
    title: 'THE LAST OF US',
    subtitle: 'SEASON 2',
    description: "Twenty years after the outbreak.\nSome bonds can't be broken.",
    releaseYear: 2025,
    genres: ['Drama', 'Thriller'],
    moods: ['thrilling', 'emotional'],
    communityRating: 8.6,
    imdbRating: 8.5,
    artTint: ['#2f6b4f', '#08150f'],
    initials: 'TL',
    backdropUrl: '/media/backdrops/last-of-us-s2.jpg',
    posterUrl: '/media/posters/last-of-us-s2.jpg'
  }),
  movie({
    title: 'BLADE RUNNER',
    subtitle: '2049',
    description: 'The truth was worth dying for.\nA new hero rises.',
    releaseYear: 2017,
    runtimeMinutes: 164,
    genres: ['Sci-Fi', 'Drama'],
    moods: ['mind-bending', 'emotional'],
    communityRating: 8.0,
    imdbRating: 8.0,
    artTint: ['#ff7a28', '#120c22'],
    initials: 'BR',
    backdropUrl: '/media/backdrops/blade-runner-2049.jpg',
    posterUrl: '/media/posters/blade-runner-2049.jpg'
  }),
  movie({
    title: 'INTERSTELLAR',
    description: 'Mankind was born on Earth.\nIt was never meant to die here.',
    releaseYear: 2014,
    runtimeMinutes: 169,
    genres: ['Sci-Fi', 'Adventure'],
    moods: ['mind-bending', 'emotional'],
    communityRating: 8.6,
    imdbRating: 8.6,
    artTint: ['#18a9ff', '#050a14'],
    initials: 'IS',
    backdropUrl: '/media/backdrops/interstellar.jpg',
    posterUrl: '/media/posters/interstellar.jpg'
  })
]

// ---------- Continue watching ----------
export const CONTINUE_WATCHING: ContinueWatchingItem[] = [
  {
    media: series({
      title: 'Dark',
      seasonNumber: 2,
      episodeNumber: 6,
      episodeTitle: 'Ghosts',
      genres: ['Sci-Fi', 'Mystery'],
      communityRating: 8.7,
      imdbRating: 8.8,
      remainingMinutes: 42,
      progressPercentage: 68,
      artTint: ['#1c3a63', '#050a14'],
      initials: 'DK',
      thumbnailUrl: '/media/thumbnails/dark.jpg'
    }),
    lastPlayedAt: new Date().toISOString(),
    playbackPositionSeconds: 2040,
    durationSeconds: 3000
  },
  {
    media: series({
      title: 'The Last of Us',
      seasonNumber: 1,
      episodeNumber: 4,
      episodeTitle: 'Please Hold to My Hand',
      genres: ['Drama', 'Thriller'],
      communityRating: 9.1,
      imdbRating: 9.0,
      remainingMinutes: 22,
      progressPercentage: 84,
      artTint: ['#2f6b4f', '#08150f'],
      initials: 'TL',
      thumbnailUrl: '/media/thumbnails/the-last-of-us.jpg'
    }),
    lastPlayedAt: new Date().toISOString(),
    playbackPositionSeconds: 3200,
    durationSeconds: 3800
  },
  {
    media: movie({
      title: 'Fallout',
      genres: ['Sci-Fi', 'Action'],
      communityRating: 8.2,
      imdbRating: 8.4,
      remainingMinutes: 15,
      progressPercentage: 91,
      artTint: ['#a68a2c', '#140f04'],
      initials: 'FO',
      thumbnailUrl: '/media/thumbnails/fallout.jpg'
    }),
    lastPlayedAt: new Date().toISOString(),
    playbackPositionSeconds: 3500,
    durationSeconds: 3900
  },
  {
    media: movie({
      title: 'Dune: Part One',
      genres: ['Sci-Fi', 'Adventure'],
      communityRating: 8.0,
      imdbRating: 8.0,
      progressPercentage: 100,
      watched: true,
      completed: true,
      artTint: ['#ff8a3d', '#3a1604'],
      initials: 'D1'
    }),
    lastPlayedAt: new Date(Date.now() - 86400000).toISOString(),
    playbackPositionSeconds: 9000,
    durationSeconds: 9000
  }
]

// ---------- AI picks carousel ----------
export const AI_PICKS: Recommendation[] = [
  {
    media: movie({
      title: 'Blade Runner 2049',
      releaseYear: 2017,
      genres: ['Sci-Fi', 'Drama'],
      moods: ['mind-bending', 'emotional'],
      communityRating: 8.0,
      imdbRating: 8.0,
      matchPercentage: 95,
      artTint: ['#ff7a28', '#120c22'],
      initials: 'BR',
      posterUrl: '/media/posters/blade-runner-2049.jpg'
    }),
    confidence: 95,
    reasons: ['Because you watched Dune: Part One', 'Matches your taste for Sci-Fi'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Interstellar',
      releaseYear: 2014,
      genres: ['Sci-Fi', 'Adventure'],
      moods: ['mind-bending', 'emotional'],
      communityRating: 8.6,
      imdbRating: 8.6,
      matchPercentage: 93,
      artTint: ['#18a9ff', '#050a14'],
      initials: 'IS',
      posterUrl: '/media/posters/interstellar.jpg'
    }),
    confidence: 93,
    reasons: ['Top rated in Sci-Fi', 'Similar to Dune'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'The Martian',
      releaseYear: 2015,
      genres: ['Sci-Fi', 'Adventure'],
      moods: ['feel-good', 'mind-bending'],
      communityRating: 8.0,
      imdbRating: 8.0,
      matchPercentage: 91,
      artTint: ['#c97a2b', '#160f04'],
      initials: 'TM',
      posterUrl: '/media/posters/the-martian.jpg'
    }),
    confidence: 91,
    reasons: ['Because you liked Interstellar'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Arrival',
      releaseYear: 2016,
      genres: ['Sci-Fi', 'Drama'],
      moods: ['mind-bending', 'emotional'],
      communityRating: 7.9,
      imdbRating: 7.9,
      matchPercentage: 87,
      artTint: ['#5c6b78', '#0a0e12'],
      initials: 'AR',
      posterUrl: '/media/posters/arrival.jpg'
    }),
    confidence: 87,
    reasons: ['Highly rated First Contact story'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Ex Machina',
      releaseYear: 2014,
      genres: ['Sci-Fi', 'Thriller'],
      moods: ['mind-bending', 'thrilling'],
      communityRating: 7.7,
      imdbRating: 7.7,
      matchPercentage: 84,
      artTint: ['#2e8f7a', '#04120e'],
      initials: 'EM',
      posterUrl: '/media/posters/ex-machina.jpg'
    }),
    confidence: 84,
    reasons: ['Because you liked Blade Runner 2049'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Her',
      releaseYear: 2013,
      genres: ['Sci-Fi', 'Romance'],
      moods: ['emotional', 'feel-good'],
      communityRating: 8.0,
      imdbRating: 8.0,
      matchPercentage: 76,
      artTint: ['#c23e6b', '#170812'],
      initials: 'HR',
      posterUrl: '/media/posters/her.jpg'
    }),
    confidence: 76,
    reasons: ['Matches your recent mood: Emotional'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Annihilation',
      releaseYear: 2018,
      genres: ['Sci-Fi', 'Horror'],
      moods: ['thrilling', 'mind-bending'],
      communityRating: 6.9,
      imdbRating: 6.9,
      matchPercentage: 58,
      artTint: ['#2f9e5c', '#04140b'],
      initials: 'AN'
    }),
    confidence: 58,
    reasons: ['Explores similar themes to Arrival'],
    generatedAt: new Date().toISOString()
  },
  // ---- Expanded pool: the row now scales with window width (see
  // RecommendationCarousel), so it needs enough real titles to fill an
  // ultra-wide viewport instead of running out and leaving empty track.
  {
    media: movie({
      title: 'Inception',
      releaseYear: 2010,
      genres: ['Sci-Fi', 'Thriller'],
      moods: ['mind-bending', 'thrilling'],
      communityRating: 8.4,
      imdbRating: 8.8,
      matchPercentage: 96,
      artTint: ['#3d6bff', '#050818'],
      initials: 'IN'
    }),
    confidence: 96,
    reasons: ['Because you liked Interstellar', "Christopher Nolan's mind-bending work"],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'The Prestige',
      releaseYear: 2006,
      genres: ['Drama', 'Mystery'],
      moods: ['mind-bending', 'thrilling'],
      communityRating: 8.2,
      imdbRating: 8.5,
      matchPercentage: 89,
      artTint: ['#6b5a3d', '#100c04'],
      initials: 'PR'
    }),
    confidence: 89,
    reasons: ['More from Christopher Nolan'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Minority Report',
      releaseYear: 2002,
      genres: ['Sci-Fi', 'Thriller'],
      moods: ['thrilling', 'mind-bending'],
      communityRating: 7.6,
      imdbRating: 7.6,
      matchPercentage: 82,
      artTint: ['#5c7a8a', '#08120e'],
      initials: 'MR'
    }),
    confidence: 82,
    reasons: ['Because you liked Blade Runner 2049'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Edge of Tomorrow',
      releaseYear: 2014,
      genres: ['Sci-Fi', 'Action'],
      moods: ['action', 'thrilling'],
      communityRating: 7.9,
      imdbRating: 7.9,
      matchPercentage: 85,
      artTint: ['#3d8aff', '#040a18'],
      initials: 'ET'
    }),
    confidence: 85,
    reasons: ['Matches your taste for Sci-Fi Action'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Looper',
      releaseYear: 2012,
      genres: ['Sci-Fi', 'Thriller'],
      moods: ['mind-bending', 'thrilling'],
      communityRating: 7.4,
      imdbRating: 7.4,
      matchPercentage: 80,
      artTint: ['#c9622b', '#150a04'],
      initials: 'LP'
    }),
    confidence: 80,
    reasons: ['Time-travel themes similar to Dark'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Oblivion',
      releaseYear: 2013,
      genres: ['Sci-Fi', 'Adventure'],
      moods: ['mind-bending', 'action'],
      communityRating: 7.0,
      imdbRating: 7.0,
      matchPercentage: 74,
      artTint: ['#3daaff', '#040c18'],
      initials: 'OB'
    }),
    confidence: 74,
    reasons: ['Because you liked Interstellar'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Elysium',
      releaseYear: 2013,
      genres: ['Sci-Fi', 'Action'],
      moods: ['action', 'thrilling'],
      communityRating: 6.8,
      imdbRating: 6.6,
      matchPercentage: 70,
      artTint: ['#8a9a4a', '#0c1004'],
      initials: 'EL'
    }),
    confidence: 70,
    reasons: ['More dystopian Sci-Fi Action'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'District 9',
      releaseYear: 2009,
      genres: ['Sci-Fi', 'Thriller'],
      moods: ['thrilling', 'mind-bending'],
      communityRating: 7.5,
      imdbRating: 7.9,
      matchPercentage: 81,
      artTint: ['#8a7a2f', '#100e04'],
      initials: 'D9'
    }),
    confidence: 81,
    reasons: ['Highly rated genre-bending Sci-Fi'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Children of Men',
      releaseYear: 2006,
      genres: ['Sci-Fi', 'Drama'],
      moods: ['emotional', 'thrilling'],
      communityRating: 7.7,
      imdbRating: 7.9,
      matchPercentage: 78,
      artTint: ['#5c5c5c', '#0a0a0a'],
      initials: 'CM'
    }),
    confidence: 78,
    reasons: ['Because you liked Arrival'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Gravity',
      releaseYear: 2013,
      genres: ['Sci-Fi', 'Drama'],
      moods: ['thrilling', 'emotional'],
      communityRating: 7.3,
      imdbRating: 7.7,
      matchPercentage: 83,
      artTint: ['#1c3a63', '#04070f'],
      initials: 'GR'
    }),
    confidence: 83,
    reasons: ['Because you liked The Martian'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'The Matrix',
      releaseYear: 1999,
      genres: ['Sci-Fi', 'Action'],
      moods: ['mind-bending', 'action'],
      communityRating: 8.2,
      imdbRating: 8.7,
      matchPercentage: 94,
      artTint: ['#1cff6b', '#020f06'],
      initials: 'MX'
    }),
    confidence: 94,
    reasons: ['A foundational pick for your taste in Sci-Fi'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: '12 Monkeys',
      releaseYear: 1995,
      genres: ['Sci-Fi', 'Mystery'],
      moods: ['mind-bending', 'thrilling'],
      communityRating: 7.6,
      imdbRating: 8.0,
      matchPercentage: 79,
      artTint: ['#6b6b8a', '#0a0a10'],
      initials: '12'
    }),
    confidence: 79,
    reasons: ['Time-loop themes similar to Dark'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Moon',
      releaseYear: 2009,
      genres: ['Sci-Fi', 'Drama'],
      moods: ['mind-bending', 'emotional'],
      communityRating: 7.7,
      imdbRating: 7.8,
      matchPercentage: 77,
      artTint: ['#8a8a9a', '#0c0c10'],
      initials: 'MN'
    }),
    confidence: 77,
    reasons: ['A quiet, cerebral pick like Ex Machina'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Snowpiercer',
      releaseYear: 2013,
      genres: ['Sci-Fi', 'Action'],
      moods: ['thrilling', 'action'],
      communityRating: 7.1,
      imdbRating: 7.1,
      matchPercentage: 75,
      artTint: ['#3d7aff', '#04080f'],
      initials: 'SN'
    }),
    confidence: 75,
    reasons: ['Dystopian Sci-Fi with a strong following'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'A Quiet Place',
      releaseYear: 2018,
      genres: ['Horror', 'Thriller'],
      moods: ['thrilling', 'emotional'],
      communityRating: 7.9,
      imdbRating: 7.5,
      matchPercentage: 73,
      artTint: ['#5c5c6b', '#08080c'],
      initials: 'QP'
    }),
    confidence: 73,
    reasons: ['Matches your recent mood: Thrilling'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Prisoners',
      releaseYear: 2013,
      genres: ['Thriller', 'Drama'],
      moods: ['thrilling', 'emotional'],
      communityRating: 8.0,
      imdbRating: 8.1,
      matchPercentage: 76,
      artTint: ['#6b6b3d', '#0c0c04'],
      initials: 'PS'
    }),
    confidence: 76,
    reasons: ['Highly rated psychological Thriller'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Sicario',
      releaseYear: 2015,
      genres: ['Thriller', 'Drama'],
      moods: ['thrilling', 'mind-bending'],
      communityRating: 7.5,
      imdbRating: 7.6,
      matchPercentage: 72,
      artTint: ['#8a5c2f', '#0f0804'],
      initials: 'SC'
    }),
    confidence: 72,
    reasons: ['More from the Prisoners cast and crew'],
    generatedAt: new Date().toISOString()
  },
  {
    media: movie({
      title: 'Gone Girl',
      releaseYear: 2014,
      genres: ['Thriller', 'Mystery'],
      moods: ['thrilling', 'mind-bending'],
      communityRating: 8.1,
      imdbRating: 8.1,
      matchPercentage: 88,
      artTint: ['#6b3d5c', '#0c040a'],
      initials: 'GG'
    }),
    confidence: 88,
    reasons: ['A sharp psychological Mystery pick'],
    generatedAt: new Date().toISOString()
  }
]

// ---------- Mood catalog (also used to seed the "browse by mood" filter) ----------
export const MOOD_CATEGORIES: MoodCategory[] = [
  {
    id: 'thrilling',
    label: 'Thrilling',
    headline: 'Keep your pulse up.',
    description: 'High-stakes stories built to move at full speed.',
    icon: 'pulse',
    hue: 210,
    accent: '#18a9ff'
  },
  {
    id: 'emotional',
    label: 'Emotional',
    headline: 'Stories that stay with you.',
    description: 'Heartfelt watches for when you want to feel something.',
    icon: 'heart',
    hue: 330,
    accent: '#ff4fa7'
  },
  {
    id: 'mind-bending',
    label: 'Mind-Bending',
    headline: 'Leave certainty behind.',
    description: 'Ideas, mysteries, and worlds that reward a second thought.',
    icon: 'planet',
    hue: 265,
    accent: '#8d4dff'
  },
  {
    id: 'feel-good',
    label: 'Feel Good',
    headline: 'Leave a little lighter.',
    description: 'Easygoing stories with warmth, wit, and a bright finish.',
    icon: 'smiley',
    hue: 48,
    accent: '#f4cb45'
  },
  {
    id: 'family',
    label: 'Family',
    headline: 'Make room on the couch.',
    description: 'Shared adventures and familiar favourites for everyone nearby.',
    icon: 'people',
    hue: 165,
    accent: '#2fd39b'
  },
  {
    id: 'sci-fi',
    label: 'Sci-Fi',
    headline: 'Beyond the known.',
    description: 'Future worlds, distant galaxies, and possibilities without limits.',
    icon: 'planet',
    hue: 195,
    accent: '#38e5ff'
  },
  {
    id: 'action',
    label: 'Action',
    headline: 'Turn the energy all the way up.',
    description: 'Big momentum, close calls, and no time to look away.',
    icon: 'lightning',
    hue: 28,
    accent: '#ff7a28'
  }
]

/** Display labels for a list of mood ids, silently dropping ids that no
    longer exist in the catalog. Shared so the Home tray and the full
    collection page can never disagree about how an id reads. */
export function moodLabelsFor(ids: string[]): string[] {
  return ids
    .map((id) => MOOD_CATEGORIES.find((mood) => mood.id === id)?.label)
    .filter((label): label is string => Boolean(label))
}

/** The mood a combined selection takes its accent, icon and copy from. */
export function leadMoodFor(ids: string[]): MoodCategory | undefined {
  return MOOD_CATEGORIES.find((mood) => mood.id === ids[0])
}

// Small hand-tagged anime pool — mock/offline fallback only for the Anime
// page and its hero (see useMediaHubBrowseCatalog/useMediaHubHomeFeed's
// "live" flag: this never blends with real Kitsu data, it's what shows
// before a backend connection exists or while it's unavailable).
export const ANIME_CATALOG: MediaItem[] = [
  anime({
    title: 'Frontier Blade',
    subtitle: 'Season 2',
    releaseYear: 2022,
    runtimeMinutes: 24,
    genres: ['Action', 'Fantasy', 'Shonen'],
    moods: ['action', 'thrilling'],
    communityRating: 8.4,
    imdbRating: 8.4,
    artTint: ['#7e45ff', '#0c0620'],
    initials: 'FB',
    description:
      'A wandering swordswoman crosses a fractured empire to break the curse binding her blade.'
  }),
  anime({
    title: 'Nightfall Signal',
    releaseYear: 2023,
    runtimeMinutes: 23,
    genres: ['Sci-Fi', 'Mecha'],
    moods: ['thrilling', 'mind-bending'],
    communityRating: 8.1,
    imdbRating: 8.0,
    artTint: ['#18a9ff', '#04101f'],
    initials: 'NS',
    description:
      'Pilots of derelict mechs defend the last orbital city from a signal no one can explain.'
  }),
  anime({
    title: 'Paper Skies',
    releaseYear: 2021,
    runtimeMinutes: 24,
    genres: ['Slice of Life', 'Romance'],
    moods: ['feel-good', 'emotional'],
    communityRating: 8.6,
    imdbRating: 8.5,
    artTint: ['#ff7a28', '#1f0d02'],
    initials: 'PS',
    description:
      'Two art-club rivals spend one slow, golden summer figuring out what they actually feel.'
  }),
  anime({
    title: 'Ashen Requiem',
    subtitle: 'Season 1',
    releaseYear: 2020,
    runtimeMinutes: 24,
    genres: ['Fantasy', 'Drama', 'Shonen'],
    moods: ['emotional', 'thrilling'],
    communityRating: 8.9,
    imdbRating: 8.8,
    artTint: ['#a3172c', '#140306'],
    initials: 'AR',
    description:
      'A disgraced knight and a runaway prince form an uneasy alliance to end a century-long war.'
  }),
  anime({
    title: 'Static Bloom',
    releaseYear: 2024,
    runtimeMinutes: 23,
    genres: ['Sci-Fi', 'Romance'],
    moods: ['mind-bending', 'emotional'],
    communityRating: 7.9,
    imdbRating: 7.8,
    artTint: ['#2fd39b', '#03140e'],
    initials: 'SB',
    description:
      'A memory-repair technician falls for the one client whose memories she is forbidden to fix.'
  }),
  anime({
    title: 'Ironclad Requiem',
    releaseYear: 2019,
    runtimeMinutes: 25,
    genres: ['Action', 'Mecha', 'Sci-Fi'],
    moods: ['action', 'thrilling'],
    communityRating: 8.2,
    imdbRating: 8.1,
    artTint: ['#f4cb45', '#191202'],
    initials: 'IR',
    description:
      'A conscript squad of teenage mecha pilots is all that stands between two collapsing empires.'
  })
]

// A broader catalog so mood filtering has something to show beyond what's
// already surfaced in Continue Watching / AI Picks.
export const CATALOG: MediaItem[] = [
  ...AI_PICKS.map((r) => r.media),
  ...CONTINUE_WATCHING.map((c) => c.media),
  ...FEATURED_ITEMS,
  ...ANIME_CATALOG,
  movie({
    title: 'The Grand Budapest Hotel',
    releaseYear: 2014,
    genres: ['Comedy', 'Drama'],
    moods: ['feel-good', 'family'],
    communityRating: 8.1,
    imdbRating: 8.1,
    artTint: ['#d9557a', '#1a0710'],
    initials: 'GB',
    posterUrl: '/media/posters/grand-budapest-hotel.jpg'
  }),
  movie({
    title: 'Paddington 2',
    releaseYear: 2017,
    genres: ['Family', 'Comedy'],
    moods: ['family', 'feel-good'],
    communityRating: 8.2,
    imdbRating: 8.2,
    artTint: ['#c0392b', '#1a0605'],
    initials: 'P2',
    posterUrl: '/media/posters/paddington-2.jpg'
  }),
  series({
    title: 'Stranger Things',
    genres: ['Sci-Fi', 'Horror'],
    moods: ['thrilling', 'family'],
    communityRating: 8.6,
    imdbRating: 8.7,
    artTint: ['#a3172c', '#150406'],
    initials: 'ST',
    posterUrl: '/media/posters/stranger-things.jpg'
  }),
  movie({
    title: 'Mad Max: Fury Road',
    releaseYear: 2015,
    genres: ['Action', 'Adventure'],
    moods: ['action', 'thrilling'],
    communityRating: 8.1,
    imdbRating: 8.1,
    artTint: ['#e08321', '#1a0f04'],
    initials: 'FR',
    posterUrl: '/media/posters/mad-max-fury-road.jpg'
  }),
  movie({
    title: 'John Wick',
    releaseYear: 2014,
    genres: ['Action', 'Thriller'],
    moods: ['action', 'thrilling'],
    communityRating: 7.4,
    imdbRating: 7.4,
    artTint: ['#8a1620', '#120304'],
    initials: 'JW',
    posterUrl: '/media/posters/john-wick.jpg'
  })
]

// ---------- Nav / chrome ----------
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', href: '/' },
  { id: 'movies', label: 'Movies', icon: 'movies', href: '/movies' },
  { id: 'tv', label: 'Series', icon: 'tv', href: '/series' },
  { id: 'anime', label: 'Anime', icon: 'anime', href: '/anime' },
  { id: 'mystuff', label: 'My Stuff', icon: 'mystuff', href: '/my-stuff' },
  // Its own entry rather than a tab inside My Stuff. "Is there anything
  // on tonight" is a different question from "what have I collected",
  // and it was sitting two clicks deep beside Stats and Not for me.
  { id: 'calendar', label: 'Calendar', icon: 'calendar', href: '/calendar' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' }
]

export const USER_PROFILES: UserProfile[] = [
  { id: 'p1', name: 'Graham', avatarInitial: 'G', avatarTint: ['#18a9ff', '#8d4dff'] },
  { id: 'p2', name: 'Jules', avatarInitial: 'J', avatarTint: ['#ff4fa7', '#8d4dff'] },
  { id: 'p3', name: 'Kids', avatarInitial: 'K', avatarTint: ['#f4cb45', '#ff7a28'], isKid: true }
]
