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

/**
 * Ollama's own default bind address, and the one address this app is
 * allowed to try without being told to.
 *
 * Ollama binds here on every platform unless someone has gone out of their
 * way to move it, so "is a local model available?" is answerable without
 * asking anyone to retype a constant into Settings. It stays a loopback
 * address on purpose: this is the person's own machine, so looking is not
 * reaching anywhere they didn't already put a server. Anything else — a box
 * on the LAN, a reverse proxy — is still theirs to enter by hand.
 */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

/** An address and a model: everything needed to ask something. Either field may be '' where nothing is known. */
export interface OllamaEndpoint {
  baseUrl: string
  model: string
}

/** What the settings file says, which is not always what is in use. */
export interface SavedOllamaConfig extends OllamaEndpoint {
  /** Whether the app may look at the default address on its own. False only
   *  after a deliberate Disconnect — see settingsStore's ollamaAutoDetect. */
  autoDetect: boolean
}

/**
 * The address to talk to, before any question of which model: whatever was
 * saved, or the default if nothing was and looking is still allowed.
 *
 * Every path that needs an address goes through this, the Settings pane's
 * own probe included, so the pane cannot end up reporting on a different
 * server from the one the AI features would use.
 */
export function effectiveOllamaBaseUrl(saved: SavedOllamaConfig): string {
  if (saved.baseUrl) return saved.baseUrl
  return saved.autoDetect ? DEFAULT_OLLAMA_BASE_URL : ''
}

/**
 * The address + model the AI features will actually use: whatever was
 * chosen in Settings, filled in from what was detected wherever it was not.
 *
 * `detected` is whatever the last probe of the effective address found, and
 * lives only in memory (see ollamaService.ts). It fills gaps and never more
 * than that: a saved model is never replaced, and a detected model is only
 * ever paired with the address it was seen on — so a saved LAN address is
 * never handed the model list of the machine this app happens to run on.
 *
 * The `detected` address is checked against the one effective NOW rather
 * than trusted from when the probe started. A probe holds for up to its
 * whole timeout, which is long enough for someone to press Disconnect
 * meanwhile; its answer then lands afterwards and gets recorded, and
 * without this check it would put back a server they had just said to stop
 * using. Deciding it here, at the single point of use, means a stale answer
 * can be stored and still cannot be acted on — the alternative was the same
 * rule repeated at each site that records a probe, one of which compares
 * against an address captured before its own await.
 *
 * Lives in this half rather than beside the sockets because it is pure, and
 * because every subtlety above is a rule worth pinning down in a test.
 */
export function resolveOllamaConfig(
  saved: SavedOllamaConfig,
  detected: OllamaEndpoint | null
): OllamaEndpoint {
  const settled = { baseUrl: saved.baseUrl, model: saved.model }
  if (saved.baseUrl && saved.model) return settled
  if (!detected || !detected.model) return settled
  if (detected.baseUrl !== effectiveOllamaBaseUrl(saved)) return settled
  return { baseUrl: detected.baseUrl, model: saved.model || detected.model }
}

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

/**
 * Which model the Settings dropdown should hold, given what is actually
 * installed on the server that was just probed.
 *
 * The rule is only ever "something on that list, or nothing": a select whose
 * value matches none of its options renders as one model while its state
 * holds another, and Save then fails on a name the server has never heard
 * of. That happens for real — a model configured last week and since removed
 * with `ollama rm` is still what the settings file says.
 *
 * Preference order is keep-what-is-chosen, then what was saved, then the
 * first installed one, so a valid existing selection survives a re-probe and
 * an install that has moved on quietly corrects itself.
 *
 * Lives here rather than in the pane because the two places that probe a
 * server — the background one on open, and the Check button — had already
 * drifted apart on exactly this point once.
 */
