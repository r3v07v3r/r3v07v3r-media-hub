// Everything about talking to a local Ollama instance that doesn't need a
// socket: address/model validation, response parsing, and the prompts the
// app's AI features send. The network calls and the IPC handlers live in
// main/media-hub/ollamaService.ts, matching how opensubtitles.ts is split
// from subtitlesService.ts — this half stays electron-free and
// dependency-free so it can be unit-tested directly (see tests/ollama.test.ts).
//
// Why Ollama at all: the assistant used to answer from a hardcoded string
// and the "Recommend Next ..." buttons picked at random on a fake think-
// timer. Neither needed a model, and neither was honest about it. Both go
// through a model the person actually installed themselves now, on their
// own machine, or they say plainly that no model is connected.

/** Ollama's own default bind address. Offered as the placeholder in Settings; nothing assumes it. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

/** Upper bound on how many titles get listed in a prompt. Local models run
 *  on the person's own hardware, and prompt length is the main thing that
 *  decides how long they take to answer — a few dozen titles is enough
 *  context to ground an answer without turning a question into a minute of
 *  waiting on a small model. */
export const MAX_PROMPT_TITLES = 40

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** The bit of a catalog item worth putting in front of a model — enough to identify and describe a title, nothing else. */
export interface OllamaTitleRef {
  id: string
  title: string
  year?: number
  genres?: string[]
}

/**
 * Normalizes a user-typed Ollama address into an origin (plus path prefix,
 * for the reverse-proxy case) with no trailing slash, or '' if it can't be
 * one.
 *
 * A bare `localhost:11434` or `192.168.1.5:11434` is what people actually
 * type, so a missing scheme is filled in rather than rejected. Everything
 * else is refused outright: this string becomes the host of a fetch() the
 * main process makes, so only http/https are accepted, and an address
 * carrying credentials (`http://user:pass@host`) is rejected rather than
 * quietly stored in plain text in the settings file.
 */
export function normalizeOllamaBaseUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return ''
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (url.username || url.password) return ''
  if (!url.hostname) return ''

  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * Validates a model tag as Ollama writes them — `llama3.2`, `qwen2.5:7b`,
 * `hf.co/user/repo:Q4_K_M`. Returns '' for anything outside that shape
 * rather than passing it on: the tag is interpolated into a JSON request
 * body, and there is no reason a real model name would need any other
 * character.
 */
export function normalizeOllamaModel(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .slice(0, 120)
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(raw) ? raw : ''
}

