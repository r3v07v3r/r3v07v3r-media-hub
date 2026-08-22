// Unit tests for the local-AI helpers (src/shared/media-hub/ollama.ts).
// Run with: npx tsx tests/ollama.test.ts   (or npm.cmd test)
//
// That module is deliberately electron-free and network-free so it can be
// imported directly here; the sockets and IPC live in
// src/main/media-hub/ollamaService.ts and are not exercised by this file.

import assert from 'node:assert'
import {
  DEFAULT_OLLAMA_BASE_URL,
  MAX_PROMPT_TITLES,
  buildAssistantMessages,
  buildRecommendationMessages,
  matchRecommendation,
  normalizeOllamaBaseUrl,
  normalizeOllamaModel,
  parseOllamaModels,
  parseOllamaReply,
  type OllamaTitleRef
} from '../src/shared/media-hub/ollama'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

// --- normalizeOllamaBaseUrl ------------------------------------------------

check('fills in a missing scheme, since host:port is what people type', () => {
  assert.equal(normalizeOllamaBaseUrl('localhost:11434'), 'http://localhost:11434')
  assert.equal(normalizeOllamaBaseUrl('192.168.1.5:11434'), 'http://192.168.1.5:11434')
})

check('keeps an explicit scheme and strips trailing slashes', () => {
  assert.equal(normalizeOllamaBaseUrl('https://ai.example.com/'), 'https://ai.example.com')
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434///'), 'http://127.0.0.1:11434')
})

check('keeps a path prefix, for an instance behind a reverse proxy', () => {
  assert.equal(
    normalizeOllamaBaseUrl('https://home.example/ollama/'),
    'https://home.example/ollama'
  )
})

check('drops the query and fragment', () => {
  assert.equal(normalizeOllamaBaseUrl('http://localhost:11434/?x=1#y'), 'http://localhost:11434')
})

check('refuses anything that is not http(s)', () => {
  assert.equal(normalizeOllamaBaseUrl('file:///etc/passwd'), '')
  assert.equal(normalizeOllamaBaseUrl('ftp://example.com'), '')
  // The main process fetches this string; a javascript: URL must never survive.
  assert.equal(normalizeOllamaBaseUrl('javascript:alert(1)'), '')
})

check('refuses an address carrying credentials rather than storing them', () => {
  assert.equal(normalizeOllamaBaseUrl('http://user:pass@localhost:11434'), '')
})

check('treats empty and junk input as "nothing configured"', () => {
  assert.equal(normalizeOllamaBaseUrl(''), '')
  assert.equal(normalizeOllamaBaseUrl('   '), '')
  assert.equal(normalizeOllamaBaseUrl(undefined), '')
  assert.equal(normalizeOllamaBaseUrl('http://'), '')
})

check('the offered default normalizes to itself', () => {
  assert.equal(normalizeOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL), DEFAULT_OLLAMA_BASE_URL)
})

// --- normalizeOllamaModel --------------------------------------------------

check('accepts the tag shapes Ollama actually uses', () => {
  assert.equal(normalizeOllamaModel('llama3.2'), 'llama3.2')
  assert.equal(normalizeOllamaModel('  qwen2.5:7b  '), 'qwen2.5:7b')
  assert.equal(normalizeOllamaModel('hf.co/user/repo:Q4_K_M'), 'hf.co/user/repo:Q4_K_M')
})

check('rejects a tag with anything that could break out of the request body', () => {
  assert.equal(normalizeOllamaModel('llama3.2"; drop'), '')
  assert.equal(normalizeOllamaModel('model name'), '')
  assert.equal(normalizeOllamaModel('-leading-dash'), '')
  assert.equal(normalizeOllamaModel(''), '')
  assert.equal(normalizeOllamaModel(null), '')
})

// --- parseOllamaModels -----------------------------------------------------

check('reads model names out of a /api/tags body, sorted and de-duplicated', () => {
  const models = parseOllamaModels({
    models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:3b' }, { model: 'llama3.2:3b' }]
  })
  assert.deepEqual(models, ['llama3.2:3b', 'qwen2.5:7b'])
})

check('tolerates any shape a server might return', () => {
  assert.deepEqual(parseOllamaModels(null), [])
  assert.deepEqual(parseOllamaModels({}), [])
  assert.deepEqual(parseOllamaModels({ models: 'nope' }), [])
  // Entries that aren't valid tags are dropped, not passed through.
  assert.deepEqual(parseOllamaModels({ models: [{ name: 'bad name' }, { name: 'ok:1' }] }), [
    'ok:1'
  ])
})

