// The static, non-catalogue data this app's chrome is built from: the mood
// taxonomy the Browse By Mood tray and /mood pages read, the nav rail's
// entries, and the profile list shown before the main process answers with
// the real ones.
//
// This file used to be mockData.ts and carried a demo catalogue as well —
// a hand-written pool of ~50 titles that stood in for the backend before
// one existed and stayed on afterwards as an offline fallback. It is gone.
// Every title this app shows now comes from the real catalogue, because a
// fallback pool has no honest way to present itself: it either looks like
// the person's own library when it isn't, or it has to explain itself in a
// toast — and that explanation was landing on real titles (a tracked show
// with a perfectly good IMDb id was told it was "a demo title from the
// built-in sample catalog", because the check behind the toast was really
// asking whether the id could be pushed to a tracking service).
//
// Nothing below names a title. Keep it that way.

import { MoodCategory, NavItem, UserProfile } from '../types'

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

// ---------- Nav / chrome ----------
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', href: '/' },
  // The whole ranking, shelved by reason. Home shows one row of it and
  // cannot scroll; this is where the rest is.
  { id: 'foryou', label: 'For You', icon: 'sparkle', href: '/for-you' },
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