/** Model tags from a `GET /api/tags` body, de-duplicated and sorted. Tolerates any shape — this is a response from a server the person pointed us at, not something to trust. */
export function parseOllamaModels(payload: unknown): string[] {
  const models = (payload as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const names = new Set<string>()
  for (const entry of models) {
    const name =
      (entry as { name?: unknown; model?: unknown })?.name ?? (entry as { model?: unknown })?.model
    const normalized = normalizeOllamaModel(name)
    if (normalized) names.add(normalized)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * The assistant text out of a `POST /api/chat` (or `/api/generate`) body.
 *
 * Reasoning models (deepseek-r1 and friends) put their working out in a
 * <think> block ahead of the answer when the server doesn't split it into
 * its own field — that is the model thinking aloud, not its reply, so it is
 * dropped rather than shown. An unterminated block means the answer was cut
 * off mid-thought and there is nothing to show at all.
 */
export function parseOllamaReply(payload: unknown): string {
  const body = payload as { message?: { content?: unknown }; response?: unknown }
  const raw = String(body?.message?.content ?? body?.response ?? '')
  if (!raw.trim()) return ''
  if (/<think>/i.test(raw) && !/<\/think>/i.test(raw)) return ''
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\s+$/, '')
    .trim()
}

/** One title per line, in the compact form the prompts below reference. */
function titleLines(titles: OllamaTitleRef[]): string {
  return titles
    .slice(0, MAX_PROMPT_TITLES)
    .map((item) => {
      const year = item.year ? ` (${item.year})` : ''
      const genres = item.genres?.length ? ` — ${item.genres.slice(0, 3).join(', ')}` : ''
      return `- ${item.title}${year}${genres}`
    })
    .join('\n')
}

/**
 * The top-bar assistant's prompt. The library listing is context, not a
 * menu: people ask this field general questions ("what's a good rainy
 * Sunday film?") as often as they ask it about their own catalog, and a
 * model told to answer only from the list gives worse answers to the first
 * kind. It is told to prefer what's there when it fits, and the length cap
 * is explicit because the answer is rendered in a small floating panel.
 */
export function buildAssistantMessages(
  question: string,
  library: OllamaTitleRef[]
): OllamaMessage[] {
  const listing = titleLines(library)
  return [
    {
      role: 'system',
      content: [
        'You are R3, the assistant inside a movie, series and anime app.',
        'Answer in at most three sentences, in plain prose — no lists, no markdown, no preamble.',
        'When you name a title, name it exactly once and say in a few words why it fits.',
        listing
          ? `Some of what is available in this app right now:\n${listing}\nPrefer these when one genuinely fits the question. If none do, recommend something else and say so.`
          : 'You have no listing of this catalog, so answer from general knowledge.'
      ].join('\n')
    },
    { role: 'user', content: question }
  ]
}

/**
 * The "Recommend Next Movie/Series/Anime" prompt. Constrained to the
 * candidate list because this one really is a menu — the button opens the
 * title it picks, so a title the app doesn't have is useless. The reply
 * format is deliberately trivial to parse (one line, `Title — reason`) and
 * matchRecommendation below still verifies the answer against the list
 * rather than trusting it.
 */
export function buildRecommendationMessages(
  kindLabel: string,
  candidates: OllamaTitleRef[]
): OllamaMessage[] {
  return [
    {
      role: 'system',
      content: [
        `You pick one ${kindLabel} for someone to watch next, from a fixed list.`,
        'Reply with exactly one line: the title exactly as written in the list — including the year in brackets, if the list shows one — then " — ", then one short sentence on why.',
        'Never pick anything that is not on the list. Never add anything else to your reply.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Pick one of these:\n${titleLines(candidates)}`
    }
  ]
}

/** Escapes a title so it can be matched as a literal inside a regex. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * What must NOT sit against a title for it to count as named: letters,
 * digits, hyphens and colons.
 *
 * The first three keep a title from matching inside a longer word. The colon
 * is there for a different reason — it is how a title continues into its own
 * subtitle. Without it, a shortlist holding Dune but not Dune: Part Two
 * matched "Dune: Part Two — the sequel" as Dune, opened it, and captioned it
 * with the sequel's reason; a title the app was never offered has to fall
 * back, not resolve to its own prefix.
 */
const TITLE_EDGE = '[\\p{L}\\p{N}:-]'

/**
 * Whether `reply` mentions `title` as a phrase in its own right, rather than
 * as a run of characters inside a longer word.
 *
 * Three guards, because real titles include Up, It, Us and Spider:
 *
 *  - Word boundaries, so "an uplifting choice" does not count as picking Up.
 *  - A hyphen counts as part of the word, so "Spider-Man" is one name rather
 *    than the candidate Spider followed by something else. Hyphenated
 *    compounds are how English writes a single word, and a bare boundary
 *    check reads straight through them.
 *  - Case sensitivity, so "it depends" does not count as picking It. This is
 *    the one place matching is case-sensitive, and deliberately so: the
 *    exact-title paths in matchRecommendation are confident about what they
 *    are looking at and stay forgiving, while this last-resort scan over
 *    free prose is guessing. A model naming a title is copying it from the
 *    list it was given, capitals and all; the same word in lower case is
 *    almost always just the sentence around it.
 *
 * Case alone is not enough for a word like "It", which grammar capitalises
 * at the start of any sentence — see AMBIGUOUS_TITLE_WORDS below, which is
 * the guard for that.
 *
 * The cost is a reply that lower-cases a title it genuinely meant, which
 * falls back to the random pick. That is a far better failure than opening a
 * film nobody asked for.
 */
function mentionsTitle(reply: string, title: string): boolean {
  const pattern = `(?<!${TITLE_EDGE})${escapeForRegex(title)}(?!${TITLE_EDGE})`
  return new RegExp(pattern, 'u').test(reply)
}

/**
 * The year written immediately after this title where it appears — the form
 * titleLines puts into the listing the model is shown, "Dune (1984)".
 *
 * Adjacency is the whole point, and is why this is not just "the first year
 * in the text". A single line can carry a year that belongs to something
 * else entirely — "Considering releases from (2021), Dune (1984) is my
 * pick." — and taking the first one there opens the 2021 film the model
 * just declined to pick. Only a year bracketed directly against the title
 * is that title's year.
 *
 * Occurrences of the title that carry no year are skipped rather than
 * ending the search, so "Dune is great. Actually, Dune (1984) is my pick."
 * still finds 1984.
 */
function yearAfterTitle(text: string, title: string): number | undefined {
  const pattern = `(?<!${TITLE_EDGE})${escapeForRegex(title)}(?!${TITLE_EDGE})\\s*\\((\\d{4})\\)`
  const found = text.match(new RegExp(pattern, 'u'))
  return found ? Number(found[1]) : undefined
}

/**
 * Words that turn up constantly in an ordinary English sentence and are also
 * real film titles: It, Us, Up, Her, Them, Go, Down, Out.
 *
 * Case tells a title from prose for most of them — but not at the start of a
 * sentence, where grammar capitalises the pronoun too. "It depends on your
 * mood" is an off-list answer that looks exactly like naming It (2017). No
 * amount of boundary or case checking separates those, because there is
 * nothing in the characters to separate: only the grammar differs, and this
 * is a regex, not a parser.
 *
 * So for these words alone, the loose prose scan demands that the reply mark
 * the title AS a title — quoted, or carrying its year. Everything else keeps
 * the plain boundary-and-case check, because a bare mention of a distinctive
 * title is already strong evidence.
 *
 * Closed-class words plus the handful of verbs and adjectives that appear in
 * almost any short recommendation. Over-inclusion is close to free: the cost
 * is that a genuine "Best" or "New" needs quotes or a year to be picked up,
 * and without them it falls back to a random pick. Under-inclusion opens a
 * film nobody asked for.
 */
const AMBIGUOUS_TITLE_WORDS = new Set(
  `a an the this that these those some any all no none each every both
   i me my mine you your he him his she her hers it its we us our they them their
   who what which whose
   in on at to of for from with by as up down out off over under into onto
   about after before between through around against along across
   and or but if so than then because while when where why how
   is are was were am be been being do does did have has had can will would should
   go goes get got see saw make made take took come came know think want say
   not very just only more most now here there yes well still also too
   one two three first last next new old good best`
    .split(/\s+/)
    .filter(Boolean)
)

/** Quote characters a model might wrap a title in, opening and closing. */
const QUOTES = '["\'“”‘’«»]'

/**
 * Whether the reply marks `title` as a title rather than merely containing
 * those words — quoted, or followed by its year. Only asked of the words in
 * AMBIGUOUS_TITLE_WORDS above.
 */
function namesTitleExplicitly(reply: string, title: string): boolean {
  const quoted = new RegExp(`${QUOTES}\\s*${escapeForRegex(title)}\\s*${QUOTES}`, 'u')
  return quoted.test(reply) || yearAfterTitle(reply, title) !== undefined
}

/** True for a single word so common that a bare mention of it proves nothing. */
function isAmbiguousTitle(title: string): boolean {
  return AMBIGUOUS_TITLE_WORDS.has(title.trim().toLowerCase())
}

/**
 * Narrows several candidates sharing one title down to the one the model
 * meant, using the year it echoed back.
 *
 * Remakes and reboots make this real: a shortlist can hold Dune (1984) and
 * Dune (2021), and picking whichever came first in the array would open a
 * different film from the one the model named. The year in the reply is the
 * only thing that separates them, which is why the prompt now asks for it
 * and the listing has always shown it.
 *
 * A year that matches nothing falls back to the first same-titled candidate
 * rather than giving up — a model that misremembers the year of the only
 * Dune on the list still picked that Dune.
 */
function narrowByYear(matches: OllamaTitleRef[], year: number | undefined): OllamaTitleRef {
  if (matches.length === 1 || !year) return matches[0]
  return matches.find((item) => item.year === year) ?? matches[0]
}

/** Candidates ordered so a title that merely prefixes another is always tried second. */
function longestTitleFirst(candidates: OllamaTitleRef[]): OllamaTitleRef[] {
  return [...candidates].sort((a, b) => b.title.length - a.title.length)
}

/**
 * Reads a `Title (year) — reason` line by finding which candidate title it
 * opens with, rather than by splitting on the first dash and hoping that was
 * the separator.
 *
 * The order matters and is the whole point. Titles contain spaced dashes —
 * "Batman - The Movie" — so splitting first and matching second hands back
 * "Batman", which is a different film that may well be on the same
 * shortlist; the button then opens the wrong one with the rest of its own
 * title as the reason. Trying the longest candidate title first means the
 * fuller title claims the line before its own prefix ever gets to.
 *
 * Both spaces around the separator are required for the same reason: without
 * them, "Spider-Man" would read as the candidate "Spider" plus a reason of
 * "Man".
 */
function matchLinePrefix(
  line: string,
  candidates: OllamaTitleRef[]
): { match: OllamaTitleRef; reason: string } | null {
  const trimmed = line.trim()
  for (const item of longestTitleFirst(candidates)) {
    // An em dash, en dash or hyphen — models are not consistent about which
    // one they echo back, whatever the prompt asked for.
    const pattern = `^${escapeForRegex(item.title)}(?:\\s*\\((\\d{4})\\))?(?:\\s+[—–-]\\s+(.*))?$`
    const found = trimmed.match(new RegExp(pattern, 'iu'))
    if (!found) continue
    const sameTitle = candidates.filter(
      (other) => other.title.toLowerCase() === item.title.toLowerCase()
    )
    const year = found[1] ? Number(found[1]) : undefined
    return { match: narrowByYear(sameTitle, year), reason: (found[2] ?? '').trim() }
  }
  return null
}

/**
 * Resolves a recommendation reply back to a real candidate, or null.
 *
 * Tried in order: the first line read as `Title (year) — reason`, then any
 * candidate whose title is mentioned anywhere in the reply (longest title
 * first, so "Dune: Part Two" wins over "Dune" when both are on the list and
 * both appear). Both steps disambiguate same-titled candidates by the year
 * the model gave. Null means the model answered with something that isn't on
 * the list — the caller falls back rather than opening a title nobody asked
 * for.
 */
export function matchRecommendation(
  reply: string,
  candidates: OllamaTitleRef[]
): { match: OllamaTitleRef; reason: string } | null {
  const text = reply.trim()
  if (!text) return null

  const firstLine = text.split('\n').find((line) => line.trim()) ?? ''

  const wellFormed = matchLinePrefix(firstLine, candidates)
  if (wellFormed) return wellFormed

  const mentioned = longestTitleFirst(candidates).filter(
    (item) =>
      item.title.length >= 2 &&
      mentionsTitle(text, item.title) &&
      // An ordinary word needs to be marked as a title before a bare mention
      // of it counts — see AMBIGUOUS_TITLE_WORDS.
      (!isAmbiguousTitle(item.title) || namesTitleExplicitly(text, item.title))
  )
  if (!mentioned.length) return null

  const title = mentioned[0].title
  // The reason comes from the line that actually NAMES the title, not from
  // the first line of the reply: this fallback exists to tolerate chattier,
  // multi-line answers, and in one of those the first line is often a
  // preamble that says nothing about the pick.
  const namingLine = text.split('\n').find((line) => mentionsTitle(line, title)) ?? ''
  // Longest title wins, then the year picks between any remakes sharing it.
  // The year is read from directly against the title rather than from
  // anywhere on the line — a preamble's year is not the pick's year, whether
  // it sits on its own line or in the same sentence.
  const sameTitle = mentioned.filter((item) => item.title === title)
  const reason = namingLine
    .split(/\s+[—–-]\s+/)
    .slice(1)
    .join(' - ')
    .trim()
  return { match: narrowByYear(sameTitle, yearAfterTitle(namingLine, title)), reason }
}