// --- parseOllamaReply ------------------------------------------------------

check('reads /api/chat and /api/generate shapes alike', () => {
  assert.equal(parseOllamaReply({ message: { content: '  Watch Arrival.  ' } }), 'Watch Arrival.')
  assert.equal(parseOllamaReply({ response: 'Watch Arrival.' }), 'Watch Arrival.')
})

check('drops a reasoning model thinking aloud', () => {
  assert.equal(
    parseOllamaReply({ message: { content: '<think>hmm, sci-fi?</think>\nWatch Arrival.' } }),
    'Watch Arrival.'
  )
})

check('treats an answer cut off mid-thought as no answer at all', () => {
  assert.equal(parseOllamaReply({ message: { content: '<think>still going' } }), '')
})

check('returns empty for an empty or missing body', () => {
  assert.equal(parseOllamaReply({}), '')
  assert.equal(parseOllamaReply({ message: { content: '   ' } }), '')
  assert.equal(parseOllamaReply(undefined), '')
})

// --- prompts ---------------------------------------------------------------

const LIBRARY: OllamaTitleRef[] = [
  { id: 'a', title: 'Arrival', year: 2016, genres: ['Sci-Fi', 'Drama'] },
  { id: 'b', title: 'Dune', year: 2021, genres: ['Sci-Fi'] },
  { id: 'c', title: 'Dune: Part Two', year: 2024, genres: ['Sci-Fi'] }
]

check('the assistant prompt carries the question and the library listing', () => {
  const messages = buildAssistantMessages('something for a rainy night?', LIBRARY)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, 'system')
  assert.ok(messages[0].content.includes('Arrival (2016)'))
  assert.equal(messages[1].content, 'something for a rainy night?')
})

check('the assistant prompt still works with no library to offer', () => {
  const messages = buildAssistantMessages('what should I watch?', [])
  assert.ok(messages[0].content.includes('general knowledge'))
})

check('a prompt never lists more titles than the cap', () => {
  const many: OllamaTitleRef[] = Array.from({ length: MAX_PROMPT_TITLES + 25 }, (_, i) => ({
    id: `id${i}`,
    title: `Title ${i}`
  }))
  const listing = buildRecommendationMessages('movie', many)[1].content
  assert.equal(
    listing.split('\n').filter((line) => line.startsWith('- ')).length,
    MAX_PROMPT_TITLES
  )
})

// --- matchRecommendation ---------------------------------------------------

check('matches the exact title the model was asked to echo back', () => {
  const picked = matchRecommendation('Arrival — quiet, and it earns its ending.', LIBRARY)
  assert.equal(picked?.match.id, 'a')
  assert.equal(picked?.reason, 'quiet, and it earns its ending.')
})

check('accepts the dash characters models substitute for the one asked for', () => {
  assert.equal(matchRecommendation('Dune - big sand', LIBRARY)?.match.id, 'b')
  assert.equal(matchRecommendation('Dune – big sand', LIBRARY)?.match.id, 'b')
})

check('prefers the longest matching title when one contains another', () => {
  // "Dune" is a substring of "Dune: Part Two" — picking the shorter one here
  // would open the wrong film every time the model recommends the sequel.
  const picked = matchRecommendation('I would go with Dune: Part Two this time.', LIBRARY)
  assert.equal(picked?.match.id, 'c')
})

check('finds the title inside a chattier answer than the prompt asked for', () => {
  assert.equal(matchRecommendation('Sure! How about Arrival?', LIBRARY)?.match.id, 'a')
})

// Up, It and Us are all real films, and all three are ordinary English
// words — the case the loose containment scan has to survive.
const SHORT_TITLES: OllamaTitleRef[] = [
  { id: 'up', title: 'Up' },
  { id: 'it', title: 'It' },
  { id: 'us', title: 'Us' }
]

check('does not mistake a short title for letters inside a longer word', () => {
  // A plain substring check reads "an uplifting choice" as picking Up and
  // opens the wrong title instead of falling back.
  assert.equal(matchRecommendation('Interstellar — an uplifting choice', SHORT_TITLES), null)
  assert.equal(matchRecommendation('Try something upbeat', SHORT_TITLES), null)
})