export function pickInstalledModel(installed: string[], current: string, saved: string): string {
  if (current && installed.includes(current)) return current
  if (saved && installed.includes(saved)) return saved
  return installed[0] ?? ''
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

/** How many "you might also like" titles the assistant is asked for. Three
 *  fits the panel, and each one costs a catalog lookup to turn into
 *  something openable — see the renderer's resolveSimilarTitles. */
export const MAX_SIMILAR_TITLES = 3

/** The marker the assistant is told to put its similar-titles line behind. Parsed, never inferred — see parseAssistantAnswer. */
const SIMILAR_MARKER = /^\s*similar\s*:/i

/**
 * Everything the assistant is told about the app before it answers.
 *
 * The app searches its own catalog BEFORE the model is asked, and hands the
 * result over here. That order is the point: a question about a title is
 * answered first by the app that has the title — posters, episodes, a play
 * button — and the model's job is what it is actually good for, which is
 * saying something worth reading about what was found and pointing at what
 * else to try. Asked the other way round, this field was just a chat box
 * that happened to live in a media app.
 */
export interface AssistantContext {
  /** What the app's own search turned up for this question, already on
   *  screen above the answer by the time the model is asked. */
  matches: OllamaTitleRef[]
  /** A sample of what the app can offer right now, for a question that
   *  named no title at all ("something for a rainy night"). */
  library: OllamaTitleRef[]
  /** Recently watched titles, newest first — what "would I like this?" is
   *  answered against. */
  watched: OllamaTitleRef[]
}

/**
 * The top-bar assistant's prompt.
 *
 * Three lists, three different jobs, and the prompt has to keep them apart
 * or the answer blurs into a list of everything it was shown:
 *
 *  - `matches` is what the app already found and is already showing. The
 *    model must not re-list it; it is there to be talked ABOUT.
 *  - `watched` is the only ground for a claim about this person's taste.
 *    Saying "you'll like this" with nothing behind it is the kind of
 *    invention the rest of this app went round removing, so the prompt asks
 *    for the past title that justifies it, by name, or for no claim at all.
 *  - `library` is context for a question that named nothing, exactly as
 *    before: preferred when something fits, never a menu it must pick from.
 *
 * The similar-titles line is asked for in a fixed shape because the caller
 * turns each name back into a real catalog item. Anything the app cannot
 * find is simply dropped, so a hallucinated title costs a missing chip
 * rather than a dead link.
 */
export function buildAssistantMessages(
  question: string,
  context: AssistantContext
): OllamaMessage[] {
  const found = titleLines(context.matches)
  const watched = titleLines(context.watched)
  const listing = titleLines(context.library)
  return [
    {
      role: 'system',
      content: [
        'You are R3, the assistant inside a movie, series and anime app.',
        'Answer in at most three sentences, in plain prose — no lists, no markdown, no preamble.',
        found
          ? `The app has already searched its catalog for this and is showing these results above your answer:\n${found}\nWrite about the first of these — what it is, and whether it is worth their time. Do not list the results back; they can already see them.`
          : 'The app searched its catalog and found nothing matching, so answer the question itself.',
        watched
          ? `Recently watched by this person, newest first:\n${watched}\nIf something here genuinely supports whether they would enjoy it, say so and name that title. If nothing does, say nothing about their taste — never guess at it.`
          : 'You know nothing about what this person has watched, so make no claim about their taste.',
        listing
          ? `Also available in this app right now:\n${listing}\nPrefer these when one genuinely fits. If none do, recommend something else and say so.`
          : 'You have no listing of this catalog, so answer from general knowledge.',
        `Finish with one last line, exactly: SIMILAR: followed by up to ${MAX_SIMILAR_TITLES} other titles they might enjoy, separated by commas. Titles only — no years, no reasons, nothing else on that line.`
      ].join('\n')
    },
    { role: 'user', content: question }
  ]
}

/** An assistant answer split into the part meant for reading and the part meant for looking up. */
export interface AssistantAnswer {
  /** The prose, with the machine-readable line taken back out. */
  text: string
  /** Titles the model suggested, in the order it gave them. Names only — the caller decides whether the app actually has any of them. */
  similar: string[]
}

/**
 * Splits `SIMILAR: a, b, c` off the end of an answer.
 *
 * Parsed, not inferred, in the same spirit as matchRecommendation below:
 * only a line that opens with the marker the prompt asked for counts, so a
 * model that writes "similar films include..." mid-paragraph is left as
 * prose rather than having names guessed out of a sentence. A model that
 * ignores the instruction entirely costs an empty row, which is what an
 * empty row is for.
 *
 * The line is removed from the text on the way past. It is an instruction
 * the model was following, not something anyone should have to read.
 */
export function parseAssistantAnswer(raw: string): AssistantAnswer {
  const lines = String(raw ?? '').split('\n')
  const kept: string[] = []
  const similar: string[] = []
  for (const line of lines) {
    if (!SIMILAR_MARKER.test(line)) {
      kept.push(line)
      continue
    }
    // Every marker line contributes, not just the first: a model that
    // writes one title per SIMILAR line is following the instruction
    // clumsily, not refusing it. And the scan never stops early — the
    // prompt asks for this line last, but a model that leads with it must
    // not cost the prose that follows.
    for (const name of line.replace(SIMILAR_MARKER, '').split(/[,;]/)) {
      if (similar.length >= MAX_SIMILAR_TITLES) break
      // Models bullet, quote and date these however they like, whatever
      // the prompt asked for. Stripping the decoration is not inferring a
      // name — the name is the rest of the entry either way.
      let title = name.trim().replace(/^[-*\u2022\s]+/, '')
      // Peeled in a loop rather than a fixed order, because there isn't
      // one: `"Arrival" (2016)` puts the year outside the quotes and
      // `"Arrival (2016)"` puts it inside, and either order applied once
      // leaves the other's punctuation stuck to the title.
      for (let peel = 0; peel < 3; peel++) {
        const before = title
        title = title
          .replace(/^["'\u201c\u2018]\s*/, '')
          .replace(/\s*["'\u201d\u2019]$/, '')
          .replace(/\s*\(\d{4}\)$/, '')
          .trim()
        if (title === before) break
      }
      if (!title || title.length > 120) continue
      if (similar.some((existing) => existing.toLowerCase() === title.toLowerCase())) continue
      similar.push(title)
    }
  }
  return { text: kept.join('\n').trim(), similar }
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
 * How a part number is written: digits, Roman numerals, or the word.
 *
 * Both cases throughout — a model that lower-cases a subtitle it writes
 * inline lower-cases all of it, and having the words take either case while
 * the numerals demanded capitals meant "Rocky IV" was caught and "Rocky iv"
 * sailed through to open the original.
 *
 * The case flexibility is spelled into the classes rather than set with the
 * `i` flag, because these are embedded in a pattern whose title match must
 * stay case-sensitive (see mentionsTitle).
 *
 * Two or more numeral letters, never one: a lone i, v or x is a pronoun, a
 * crossover "x", or a sentence, far more often than a part number.
 */
const PART_NUMBER =
  '(?:\\d{1,3}|[IiVvXx]{2,}|[Oo]ne|[Tt]wo|[Tt]hree|[Ff]our|[Ff]ive|[Ss]ix|[Ss]even|[Ee]ight|[Nn]ine|[Tt]en)'

/** The words that introduce one, when a title spells its sequel out instead of numbering it. */
const PART_MARKER = '(?:[Pp]art|[Cc]hapter|[Ee]pisode|[Vv]olume|[Bb]ook|[Ss]eason)'

/**
 * Refuses an occurrence that runs straight on into a sequel — "Rocky II",
 * "Scream 2", "Dune Part Two" — because that is a different film, and quite
 * possibly one the shortlist never offered.
 *
 * TITLE_EDGE cannot express this: the character after "Rocky" is a space,
 * which is a perfectly good title boundary everywhere else. So this rides
 * alongside it as a lookahead rather than joining it.
 *
 * Three deliberate limits, each one protecting a case that is already right.
 * Four-digit numbers are left alone, because "Dune 2021" is a model writing
 * the year without brackets, not naming a 2021st sequel. A lone I, V or X is
 * left alone, being far more often a pronoun than a part number; only II and
 * longer count. And the marker word must be followed by an actual number, so
 * "Dune is part of a series" is untouched — "part" there is a preposition,
 * not a sequel.
 *
 * This rejects the OCCURRENCE, not the title, so "Rocky II is fine but Rocky
 * is better" still resolves to Rocky on its second mention.
 *
 * It does NOT cover a sequel named rather than numbered — "Dune Messiah",
 * "Alien Resurrection". Nothing in the text marks those as continuations
 * rather than the title itself, so they are left to the shortlist check:
 * a named sequel that IS on offer wins on longest-title-first, and one that
 * is not resolves to its original. Closing that properly means not parsing
 * prose at all.
 */
const NOT_A_SEQUEL = `(?!\\s+(?:${PART_MARKER}\\s+)?${PART_NUMBER}(?![\\p{L}\\p{N}]))`

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
  return new RegExp(titleOccurrence(title), 'u').test(reply)
}

/**
 * Regex source matching one occurrence of `title` that actually counts as
 * naming it: right boundaries, not swallowed by a sequel.
 *
 * Every question asked about where a title appears goes through this, so
 * they cannot disagree about which occurrence they mean. They have drifted
 * apart twice already — once over whether a year had to sit against the
 * title, once over whether the reason came from the same mention that
 * matched — and both times the symptom was one function answering about a
 * different occurrence from the one that qualified.
 */
function titleOccurrence(title: string): string {
  return `(?<!${TITLE_EDGE})${escapeForRegex(title)}(?!${TITLE_EDGE})${NOT_A_SEQUEL}`
}

/** Start and end offsets of one occurrence of a title within a line. */
type TitleSpan = [number, number]

/** Every qualifying occurrence of `title` in `line`, not just the first. */
function titleSpansIn(line: string, title: string): TitleSpan[] {
  const spans: TitleSpan[] = []
  for (const found of line.matchAll(new RegExp(titleOccurrence(title), 'gu'))) {
    if (found.index !== undefined) spans.push([found.index, found.index + found[0].length])
  }
  return spans
}

/**
 * The model's stated reason, read from after the title it named rather than
 * from wherever the line happens to hold a dash.
 *
 * Splitting the whole line breaks on any title that contains a spaced dash:
 * "I recommend Batman - The Movie — because it is fun" split at the FIRST
 * dash, so the reason came back as "The Movie - because it is fun" and the
 * toast read "Batman - The Movie — The Movie - because it is fun".
 * Advancing past the match first means a title cannot contribute to its own
 * reason.
 *
 * Only the separator the prompt asked for counts. Picking a reason out after
 * a comma or a "because" would mean inferring where it starts, and
 * everything in this file that inferred rather than parsed has come back as
 * a defect.
 */
function reasonAtSpans(line: string, spans: TitleSpan[]): string {
  // Every given occurrence is tried, not just the first: "Between Dune and
  // Arrival, go with Arrival — quieter." names Arrival twice and only the
  // second one carries the reason.
  //
  // Taking spans rather than a title is what keeps a swallowed occurrence
  // out of this. In "I considered Batman - The Movie, but pick Batman —
  // classic." the first "Batman" is part of the longer title, and reading
  // from it returns "The Movie, but pick Batman — classic." as the reason.
  //
  // The tail steps over a closing quote and a year if either is there, since
  // `"It" (2017) — the scary one` has both between the title and its reason.
  const tail = new RegExp(`^${QUOTES}?\\s*(?:\\(\\d{4}\\))?\\s*[—–-]\\s+(.*)$`, 'u')
  for (const [, end] of spans) {
    const after = line.slice(end).match(tail)
    if (after) return after[1].trim()
  }
  return ''
}

/** The year bracketed against one of `spans`, or undefined. */
function yearAtSpans(line: string, spans: TitleSpan[]): number | undefined {
  // A closing quote may sit between the two — the model wrote "It" (2017),
  // and that year is still this title's.
  const bracket = new RegExp(`^${QUOTES}?\\s*\\((\\d{4})\\)`, 'u')
  for (const [, end] of spans) {
    const found = line.slice(end).match(bracket)
    if (found) return Number(found[1])
  }
  return undefined
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
/** Whether the reply writes a year against this title anywhere. Only used to judge whether an everyday word was written AS a title, which is a question about the whole reply. */
function yearAfterTitle(text: string, title: string): number | undefined {
  return yearAtSpans(text, titleSpansIn(text, title))
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
 * The line on which `reply` actually names `title`, or null if it never
 * does.
 *
 * This is the single place that decides which mention counts, and everything
 * downstream — the year against the title, the reason after it — reads from
 * the line it returns. Explicitness is judged per line rather than across
 * the whole reply for exactly that reason: evidence has to sit with the
 * mention it justifies, or a quote on line two ends up admitting a bare
 * pronoun on line one.
 */
function namingLine(reply: string, title: string): string | null {
  const needsProof = isAmbiguousTitle(title)
  for (const line of reply.split('\n')) {
    if (!mentionsTitle(line, title)) continue
    if (needsProof && !namesTitleExplicitly(line, title)) continue
    return line
  }
  return null
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

  // Each candidate paired with the line that names it, so the year and the
  // reason are read from the SAME mention that qualified it rather than from
  // the first one that merely contains the words. For an ambiguous title
  // those can be different lines: "It depends on your mood." names nothing,
  // while `I recommend "It" (2017) — the scary one.` names it twice over.
  // Checking explicitness across the whole reply but extracting from the
  // first mention picked the 1927 film and lost the reason.
  const mentioned = longestTitleFirst(candidates)
    .filter((item) => item.title.length >= 2)
    .map((item) => ({ item, line: namingLine(text, item.title) }))
    .filter((found): found is { item: OllamaTitleRef; line: string } => found.line !== null)
  if (!mentioned.length) return null

  // Candidates sharing a title are one mention with several works behind it —
  // remakes, separated by year further down, never by which is longer.
  const byTitle = new Map<string, { items: OllamaTitleRef[]; line: string }>()
  for (const { item, line } of mentioned) {
    const group = byTitle.get(item.title)
    if (group) group.items.push(item)
    else byTitle.set(item.title, { items: [item], line })
  }

  // Longest-first settles titles that overlap AT ONE MENTION — "Batman - The
  // Movie" owns the "Batman" inside it. It settles nothing between titles
  // named in different places, and using it there opened whichever name
  // happened to be longer: "I considered Interstellar, but I'd pick Arrival"
  // opened Interstellar, the one the model had just rejected.
  //
  // Ownership is per OCCURRENCE, not per title. A prefix title can be
  // swallowed in one place and named in its own right in another: "I
  // considered Batman - The Movie, but pick Batman — classic." names both,
  // and dropping Batman because its first mention sat inside the longer
  // title opened the very film that sentence was rejecting.
  const named: Array<{ title: string; items: OllamaTitleRef[]; line: string; spans: TitleSpan[] }> =
    []
  for (const [title, group] of byTitle) {
    const owned = titleSpansIn(group.line, title).filter(
      ([start]) =>
        !named.some(
          (longer) =>
            longer.line === group.line &&
            longer.spans.some(([from, to]) => start >= from && start < to)
        )
    )
    if (owned.length) named.push({ title, ...group, spans: owned })
  }
  if (!named.length) return null

  // More than one title genuinely named. Which one was chosen is a question
  // about the sentence, and this is a regex — so the only thing it may go on
  // is the format the prompt asked for: the pick is the one the model
  // attached its reason to. Anything less clear falls back to a random pick,
  // which at least says out loud that nothing chose it.
  const withReason = named.filter((entry) => reasonAtSpans(entry.line, entry.spans) !== '')
  const pick = named.length === 1 ? named[0] : withReason.length === 1 ? withReason[0] : null
  if (!pick) return null

  // The year picks between any remakes sharing the chosen title, read from
  // directly against it rather than from anywhere on the line — a preamble's
  // year is not the pick's year.
  return {
    match: narrowByYear(pick.items, yearAtSpans(pick.line, pick.spans)),
    reason: reasonAtSpans(pick.line, pick.spans)
  }
}
