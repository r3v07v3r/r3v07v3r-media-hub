const test = require('node:test');
const assert = require('node:assert/strict');
const { filterCatalog, createRoomCode, rankStreams, validateTorBoxToken } = require('../src/core.cjs');

const catalog = [
  { title: 'Dune: Part Two', type: 'movie', year: 2024 },
  { title: 'Frieren', type: 'anime', year: 2023 },
  { title: 'Shōgun', type: 'series', year: 2024 }
];

test('catalog filtering combines section and search query', () => {
  assert.deepEqual(filterCatalog(catalog, 'anime', 'frie').map(x => x.title), ['Frieren']);
});

test('room codes are human-readable and avoid ambiguous characters', () => {
  const code = createRoomCode(() => 0.1);
  assert.match(code, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.equal(/[01IO]/.test(code), false);
});

test('stream ranking prefers exact cached compatible releases over raw resolution', () => {
  const streams = [
    { name: '4K mismatch', exact: false, cached: true, compatible: true, resolution: 2160 },
    { name: '1080p exact', exact: true, cached: true, compatible: true, resolution: 1080 }
  ];
  assert.equal(rankStreams(streams)[0].name, '1080p exact');
});

test('TorBox token validation rejects empty and implausibly short tokens', () => {
  assert.equal(validateTorBoxToken(''), false);
  assert.equal(validateTorBoxToken('short'), false);
  assert.equal(validateTorBoxToken('tbx_example_token_value_1234567890'), true);
});