check('does not mistake a short title for the same word in ordinary prose', () => {
  // Word boundaries alone do not save this one: "it" in "it depends" IS a
  // whole word. Only the capitalization tells the film from the pronoun.
  assert.equal(matchRecommendation('Whatever suits you, it depends', SHORT_TITLES), null)
  assert.equal(matchRecommendation('None of us would enjoy that', SHORT_TITLES), null)
})

check('still matches a short title when it is genuinely the answer', () => {
  assert.equal(matchRecommendation('Up — it still gets me', SHORT_TITLES)?.match.id, 'up')
  assert.equal(matchRecommendation('I would say "Us" tonight.', SHORT_TITLES)?.match.id, 'us')
  assert.equal(matchRecommendation('It', SHORT_TITLES)?.match.id, 'it')
})

check('the exact-title paths stay case-insensitive', () => {
  // Only the loose prose scan is case-sensitive. A well-formed reply that
  // happens to lower-case the title still resolves.
  assert.equal(matchRecommendation('dune — sandy', LIBRARY)?.match.id, 'b')
})

check('matches a title whose punctuation is regex-significant', () => {
  const punctuated: OllamaTitleRef[] = [{ id: 'q', title: 'Who Framed Roger Rabbit?' }]
  assert.equal(
    matchRecommendation('Who Framed Roger Rabbit? — still holds up', punctuated)?.match.id,
    'q'
  )
})

// A remake and its original, sharing a title and separated only by year —
// the shortlist shows both, so the reply has to be able to tell them apart.
const REMAKES: OllamaTitleRef[] = [
  { id: 'dune-1984', title: 'Dune', year: 1984 },
  { id: 'dune-2021', title: 'Dune', year: 2021 },
  { id: 'arrival', title: 'Arrival', year: 2016 }
]

check('tells two same-titled works apart by the year the model gave', () => {
  assert.equal(matchRecommendation('Dune (1984) — the strange one', REMAKES)?.match.id, 'dune-1984')
  assert.equal(matchRecommendation('Dune (2021) — the pretty one', REMAKES)?.match.id, 'dune-2021')
})

check('uses the year in the loose prose scan too', () => {
  assert.equal(
    matchRecommendation('Honestly? I would go with Dune (1984) tonight.', REMAKES)?.match.id,
    'dune-1984'
  )
})

check('ignores a year that matches nothing rather than giving up', () => {
  // The model misremembered the year, but it still named a title on the
  // list — falling back to the random pick would be worse than opening the
  // first work by that name.
  const picked = matchRecommendation('Arrival (1999) — still good', REMAKES)
  assert.equal(picked?.match.id, 'arrival')
})

check('the year is read off the line naming the title, not the whole reply', () => {
  // A year in a later sentence must not redirect the pick.
  const picked = matchRecommendation(
    'Dune (2021) — worth it\nThe 1984 version is quite different.',
    REMAKES
  )
  assert.equal(picked?.match.id, 'dune-2021')
})

check('the year is optional, and a bare title still resolves', () => {
  // Nothing distinguishes them, so the first is as good an answer as any —
  // the ambiguity is the model's, and the title it named is still opened.
  assert.ok(matchRecommendation('Dune — sandy', REMAKES)?.match.title === 'Dune')
  assert.equal(matchRecommendation('Arrival — quiet', REMAKES)?.match.id, 'arrival')
})

// A title containing a spaced dash, alongside the shorter title it starts
// with — both on the same shortlist, which is what makes it dangerous.
const DASHED: OllamaTitleRef[] = [
  { id: 'batman', title: 'Batman' },
  { id: 'batman-movie', title: 'Batman - The Movie' },
  { id: 'spider', title: 'Spider' }
]

check('does not mistake part of a title for the reason separator', () => {
  // Splitting on the first spaced dash yields "Batman", which is a real and
  // different film on this same list — the button would open it, with the
  // rest of the intended title as its reason.
  const picked = matchRecommendation('Batman - The Movie — because it is daft', DASHED)
  assert.equal(picked?.match.id, 'batman-movie')
  assert.equal(picked?.reason, 'because it is daft')
})

check('still resolves the shorter title when that is what was named', () => {
  const picked = matchRecommendation('Batman — the dark one', DASHED)
  assert.equal(picked?.match.id, 'batman')
  assert.equal(picked?.reason, 'the dark one')
})

