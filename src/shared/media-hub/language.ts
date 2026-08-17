// Language preference: making "play it in English" actually hold.
//
// Two separate things go wrong, and they need fixing in different places.
//
// 1. THE RELEASE. A film dubbed into another language is a different
//    release of the same title, and public trackers are full of them. Pick
//    "Movie.2024.TRUEFRENCH.1080p" and no amount of track selection can
//    save you: there is no English audio in the file. This has to be
//    settled when the stream is chosen (see core.ts's rankStreams).
//
// 2. THE TRACK. A multi-audio release can carry English and still mark
//    another language as the container default, and the default is what
//    plays. This has to be settled when the audio track is picked (see
//    vlc.ts's selectTranscodeAudioTrack).
//
// Pure and dependency-free so both the main process and the renderer can
// use it, and so the token lists are testable without a media file.

/**
 * ISO 639 is three overlapping standards and media files use all of them:
 * ffprobe reports 639-2/B ("fre"), some containers use 639-2/T ("fra"),
 * settings and UIs use 639-1 ("fr"). This maps every form of the
 * languages that actually show up in releases onto one key.
 *
 * Only the languages worth listing are listed. An unknown code still
 * works — it just compares literally, which is correct for anything not
 * in this table.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  en: 'en',
  eng: 'en',
  english: 'en',
  fr: 'fr',
  fre: 'fr',
  fra: 'fr',
  french: 'fr',
  es: 'es',
  spa: 'es',
  esp: 'es',
  spanish: 'es',
  de: 'de',
  ger: 'de',
  deu: 'de',
  german: 'de',
  it: 'it',
  ita: 'it',
  italian: 'it',
  pt: 'pt',
  por: 'pt',
  portuguese: 'pt',
  nl: 'nl',
  dut: 'nl',
  nld: 'nl',
  dutch: 'nl',
  ru: 'ru',
  rus: 'ru',
  russian: 'ru',
  pl: 'pl',
  pol: 'pl',
  polish: 'pl',
  ja: 'ja',
  jpn: 'ja',
  jap: 'ja',
  japanese: 'ja',
  ko: 'ko',
  kor: 'ko',
  korean: 'ko',
  zh: 'zh',
  chi: 'zh',
  zho: 'zh',
  chinese: 'zh',
  hi: 'hi',
  hin: 'hi',
  hindi: 'hi',
  ar: 'ar',
  ara: 'ar',
  arabic: 'ar',
  sv: 'sv',
  swe: 'sv',
  swedish: 'sv',
  da: 'da',
  dan: 'da',
  danish: 'da',
  no: 'no',
  nor: 'no',
  norwegian: 'no',
  fi: 'fi',
  fin: 'fi',
  finnish: 'fi',
  cs: 'cs',
  cze: 'cs',
  ces: 'cs',
  czech: 'cs',
  el: 'el',
  gre: 'el',
  ell: 'el',
  greek: 'el',
  he: 'he',
  heb: 'he',
  hebrew: 'he',
  tr: 'tr',
  tur: 'tr',
  turkish: 'tr',
  th: 'th',
  tha: 'th',
  thai: 'th',
  uk: 'uk',
  ukr: 'uk',
  ukrainian: 'uk',
  hu: 'hu',
  hun: 'hu',
  hungarian: 'hu',
  ro: 'ro',
  ron: 'ro',
  rum: 'ro',
  romanian: 'ro'
}

/** One canonical key for a language code in any of its forms. */
export function normalizeLanguage(code: string): string {
  const raw = String(code || '')
    .trim()
    .toLowerCase()
    // "en-US", "pt_BR" — the region is not the language.
    .split(/[-_]/)[0]
  return LANGUAGE_ALIASES[raw] ?? raw
}

/** Whether a track's declared language is the one wanted. An unlabelled
 *  track never matches: guessing that a blank tag means English is how you
 *  end up confidently playing the wrong audio. */
export function languageMatches(trackLanguage: string, preferred: string): boolean {
  const track = normalizeLanguage(trackLanguage)
  const want = normalizeLanguage(preferred)
  if (!track || !want) return false
  return track === want
}

