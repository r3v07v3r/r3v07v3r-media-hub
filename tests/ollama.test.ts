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