check('a dash inside a word is not a separator', () => {
  // "Spider-Man" is not on the list. Reading the hyphen as a separator would
  // resolve it to Spider with a reason of "Man".
  assert.equal(matchRecommendation('Spider-Man', DASHED), null)
})

check('reads the year off the title-bearing line, not a preamble', () => {
  // The chattier answers this fallback exists for often open with a line
  // that carries a year belonging to nothing. Reading it would open the
  // 2021 film the model just declined to pick.
  const picked = matchRecommendation(
    'Considering releases from (2021):\nDune (1984) is my pick.',
    REMAKES
  )
  assert.equal(picked?.match.id, 'dune-1984')
})

check('reads the year sitting against the title, not one earlier in the line', () => {
  // Both years are on the SAME line here, so picking the title-bearing line
  // is not enough — only the bracket directly against the title is its own.
  const picked = matchRecommendation(
    'Considering releases from (2021), Dune (1984) is my pick.',
    REMAKES
  )
  assert.equal(picked?.match.id, 'dune-1984')
})

check('skips a mention with no year to find the one that has it', () => {
  const picked = matchRecommendation('Dune is great. Actually, Dune (1984) is my pick.', REMAKES)
  assert.equal(picked?.match.id, 'dune-1984')
})

check('is not fooled by a sentence that opens with an ordinary word title', () => {
  // Grammar capitalises "It" at the start of a sentence, so case cannot tell
  // the pronoun from the film. A bare mention of an everyday word proves
  // nothing, and this must fall back rather than open It.
  assert.equal(matchRecommendation('It depends on your mood', SHORT_TITLES), null)
  assert.equal(matchRecommendation('Up to you, really', SHORT_TITLES), null)
  assert.equal(matchRecommendation('Us both, ideally', SHORT_TITLES), null)
})

check('accepts an ordinary word title when the reply marks it as one', () => {
  // Quoted, or carrying its year — either is the model naming a title rather
  // than writing a sentence.
  assert.equal(matchRecommendation('Honestly, "It" is the one.', SHORT_TITLES)?.match.id, 'it')
  const dated: OllamaTitleRef[] = [{ id: 'it2017', title: 'It', year: 2017 }]
  assert.equal(matchRecommendation('I would say It (2017) tonight.', dated)?.match.id, 'it2017')
})

check('a distinctive title still needs no quotes', () => {
  // The stricter rule applies only to everyday words; anything else keeps
  // the plain boundary-and-case check.
  assert.equal(matchRecommendation('Sure! How about Arrival?', LIBRARY)?.match.id, 'a')
})

// The first film only — the sequel is deliberately NOT on offer.
const WITHOUT_SEQUEL: OllamaTitleRef[] = [{ id: 'dune', title: 'Dune', year: 2021 }]

check('does not resolve an unavailable sequel to its own prefix', () => {
  // A colon is how a title continues into its subtitle, so a title ending
  // there has not been named — matching it would open the wrong film AND
  // caption it with the sequel's reason.
  assert.equal(matchRecommendation('Dune: Part Two — the sequel', WITHOUT_SEQUEL), null)
  assert.equal(
    matchRecommendation('I would go with Dune: Part Two this time.', WITHOUT_SEQUEL),
    null
  )
})

check('still resolves a subtitled title that IS on offer', () => {
  const picked = matchRecommendation('Dune: Part Two — the sequel', LIBRARY)
  assert.equal(picked?.match.id, 'c')
  assert.equal(picked?.reason, 'the sequel')
  // And the base title is unaffected by the stricter edge.
  assert.equal(matchRecommendation('Dune — the first one', LIBRARY)?.match.id, 'b')
})

check('a colon does not block a year from being read', () => {
  // The year belongs to whichever title it sits against, subtitled or not.
  assert.equal(matchRecommendation('Dune: Part Two (2024) is my pick.', LIBRARY)?.match.id, 'c')
})

check('reports no match when the model picks something not on the list', () => {
  assert.equal(matchRecommendation('Watch Interstellar.', LIBRARY), null)
  assert.equal(matchRecommendation('   ', LIBRARY), null)
})

check('a title with no reason still matches, with an empty reason', () => {
  const picked = matchRecommendation('Arrival', LIBRARY)
  assert.equal(picked?.match.id, 'a')
  assert.equal(picked?.reason, '')
})

console.log(`\n${pass} passed`)
