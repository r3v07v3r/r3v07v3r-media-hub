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
        'Reply with exactly one line: the title exactly as written in the list, then " — ", then one short sentence on why.',
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
 * Whether `reply` mentions `title` as a phrase in its own right, rather than
 * as a run of characters inside a longer word.
 *
 * Two guards, because real titles include Up, It and Us:
 *
 *  - Word boundaries, so "an uplifting choice" does not count as picking Up.
 *  - Case sensitivity, so "it depends" does not count as picking It. This is
 *    the one place matching is case-sensitive, and deliberately so: the
 *    exact-title paths in matchRecommendation are confident about what they
 *    are looking at and stay forgiving, while this last-resort scan over
 *    free prose is guessing. A model naming a title is copying it from the
 *    list it was given, capitals and all; the same word in lower case is
 *    almost always just the sentence around it.
 *
 * The cost is a reply that lower-cases a title it genuinely meant, which
 * falls back to the random pick. That is a far better failure than opening a
 * film nobody asked for.
 */
function mentionsTitle(reply: string, title: string): boolean {
  const pattern = `(?<![\\p{L}\\p{N}])${escapeForRegex(title)}(?![\\p{L}\\p{N}])`
  return new RegExp(pattern, 'u').test(reply)
}

/**
 * Resolves a recommendation reply back to a real candidate, or null.
 *
 * Tried in order: the whole reply as a title, the part before the dash, and
 * finally any candidate whose title is mentioned in the reply (longest title
 * first, so "Dune: Part Two" wins over "Dune" when both are on the list and
 * both appear). Null means the model answered with something that isn't on
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
  // An em dash, en dash or hyphen — models are not consistent about which
  // one they echo back, whatever the prompt asked for.
  const [titlePart, ...reasonParts] = firstLine.split(/\s+[—–-]\s+/)
  const reason = reasonParts.join(' - ').trim()

  const byExact = (needle: string) =>
    candidates.find((item) => item.title.toLowerCase() === needle.trim().toLowerCase())

  const exact = byExact(titlePart ?? '') ?? byExact(firstLine)
  if (exact) return { match: exact, reason }

  const contained = [...candidates]
    .sort((a, b) => b.title.length - a.title.length)
    .find((item) => item.title.length >= 2 && mentionsTitle(text, item.title))

  return contained ? { match: contained, reason } : null
}
