const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function filterCatalog(items, section = 'home', query = '') {
  const q = query.trim().toLowerCase();
  return items.filter(item => (section === 'home' || item.type === section) && (!q || `${item.title} ${item.year}`.toLowerCase().includes(q)));
}

function createRoomCode(random = Math.random) {
  let value = '';
  for (let i = 0; i < 6; i++) value += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length];
  return `${value.slice(0, 3)}-${value.slice(3)}`;
}

function rankStreams(streams) {
  const score = stream => (stream.exact ? 100000 : 0) + (stream.cached ? 20000 : 0) + (stream.compatible ? 10000 : -50000) + (stream.resolution || 0);
  return [...streams].sort((a, b) => score(b) - score(a));
}

function validateTorBoxToken(token) {
  return typeof token === 'string' && token.trim().length >= 24 && !/\s/.test(token.trim());
}

module.exports = { filterCatalog, createRoomCode, rankStreams, validateTorBoxToken };
