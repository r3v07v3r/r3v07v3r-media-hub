// The Sonarr/Radarr add payload.
//
// There is no live Servarr instance to exercise this against, and the failure
// modes are all quiet: a payload that drops the server's own lookup fields
// adds the wrong show, and one carrying the other app's addOptions is
// accepted and then does nothing — which is indistinguishable from a broken
// request. Both are cheap to pin down here.

import assert from 'node:assert/strict'

import { servarrAddPayload } from '../src/renderer/src/lib/api/servarr'

const options = { qualityProfileId: 4, rootFolderPath: '/data/media', searchNow: true }

// A lookup result as the server returns it: mostly fields this app has no
// name for and must not lose.
const seriesLookup = {
  title: 'Severance',
  tvdbId: 371980,
  titleSlug: 'severance',
  seasons: [{ seasonNumber: 1, monitored: true }],
  images: [{ coverType: 'poster', remoteUrl: 'https://example.invalid/p.jpg' }]
}

const movieLookup = {
  title: 'Dune',
  tmdbId: 438631,
  year: 2021,
  titleSlug: 'dune-2021',
  images: []
}

// ---------------------------------------------------------------------
// Everything the server told us about the title survives.
// ---------------------------------------------------------------------
{
  const body = servarrAddPayload('sonarr', seriesLookup, options)
  assert.equal(body.tvdbId, 371980, 'the id that identifies the show is not dropped')
  assert.deepEqual(body.seasons, seriesLookup.seasons)
  assert.deepEqual(body.images, seriesLookup.images)
  assert.equal(body.titleSlug, 'severance')
}

// ---------------------------------------------------------------------
// The person's choices are laid over it, and win.
// ---------------------------------------------------------------------
{
  const body = servarrAddPayload('radarr', { ...movieLookup, qualityProfileId: 1 }, options)
  assert.equal(body.qualityProfileId, 4, 'the chosen profile beats whatever the lookup carried')
  assert.equal(body.rootFolderPath, '/data/media')
  assert.equal(body.monitored, true, 'an unmonitored add would never fetch anything')
}

// ---------------------------------------------------------------------
// The two apps differ, and the difference is not cosmetic.
// ---------------------------------------------------------------------
{
  const sonarr = servarrAddPayload('sonarr', seriesLookup, options)
  assert.deepEqual(sonarr.addOptions, { searchForMissingEpisodes: true, monitor: 'all' })
  assert.equal(sonarr.seasonFolder, true)
  assert.equal(
    sonarr.minimumAvailability,
    undefined,
    'minimumAvailability is a Radarr concept and must not be sent to Sonarr'
  )

  const radarr = servarrAddPayload('radarr', movieLookup, options)
  assert.deepEqual(radarr.addOptions, { searchForMovie: true })
  assert.equal(
    radarr.minimumAvailability,
    'released',
    'Radarr refuses an add without one, and released is the value that does not queue an unreleased title forever'
  )
  assert.equal(
    radarr.seasonFolder,
    undefined,
    'seasonFolder is a Sonarr concept and must not be sent to Radarr'
  )
}

// ---------------------------------------------------------------------
// Adding without searching is a real choice and must reach the server as one.
// ---------------------------------------------------------------------
{
  const quiet = { ...options, searchNow: false }
  assert.deepEqual(servarrAddPayload('sonarr', seriesLookup, quiet).addOptions, {
    searchForMissingEpisodes: false,
    monitor: 'all'
  })
  assert.deepEqual(servarrAddPayload('radarr', movieLookup, quiet).addOptions, {
    searchForMovie: false
  })
}

console.log('servarr request tests passed')