/**
 * Tokens in a release name that mark it as a localisation — a dub or a
 * hard-subbed foreign cut — of content that also exists in its original
 * language.
 *
 * Deliberately excludes ja/ko/zh and their names. A Japanese-audio release
 * is not a "foreign dub" to be avoided, it is the original work, and this
 * app has an entire anime section; penalising those would be a bug, not a
 * feature. The concern here is specifically "this is the French dub of an
 * English film", which is what actually gets picked by accident.
 */
const LOCALISED_RELEASE_TOKENS: Record<string, string> = {
  french: 'fr',
  truefrench: 'fr',
  vff: 'fr',
  vfq: 'fr',
  vfi: 'fr',
  vostfr: 'fr',
  subfrench: 'fr',
  german: 'de',
  deutsch: 'de',
  italian: 'it',
  ita: 'it',
  spanish: 'es',
  castellano: 'es',
  latino: 'es',
  russian: 'ru',
  polish: 'pl',
  lektor: 'pl',
  portuguese: 'pt',
  dublado: 'pt',
  hindi: 'hi',
  turkish: 'tr',
  czech: 'cs',
  hungarian: 'hu',
  greek: 'el',
  romanian: 'ro',
  ukrainian: 'uk'
}

/** Tokens meaning "this carries more than one audio language", which
 *  almost always includes the original. Their presence cancels a
 *  localisation marker rather than adding to it. */
const MULTI_LANGUAGE_TOKENS = new Set(['multi', 'dual', 'dualaudio', 'multiaudio', 'multi audio'])

function tokenize(text: string): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Whether a release advertises itself as a localisation into some language
 * OTHER than the preferred one, with nothing to suggest the preferred one
 * is also present.
 *
 * Used as a ranking penalty rather than an exclusion (see core.ts): if the
 * only copy of a film anywhere is the French dub, playing it beats
 * refusing to play anything. It just must never win over an English one.
 */
export function releaseLacksPreferredLanguage(text: string, preferred: string): boolean {
  const want = normalizeLanguage(preferred)
  if (!want) return false
  const tokens = tokenize(text)
  if (!tokens.length) return false
  // Says outright that it includes the wanted language.
  if (tokens.some((t) => MULTI_LANGUAGE_TOKENS.has(t))) return false
  if (tokens.some((t) => LANGUAGE_ALIASES[t] === want)) return false
  return tokens.some((t) => {
    const marked = LOCALISED_RELEASE_TOKENS[t]
    return Boolean(marked) && marked !== want
  })
}

/** Which other language a release looks localised into, for a message
 *  worth showing someone ("this one is the French dub"). Null when it
 *  isn't marked, or is marked as the preferred language. */
export function releaseLocalisedInto(text: string, preferred: string): string | null {
  if (!releaseLacksPreferredLanguage(text, preferred)) return null
  for (const token of tokenize(text)) {
    const marked = LOCALISED_RELEASE_TOKENS[token]
    if (marked && marked !== normalizeLanguage(preferred)) return marked
  }
  return null
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  ru: 'Russian',
  pl: 'Polish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  el: 'Greek',
  he: 'Hebrew',
  tr: 'Turkish',
  th: 'Thai',
  uk: 'Ukrainian',
  hu: 'Hungarian',
  ro: 'Romanian'
}

/** Human-readable name for a language code, falling back to the code
 *  itself uppercased rather than inventing one. */
export function languageName(code: string): string {
  const key = normalizeLanguage(code)
  return LANGUAGE_NAMES[key] ?? key.toUpperCase()
}

/** The languages offered in Settings. Ordered by how often they actually
 *  appear on releases, not alphabetically. */
export const SELECTABLE_LANGUAGES: readonly string[] = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'nl',
  'ru',
  'pl',
  'ja',
  'ko',
  'zh',
  'hi',
  'ar',
  'sv',
  'da',
  'no',
  'fi',
  'cs',
  'el',
  'he',
  'tr',
  'th',
  'uk',
  'hu',
  'ro'
]
