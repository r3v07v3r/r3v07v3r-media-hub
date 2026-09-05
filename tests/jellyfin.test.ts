import assert from 'node:assert/strict'
import http from 'node:http'
import {
  buildStreamUrl,
  findEpisode,
  isJellyfinConfigured,
  jellyfinCandidate,
  jellyfinFingerprint,
  findMovie,
  normalizeBaseUrl,
  parseMediaId,
  resolutionTierForStream,
  type JellyfinItem
} from '../src/main/media-hub/jellyfin'

// --- base URL handling -----------------------------------------------------
assert.equal(normalizeBaseUrl('http://box:8096/'), 'http://box:8096', 'trailing slash removed')
assert.equal(normalizeBaseUrl('  http://box:8096//  '), 'http://box:8096', 'trimmed and squashed')

assert.equal(isJellyfinConfigured({ baseUrl: 'http://box:8096', apiKey: 'k' }), true)
assert.equal(isJellyfinConfigured({ baseUrl: '', apiKey: 'k' }), false, 'needs a URL')
assert.equal(isJellyfinConfigured({ baseUrl: 'http://box:8096', apiKey: '' }), false, 'needs a key')
assert.equal(isJellyfinConfigured(undefined), false)

// The fingerprint goes into on-disk cache keys, so it must never leak the key.
const fingerprint = jellyfinFingerprint({ baseUrl: 'http://box:8096/', apiKey: 'SECRET-KEY' })
assert.equal(fingerprint, 'http://box:8096', 'fingerprint is the normalized base URL')
assert.ok(!fingerprint.includes('SECRET-KEY'), 'the API key never reaches a cache key')
assert.equal(jellyfinFingerprint(undefined), 'off', 'an unconfigured server has a stable key')

// --- media id parsing ------------------------------------------------------
assert.deepEqual(parseMediaId('tt1234567'), {
  imdbId: 'tt1234567',
  season: undefined,
  episode: undefined
})
assert.deepEqual(parseMediaId('tt1234567:2:5'), { imdbId: 'tt1234567', season: 2, episode: 5 })

// --- dimensions to the app's resolution tiers ------------------------------
assert.equal(resolutionTierForStream(3840, 2160), 2160)
assert.equal(resolutionTierForStream(1920, 1080), 1080)
assert.equal(resolutionTierForStream(1280, 720), 720)
assert.equal(resolutionTierForStream(undefined, undefined), 0, 'unknown is not a claim')

// Scope-ratio films are letterboxed in the container: a 2.39:1 "1080p"
// release is 1920x800. Judged by height that reads as 720p, which would
// both under-score it and let it slip through a 720p ceiling.
assert.equal(resolutionTierForStream(1920, 800), 1080, 'a 1920x800 scope film is 1080p')
assert.equal(resolutionTierForStream(3840, 1600), 2160, 'a 3840x1600 scope film is 2160p')

// Height is the fallback when a stream reports no width.
assert.equal(resolutionTierForStream(undefined, 1080), 1080, 'falls back to height')
assert.equal(resolutionTierForStream(undefined, 2160), 2160)

// --- item to candidate -----------------------------------------------------
const movie: JellyfinItem = {
  Id: 'item-1',
  Name: 'Interstellar',
  ProductionYear: 2014,
  MediaSources: [
    {
      Id: 'source-1',
      Path: '/media/Movies/Interstellar (2014)/Interstellar.2014.2160p.HDR.x265.mkv',
      Size: 42 * 1024 ** 3,
      MediaStreams: [
        { Type: 'Video', Height: 2160, Width: 3840, Codec: 'hevc' },
        { Type: 'Audio', Language: 'eng', Codec: 'truehd' },
        { Type: 'Audio', Language: 'fre', Codec: 'ac3' },
        { Type: 'Subtitle', Language: 'eng' }
      ]
    }
  ]
}

const candidate = jellyfinCandidate(movie)
assert.ok(candidate, 'a movie with a media source produces a candidate')
assert.equal(candidate.source, 'mediaserver')
assert.equal(candidate.itemId, 'item-1')
assert.equal(candidate.mediaSourceId, 'source-1')
assert.equal(candidate.resolution, 2160, 'resolution comes from the real pixel height')
assert.equal(candidate.cached, true, 'a file on the server is available now, by construction')
assert.equal(candidate.compatible, true)
assert.equal(candidate.exact, true)
assert.equal(
  candidate.name,
  'Interstellar.2014.2160p.HDR.x265.mkv',
  'the filename is carried so existing release-text scoring still applies'
)
assert.deepEqual(candidate.audioLanguages, ['eng', 'fre'], 'real audio languages, not guessed')
assert.equal(candidate.infoHash, undefined, 'a media-server candidate has no torrent behind it')

// A locked-down server may not expose Path; the library title stands in.
const noPath = jellyfinCandidate({
  Id: 'item-2',
  Name: 'Arrival',
  MediaSources: [{ Id: 'source-2', MediaStreams: [{ Type: 'Video', Height: 1080 }] }]
})
assert.equal(noPath?.name, 'Arrival', 'falls back to the item name when Path is withheld')
assert.equal(noPath?.resolution, 1080)

// Episodes carry the series name so the title guard has something to match.
const episode = jellyfinCandidate({
  Id: 'item-3',
  Name: 'The Bicameral Mind',
  SeriesName: 'Westworld',
  IndexNumber: 10,
  ParentIndexNumber: 1,
  MediaSources: [{ Id: 'source-3', Path: '/tv/Westworld/S01E10.mkv' }]
})
assert.equal(episode?.title, 'Westworld The Bicameral Mind')

// Items with nothing playable must not become candidates.
assert.equal(jellyfinCandidate({ Id: 'item-4', Name: 'No sources' }), null, 'no MediaSources')
assert.equal(jellyfinCandidate({ Name: 'No id', MediaSources: [{ Id: 'x' }] }), null, 'no item id')
assert.equal(jellyfinCandidate({ Id: 'item-5', MediaSources: [{}] }), null, 'no media source id')

// --- stream URL ------------------------------------------------------------
const url = new URL(
  buildStreamUrl({ baseUrl: 'http://192.168.1.50:8096/', apiKey: 'abc123' }, 'item-1', 'source-1')
)
assert.equal(url.origin, 'http://192.168.1.50:8096', 'the normalized base URL is used')
assert.equal(url.pathname, '/Videos/item-1/stream')
assert.equal(
  url.searchParams.get('static'),
  'true',
  'static=true is required — it serves the original file instead of transcoding'
)
assert.equal(url.searchParams.get('mediaSourceId'), 'source-1')
assert.equal(
  url.searchParams.get('api_key'),
  'abc123',
  'the key travels in the query because mpv cannot send a header'
)

// --- regression: a server that ignores AnyProviderIdEquals ----------------
//
// Caught against a live Jellyfin 10.11. When the provider filter is
// malformed or unsupported it does NOT error and does NOT return an empty
// list -- it ignores the filter and returns the whole library. The first
// version of findMovie took Items[0] on trust, so a search for one film
// returned a completely different one and would have played it. Nothing
// downstream can tell that apart from a correct match, which is what makes
// it worth a server stub rather than a note.

async function providerFilterChecks(): Promise<void> {
  const library = {
    Items: [
      {
        Id: 'wrong-1',
        Name: 'Big Buck Bunny',
        ProviderIds: { Imdb: 'tt1254207' },
        MediaSources: [{ Id: 'ms-wrong', Path: '/m/bbb.mkv' }]
      },
      {
        Id: 'right-1',
        Name: 'Sintel',
        ProviderIds: { Imdb: 'tt1727587' },
        MediaSources: [{ Id: 'ms-right', Path: '/m/sintel.mkv' }]
      }
    ]
  }

  // Answers every query with the entire library, whatever was asked for.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(library))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const config = { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' }

  try {
    const sintel = await findMovie(config, 'tt1727587', 'Sintel')
    assert.equal(
      sintel?.Id,
      'right-1',
      'the item actually carrying the requested id is the one returned'
    )

    const missing = await findMovie(config, 'tt9999999', 'Nothing Here')
    assert.equal(
      missing,
      null,
      'an id no item carries returns nothing — never whichever item sorted first'
    )

    // The name-search fallback must not rescue a wrong id either: the
    // title guard has to reject Big Buck Bunny for a Sintel request.
    const wrongTitle = await findMovie(config, '', 'Sintel')
    assert.equal(wrongTitle?.Id, 'right-1', 'the name fallback still matches on title')

    const seriesMissing = await findEpisode(config, 'tt9999999', 'Nothing Here', 1, 1)
    assert.equal(seriesMissing, null, 'the same guard applies to the series lookup')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void providerFilterChecks().then(() => {
  console.log('ok  jellyfin client')
})

// --- a series filed under its romaji ---------------------------------------
//
// An anime is listed in this app under its English title with the romaji
// as an alternate. A library that names the series in romaji answers a
// search for the English name with NOTHING — no rows for the title guard
// to accept — and anime has no IMDb id to fall back on. Every supplied
// name is searched, so the second one finds it. This stub, unlike the one
// above, honours SearchTerm, which is the whole point.

async function alternateTitleChecks(): Promise<void> {
  const series = {
    Id: 'series-jp',
    Name: 'Shingeki no Kyojin',
    ProviderIds: {},
    MediaSources: [{ Id: 'ms-s', Path: '/tv/snk/folder.jpg' }]
  }
  const episodes = {
    Items: [
      {
        Id: 'ep-1',
        Name: 'To You, in 2000 Years',
        SeriesName: 'Shingeki no Kyojin',
        IndexNumber: 1,
        ParentIndexNumber: 1,
        MediaSources: [{ Id: 'ms-ep', Path: '/tv/snk/[SubsPlease] Shingeki no Kyojin - 01.mkv' }]
      }
    ]
  }
  const searched: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.pathname.startsWith('/Shows/')) {
      res.end(JSON.stringify(episodes))
      return
    }
    const term = url.searchParams.get('SearchTerm') ?? ''
    if (term) searched.push(term)
    const hit = series.Name.toLowerCase().includes(term.toLowerCase())
    res.end(JSON.stringify({ Items: term && hit ? [series] : [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const config = { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' }

  try {
    const found = await findEpisode(config, '', ['Attack on Titan', 'Shingeki no Kyojin'], 1, 1)
    assert.equal(found?.Id, 'ep-1', 'the romaji name finds a series the English name cannot')
    assert.deepEqual(
      searched,
      ['Attack on Titan', 'Shingeki no Kyojin'],
      'the English name is searched first, the romaji second'
    )

    const none = await findEpisode(config, '', ['Attack on Titan'], 1, 1)
    assert.equal(none, null, 'with only the English name the library stays out of reach')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void alternateTitleChecks().then(() => {
  console.log('ok  jellyfin alternate titles')
})
