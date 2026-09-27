import assert from 'node:assert/strict'
import {
  checkcachedShortlist,
  guardedForPrefetch,
  rankStreams,
  releaseGroup,
  streamSeeders,
  titleMatchesRelease,
  type SourcePreference
} from '../src/main/media-hub/core'
import { mediaServerCopyEndsSearch } from '../src/main/media-hub/streamTierRules'
import { streamReleaseName } from '../src/shared/media-hub/streamQuality'
import type { StreamCandidate } from '../src/shared/media-hub/types'

const streams: StreamCandidate[] = [
  { infoHash: '4k', name: 'Movie 2160p WEB-DL 18 GB', cached: true, compatible: true },
  { infoHash: 'large', name: 'Movie 1080p WEB-DL 9 GB', cached: true, compatible: true },
  { infoHash: 'fit', name: 'Movie 1080p WEB-DL 4.5 GB', cached: true, compatible: true },
  { infoHash: 'small', name: 'Movie 720p WEB-DL 1.5 GB', cached: true, compatible: true }
]

assert.equal(
  rankStreams(streams, 'en', { maxResolution: 1080, maxSizeGb: 5 })[0].infoHash,
  'fit',
  'screen and download-size limits are both applied'
)
assert.equal(
  rankStreams(streams, 'en', { maxResolution: 720, maxSizeGb: 2 })[0].infoHash,
  'small',
  'a slow-connection profile selects the smaller 720p release'
)
assert.equal(
  rankStreams(streams, 'en', { maxResolution: 480, maxSizeGb: 0 }).length,
  0,
  'an explicit maximum is never silently exceeded'
)

// --- media server as a second source ---------------------------------------

const localAndRemote: StreamCandidate[] = [
  { infoHash: 'remote4k', name: 'Movie 2160p WEB-DL 18 GB', cached: true, compatible: true },
  {
    source: 'mediaserver',
    itemId: 'jf-1',
    mediaSourceId: 'ms-1',
    name: 'Movie.2019.1080p.BluRay.x264.mkv',
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  }
]

assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'balanced')[0].source,
  'mediaserver',
  'balanced prefers a local 1080p over a remote 2160p — one tier is worth the instant start'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'prefer-quality')[0].infoHash,
  'remote4k',
  'prefer-quality ignores locality and takes the higher resolution'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {}, 'prefer-local')[0].source,
  'mediaserver',
  'prefer-local takes the server copy'
)
assert.equal(
  rankStreams(localAndRemote, 'en', {})[0].source,
  'mediaserver',
  'balanced is the default when no preference is supplied'
)

// A local copy is still subject to the person's explicit limits.
assert.equal(
  rankStreams(localAndRemote, 'en', { maxResolution: 720 }, 'prefer-local').length,
  0,
  'an explicit resolution ceiling drops the local copy too'
)

// Locality must never outrank language — the same rule the remote path has.
const localWrongLanguage: StreamCandidate[] = [
  {
    source: 'mediaserver',
    itemId: 'jf-2',
    mediaSourceId: 'ms-2',
    name: 'Film.2019.TRUEFRENCH.1080p.BluRay.mkv',
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  },
  { infoHash: 'remote-en', name: 'Film 2019 1080p WEB-DL', cached: true, compatible: true }
]
assert.equal(
  rankStreams(localWrongLanguage, 'en', {}, 'balanced')[0].infoHash,
  'remote-en',
  'a local copy in the wrong language still loses to a correct-language remote'
)

// The streaming penalty models internet-pull latency, which a LAN file
// does not have — a local remux must not be demoted the way a remote one is.
const remuxes: StreamCandidate[] = [
  {
    source: 'mediaserver',
    itemId: 'jf-3',
    mediaSourceId: 'ms-3',
    name: 'Film.2019.2160p.REMUX.TrueHD.Atmos.mkv',
    resolution: 2160,
    cached: true,
    compatible: true,
    exact: true
  },
  { infoHash: 'remote-x264', name: 'Film 2019 1080p WEB-DL x264', cached: true, compatible: true }
]
assert.equal(
  rankStreams(remuxes, 'en', {}, 'balanced')[0].source,
  'mediaserver',
  'a local remux is not penalised — it is exactly what an on-site server is for'
)
assert.equal(
  rankStreams(
    [
      {
        infoHash: 'remote-remux',
        name: 'Film 2019 2160p REMUX TrueHD Atmos',
        cached: true,
        compatible: true
      },
      {
        infoHash: 'remote-x264',
        name: 'Film 2019 1080p WEB-DL x264',
        cached: true,
        compatible: true
      }
    ],
    'en',
    {}
  )[0].infoHash,
  'remote-x264',
  'a REMOTE remux is still penalised, exactly as before'
)

console.log('ok  stream selection resolution and size limits')

// --- seeders, for uncached candidates only ---------------------------------
// Both add-ons advertise a `👤 N` run in the text streamText already builds
// (confirmed live 2026-08-29). Until this landed, nothing read it — including
// the `queued` path, which submits the winner to TorBox to start caching, so
// the app could commit an account to a torrent nobody was seeding.
{
  const uncached = (infoHash: string, seeders: number | null, resolution = 1080): StreamCandidate =>
    ({
      infoHash,
      name: `Film ${resolution}p`,
      title: seeders === null ? 'Film.mkv 💾 4.0 GB' : `Film.mkv 👤 ${seeders} 💾 4.0 GB`,
      cached: false,
      compatible: true,
      exact: true
    }) as StreamCandidate

  assert.equal(streamSeeders(uncached('a', 284)), 284, 'reads the advertised count')
  assert.equal(streamSeeders(uncached('a', 0)), 0, 'zero is a real answer')
  assert.equal(streamSeeders(uncached('a', null)), null, 'a release that says nothing reports null')
  assert.equal(
    streamSeeders({ infoHash: 'a', title: 'Film 👤 2,081 💾 4.0 GB' } as StreamCandidate),
    2081,
    'thousands separators, as Torrentio writes them'
  )

  // Within a tier, the better-seeded release wins.
  assert.equal(
    rankStreams([uncached('dead', 2), uncached('alive', 400)], 'en', {}, 'balanced')[0].infoHash,
    'alive',
    'a well-seeded release beats a barely-seeded one of the same quality'
  )

  // ABSENCE IS NEUTRAL, which is neither zero nor no-bonus. Comet omits the
  // count on about half its results, so an unknown must not lose to a release
  // advertising a single seeder — but it must still lose to a healthy one.
  assert.equal(
    rankStreams([uncached('silent', null), uncached('barely', 1)], 'en', {}, 'balanced')[0]
      .infoHash,
    'silent',
    'an unknown seeder count beats a release advertising almost none'
  )
  assert.equal(
    rankStreams([uncached('silent', null), uncached('healthy', 400)], 'en', {}, 'balanced')[0]
      .infoHash,
    'healthy',
    'and still loses to a well-seeded one'
  )
  // A set where nothing reports a count is shifted by a constant, so the
  // ordering is exactly what it was before this term existed.
  assert.deepEqual(
    rankStreams([uncached('sd', null, 1080), uncached('hd', null, 2160)], 'en', {}, 'balanced').map(
      (s) => s.infoHash
    ),
    ['hd', 'sd'],
    'an all-unknown set is ordered by everything else, undisturbed'
  )

  // Never flips a resolution tier — checked against EVERY adjacent pair, not
  // just the widest one.
  //
  // This assertion used to cover only 2160-vs-1080, whose 1080-point gap the
  // old 900-point weight happened to clear. Every other step is far narrower
  // (the tightest is 720 to 480, at 240), and 900 cleared three of them: a
  // 720p release with 5000 seeders outranked a 1080p one with none. The bug
  // was invisible precisely because the one pair under test was the one pair
  // that worked.
  //
  // Set on the resolution FIELD rather than in the name, because
  // streamResolution only recognises 2160, 1080 and 720 in text — 1440 and
  // 480 only ever arrive numerically, and testing them through the text path
  // would silently score both candidates 0 and prove nothing.
  const numeric = (infoHash: string, seeders: number | null, resolution: number): StreamCandidate =>
    ({
      infoHash,
      name: 'Film',
      title: seeders === null ? 'Film.mkv 💾 4.0 GB' : `Film.mkv 👤 ${seeders} 💾 4.0 GB`,
      resolution,
      cached: false,
      compatible: true,
      exact: true
    }) as StreamCandidate
  for (const [higher, lower] of [
    [2160, 1440],
    [1440, 1080],
    [1080, 720],
    [720, 480]
  ]) {
    assert.equal(
      rankStreams(
        [numeric('better', 0, higher), numeric('worse', 5000, lower)],
        'en',
        {},
        'balanced'
      )[0].infoHash,
      'better',
      `no number of seeders promotes ${lower} over ${higher}`
    )
  }

  // And the term still does the job it exists for, inside a tier.
  assert.equal(
    rankStreams([uncached('few', 1), uncached('many', 400)], 'en', {}, 'balanced')[0].infoHash,
    'many',
    'seeders still order candidates within one tier'
  )

  // A cached candidate needs no peers at all — and Comet's `👤 0` results are
  // largely debrid-cached, which are the MOST playable, not the least.
  const cachedNoSeeders = {
    infoHash: 'cached',
    name: 'Film 1080p',
    title: 'Film.mkv 👤 0 💾 4.0 GB',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([cachedNoSeeders, uncached('seeded', 5000)], 'en', {}, 'balanced')[0].infoHash,
    'cached',
    'cached beats well-seeded-but-uncached; seeders never apply to a cached copy'
  )
}
console.log('ok  seeder ranking')

// --- the wanted audio, and the group that played last time -----------------
//
// The same show used to play one episode dubbed and the next subbed: a raw
// and a dual-audio release of an episode scored the same. A release that
// DECLARES the wanted audio now outranks one that says nothing (by more than
// a resolution tier), and the group that played the previous episode is
// preferred so audio and look stay consistent across a season.
{
  const raw2160 = {
    infoHash: 'raw',
    name: '[Raws] Show - 06 [2160p]',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  const dual1080 = {
    infoHash: 'dual',
    name: '[Group] Show - 06 [Dual-Audio][1080p]',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  const dub1080 = {
    infoHash: 'dub',
    name: 'Show S01E06 1080p ENG DUB WEB-DL',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([raw2160, dual1080], 'en', {}, 'balanced')[0].infoHash,
    'dual',
    'a dual-audio 1080p beats a raw 2160p when English is wanted'
  )
  assert.equal(
    rankStreams([raw2160, dual1080], 'ja', {}, 'balanced')[0].infoHash,
    'dual',
    'multi counts as carrying the wanted audio for any preference'
  )
  assert.equal(
    rankStreams([raw2160, dub1080], 'en', {}, 'balanced')[0].infoHash,
    'dub',
    'an English dub beats a raw of higher resolution'
  )
  // A media server that REPORTS its tracks is believed over the name.
  const serverJa = {
    source: 'mediaserver',
    itemId: 'jf',
    mediaSourceId: 'ms',
    name: 'Show S01E06 Dual Audio 1080p.mkv',
    audioLanguages: ['jpn'],
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([serverJa, dual1080], 'en', {}, 'prefer-quality')[0].infoHash,
    'dual',
    'reported tracks override a misleading name'
  )
  // Uncached never wins on language alone: the gate stays above the bonus.
  const uncachedDual = { ...dual1080, infoHash: 'udual', cached: false } as StreamCandidate
  assert.equal(
    rankStreams([raw2160, uncachedDual], 'en', {}, 'balanced')[0].infoHash,
    'raw',
    'a playable raw still beats an uncached dual-audio release'
  )

  // Release group memory.
  assert.equal(releaseGroup('[SubsPlease] Show - 06 (1080p) [ABCD1234].mkv'), 'subsplease')
  assert.equal(releaseGroup('Show.S01E06.1080p.WEB-DL.x264-SPARKS.mkv'), 'sparks')
  assert.equal(releaseGroup('Show S01E06 1080p'), null)
  assert.equal(releaseGroup('Show.S01E06.1080p.WEB-DL'), null, 'a format token is not a group')
  assert.equal(releaseGroup('Show.S01E06.1080p.WEB-DL'), null, 'a format token is not a group')
  const other2160 = {
    infoHash: 'other',
    name: '[Other] Show - 06 [Dual-Audio][2160p]',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([other2160, dual1080], 'en', {}, 'prefer-quality')[0].infoHash,
    'other',
    'without a memory the higher resolution wins'
  )
  assert.equal(
    rankStreams([other2160, dual1080], 'en', {}, 'prefer-quality', { preferredGroup: 'group' })[0]
      .infoHash,
    'dual',
    'the group that played the previous episode wins over one resolution tier'
  )
  assert.equal(
    rankStreams([raw2160, other2160], 'en', {}, 'prefer-quality', { preferredGroup: 'raws' })[0]
      .infoHash,
    'other',
    'but not over the wanted audio'
  )
}
console.log('ok  audio language and release group')

// --- what the ranking reads the release name from -------------------------
//
// Comet names every candidate "[TORRENT] Comet …" and puts the file name in
// `description`; Torrentio puts it in `title`. The release group must be
// read from the same line the memo remembered it from, or a Comet
// candidate's group is "torrent" and the same-group bonus never applies.
{
  const cometShaped = {
    infoHash: 'comet',
    name: '[TORRENT] Comet 1080p',
    description: '[Group] Show - 06 [Dual-Audio][1080p]\n👤 12 💾 1.2 GB',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  const torrentioShaped = {
    infoHash: 'torrentio',
    name: 'Torrentio\n2160p',
    title: '[Other] Show - 06 [Dual-Audio][2160p]\n👤 40 💾 4.1 GB',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(streamReleaseName(cometShaped), '[Group] Show - 06 [Dual-Audio][1080p]')
  assert.equal(streamReleaseName(torrentioShaped), '[Other] Show - 06 [Dual-Audio][2160p]')
  assert.equal(releaseGroup(streamReleaseName(cometShaped)), 'group')
  assert.equal(
    rankStreams([torrentioShaped, cometShaped], 'en', {}, 'prefer-quality', {
      preferredGroup: 'group'
    })[0].infoHash,
    'comet',
    "the memo's group is found on a Comet-shaped candidate, not the add-on's label"
  )

  // A media server that reports an English track is not a French dub,
  // whatever its file is called.
  const serverTrueFrench = {
    source: 'mediaserver',
    itemId: 'jf',
    mediaSourceId: 'ms',
    name: 'Film.2019.TRUEFRENCH.1080p.BluRay.mkv',
    audioLanguages: ['fre', 'eng'],
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  const remoteSilent = {
    infoHash: 'silent',
    name: 'Film 2019 1080p WEB-DL',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(
    rankStreams([remoteSilent, serverTrueFrench], 'en', {}, 'balanced')[0].source,
    'mediaserver',
    'reported English audio suppresses the penalty the file name would earn'
  )
  const serverFrenchOnly = { ...serverTrueFrench, audioLanguages: ['fre'] } as StreamCandidate
  assert.equal(
    rankStreams([remoteSilent, serverFrenchOnly], 'en', {}, 'balanced')[0].infoHash,
    'silent',
    'reported tracks that lack the language leave the name-based penalty in place'
  )
}
console.log('ok  release name source and reported tracks')

// A media server is the one source that names the FILE in `name` and the
// library title in `title` — the reverse of the add-ons. Reading `title`
// first there lost the group on every Jellyfin copy, so a season that had
// been playing from the server's [SubsPlease] files stopped preferring them.
{
  const jellyfinShaped = {
    source: 'mediaserver',
    itemId: 'jf',
    mediaSourceId: 'ms',
    name: '[SubsPlease] Show - 06 (1080p) [ABCD1234].mkv',
    title: 'Show Episode 6',
    audioLanguages: ['eng', 'jpn'],
    resolution: 1080,
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  const rivalTorrentio = {
    infoHash: 'rival',
    name: 'Torrentio\n2160p',
    title: '[OtherGrp] Show - 06 [Dual-Audio][2160p]\n👤 40 💾 4.1 GB',
    cached: true,
    compatible: true,
    exact: true
  } as StreamCandidate
  assert.equal(streamReleaseName(jellyfinShaped), '[SubsPlease] Show - 06 (1080p) [ABCD1234].mkv')
  assert.equal(releaseGroup(streamReleaseName(jellyfinShaped)), 'subsplease')
  assert.equal(
    rankStreams([rivalTorrentio, jellyfinShaped], 'en', {}, 'prefer-quality', {
      preferredGroup: 'subsplease'
    })[0].source,
    'mediaserver',
    "the server's own file keeps the season on its group over a higher-resolution rival"
  )
  const lockedDown = { ...jellyfinShaped, name: 'Episode 6' } as StreamCandidate
  assert.equal(
    streamReleaseName(lockedDown),
    'Episode 6',
    'a server that hides Path falls back to the item name, which names no group'
  )
  assert.equal(releaseGroup(streamReleaseName(lockedDown)), null)
}
console.log('ok  media-server release name')

// Scene names come with spaces as well as dots; the group is the suffix of
// the whole name, not of its first word.
assert.equal(releaseGroup('Show S01E06 1080p WEB-DL x264-SPARKS.mkv'), 'sparks')
assert.equal(
  releaseGroup('Show S01E06 1080p WEB-DL'),
  null,
  'a spaced name ending in a format token'
)
assert.equal(releaseGroup('Show - 06 [1080p]'), null, 'an episode number is not a group')
console.log('ok  spaced scene groups')

// Only a release name carries a group; titles, quality suffixes and codec
// tokens must not become one — a wrong memo pays a resolution tier's worth
// of bonus to every unrelated release that happens to share it.
assert.equal(releaseGroup('The Amazing Spider-Man'), null, 'a hyphenated title is not a release')
assert.equal(releaseGroup('X-Men'), null)
assert.equal(releaseGroup('The Show 1990-1995'), null)
assert.equal(
  releaseGroup('Attack on Titan - S01E01 - To You, in 2000 Years WEBDL-1080p.mkv'),
  null,
  "Sonarr's quality suffix is not a group"
)
assert.equal(releaseGroup('The Matrix (1999) Bluray-1080p.mkv'), null)
assert.equal(releaseGroup('Attack on Titan S01E06 1080p BluRay x265-10bit'), null)
assert.equal(releaseGroup('Movie 2160p WEB-DL DDP5.1-Atmos'), null)
assert.equal(releaseGroup('Show S02E01 1080p Multi-Sub'), null)
assert.equal(releaseGroup('Show S02E01 1080p Dual-Audio'), null)
assert.equal(releaseGroup('Spider-Man 2002 1080p BluRay x264-GROUP'), 'group')
assert.equal(
  releaseGroup('Some.Movie.2019.1080p.BluRay.x264-GROUP [eztv]'),
  'group',
  'a dotted name with a suffix after a space still yields its group'
)
assert.equal(releaseGroup('Show.S01E06.1080p.WEB-DL.x264-SPARKS.mkv 2.1 GB'), 'sparks')

// The prefetch guard: names to check and none matching means nothing to
// fetch, never the unguarded set.
{
  const right = {
    infoHash: 'r',
    name: '[Group] Shingeki no Kyojin - 06 [1080p]'
  } as StreamCandidate
  const wrong = {
    infoHash: 'w',
    name: '[Group] Shingeki no Kyojin Junior High - 06 [1080p]'
  } as StreamCandidate
  const unrelated = { infoHash: 'u', name: 'Some Other Show - 06 [1080p]' } as StreamCandidate
  assert.deepEqual(
    guardedForPrefetch([right, wrong, unrelated], ['Attack on Titan', 'Shingeki no Kyojin']).map(
      (s) => s.infoHash
    ),
    ['r'],
    'the romaji name lets the right release through and keeps the spin-off out'
  )
  assert.deepEqual(
    guardedForPrefetch([unrelated], ['Attack on Titan']),
    [],
    'nothing matching means nothing to prefetch'
  )
  assert.equal(
    guardedForPrefetch([unrelated], []).length,
    1,
    'with no names the guard has nothing to say'
  )
}
console.log('ok  release-name guards')

// The title guard reads fansub names too — most anime is released that
// way, and every such name used to fail the guard outright.
assert.equal(
  titleMatchesRelease('[SubsPlease] Shingeki no Kyojin S4 - 28 (1080p) [ABCD1234].mkv', [
    'Attack on Titan',
    'Shingeki no Kyojin'
  ]),
  true
)
assert.equal(titleMatchesRelease('[Group] Show - 06v2 [Dual-Audio][1080p]', 'Show'), true)
assert.equal(
  titleMatchesRelease('Re:Zero - Starting Life in Another World - 05 [1080p]', [
    'Re:Zero Starting Life in Another World'
  ]),
  true,
  'a title with its own dash keeps it; only the episode marker comes off'
)
assert.equal(
  titleMatchesRelease('[Group] Shingeki no Kyojin Junior High - 06 [1080p]', 'Shingeki no Kyojin'),
  false,
  'a spin-off is still not the show'
)
assert.equal(
  titleMatchesRelease('Shingeki.no.Kyojin.S01E06.1080p.WEB-DL-GROUP', 'Shingeki no Kyojin'),
  true,
  'the scene form still matches'
)
console.log('ok  fansub title guard')

// --- checkcached shortlist -------------------------------------------------

{
  // Comet lists every release it has, 4K remuxes first, merged ahead of
  // Torrentio. The batch used to be the first hundred of that list, so a
  // 1080p ceiling left nothing checked that could ever be played.
  const remuxes: StreamCandidate[] = Array.from({ length: 150 }, (_, i) => ({
    infoHash: `r${i}`.padEnd(40, '0'),
    name: `Movie 2023 2160p UHD BluRay REMUX 70 GB`
  }))
  const encode: StreamCandidate = {
    infoHash: 'e'.padEnd(40, '0'),
    name: 'Movie 2023 1080p WEB-DL 6 GB'
  }
  const shortlist = checkcachedShortlist([...remuxes, encode], 'en', { maxResolution: 1080 })
  assert.deepEqual(
    shortlist,
    [encode.infoHash],
    'releases over the ceiling are not spent on the checkcached batch'
  )
  const unlimited = checkcachedShortlist([...remuxes, encode], 'en', {})
  assert.equal(unlimited.length, 100, 'the batch is still capped')
}
console.log('ok  checkcached shortlist')

// --- what "Balanced" means between a local and a remote copy ----------------
// Both copies cached, compatible, exact and in the wanted language, no
// release-group memo: only locality and resolution differ. The rule, from
// LOCAL_SOURCE_BONUS in core.ts: the local copy wins ties and beats a
// remote copy one tier better, but not more — "a local 1080p is preferred
// to a remote 2160p, a local 720p is not".

{
  const serverCopy = (resolution: number): StreamCandidate => ({
    source: 'mediaserver',
    itemId: `jf-${resolution}`,
    mediaSourceId: `ms-${resolution}`,
    name: `Movie.2019.${resolution}p.WEB-DL.mkv`,
    audioLanguages: ['eng'],
    resolution,
    cached: true,
    compatible: true,
    exact: true
  })
  const torboxCopy = (resolution: number): StreamCandidate => ({
    infoHash: `remote${resolution}`,
    name: `Movie 2019 ${resolution}p WEB-DL`,
    audioLanguages: ['eng'],
    cached: true,
    compatible: true,
    exact: true
  })
  // 'tie' when the winner is whichever copy was listed first — the scores
  // are equal, which is what prefer-quality means at equal resolution.
  const winner = (local: number, remote: number, preference: SourcePreference): string => {
    const [remoteFirst, localFirst] = [
      [torboxCopy(remote), serverCopy(local)],
      [serverCopy(local), torboxCopy(remote)]
    ].map((list) => rankStreams(list, 'en', {}, preference)[0].source)
    if (remoteFirst !== localFirst) return 'tie'
    return remoteFirst === 'mediaserver' ? 'local' : 'remote'
  }

  // [local, remote, balanced, prefer-local, prefer-quality]
  const cases: [number, number, string, string, string][] = [
    [1080, 2160, 'local', 'local', 'remote'],
    [720, 2160, 'remote', 'local', 'remote'],
    [720, 1080, 'local', 'local', 'remote'],
    [1080, 1080, 'local', 'local', 'tie']
  ]
  for (const [local, remote, balanced, preferLocal, preferQuality] of cases) {
    assert.equal(
      winner(local, remote, 'balanced'),
      balanced,
      `balanced: local ${local} vs remote ${remote}`
    )
    assert.equal(
      winner(local, remote, 'prefer-local'),
      preferLocal,
      `prefer-local: local ${local} vs remote ${remote}`
    )
    assert.equal(
      winner(local, remote, 'prefer-quality'),
      preferQuality,
      `prefer-quality: local ${local} vs remote ${remote}`
    )
  }

  // A copy that would lose anyway must not strip the local copy's bonus and
  // hand the win to a third copy the local one should beat.
  const uncached2160 = { ...torboxCopy(2160), infoHash: 'uncached2160', cached: false }
  assert.equal(
    rankStreams([uncached2160, torboxCopy(1080), serverCopy(720)], 'en', {}, 'balanced')[0].source,
    'mediaserver',
    'an uncached 2160p does not let a remote 1080p beat a local 720p'
  )
  // Outclassed, the local copy still competes on merit rather than
  // dropping out: it stays ahead of anything it beats on its own.
  assert.deepEqual(
    rankStreams([torboxCopy(2160), serverCopy(720), uncached2160], 'en', {}, 'balanced').map(
      (s) => s.infoHash ?? s.source
    ),
    ['remote2160', 'mediaserver', 'uncached2160'],
    'an outclassed local copy keeps its place behind the one that outclassed it'
  )
  // Language still outranks locality and resolution alike.
  const remote2160Silent = { ...torboxCopy(2160), audioLanguages: undefined }
  assert.equal(
    rankStreams([remote2160Silent, serverCopy(720)], 'en', {}, 'balanced')[0].source,
    'mediaserver',
    'a remote 2160p that does not declare the wanted audio does not outclass a local copy that does'
  )
}
console.log('ok  balanced source preference')

// --- does a media-server copy end the search? --------------------------------

{
  // [preference, maxResolution, localResolution, expected]
  const cases: [SourcePreference, number, number | undefined, boolean][] = []
  const ladders: [number, number, number, number][] = [
    // limit, at the limit, half the limit (cannot be outclassed), below half
    [0, 2160, 1080, 720],
    [1080, 1080, 720, 480],
    [2160, 2160, 1080, 720]
  ]
  for (const [limit, at, half, belowHalf] of ladders) {
    for (const local of [at, half, belowHalf, undefined]) {
      cases.push(['prefer-local', limit, local, true])
      cases.push(['prefer-quality', limit, local, false])
    }
    cases.push(['balanced', limit, at, true])
    cases.push(['balanced', limit, half, true])
    cases.push(['balanced', limit, belowHalf, false])
    cases.push(['balanced', limit, undefined, false])
  }
  // The common case the gate exists for: a 1080p library with no limit set
  // plays from the server at once, and so does 1440p.
  assert.equal(mediaServerCopyEndsSearch('balanced', 1080, 0), true)
  assert.equal(mediaServerCopyEndsSearch('balanced', 1440, 0), true)
  for (const [preference, limit, local, expected] of cases) {
    assert.equal(
      mediaServerCopyEndsSearch(preference, local, limit),
      expected,
      `${preference}, limit ${limit}, local ${local ?? 'unknown'}`
    )
  }
  // A limit between the usual resolutions is taken as it is.
  assert.equal(mediaServerCopyEndsSearch('balanced', 720, 1000), true)
  assert.equal(mediaServerCopyEndsSearch('balanced', 480, 1000), false)
  assert.equal(
    mediaServerCopyEndsSearch('balanced', 0, 2160),
    false,
    'a zero resolution is unknown'
  )

  // The rule never ends the search on a copy the ranking would let a remote
  // copy within the limit outrank: at every limit, the lowest local
  // resolution it accepts still beats the sharpest remote copy allowed.
  for (const limit of [480, 720, 1080, 1440, 2160]) {
    const accepted = [480, 720, 1080, 1440, 2160].filter(
      (r) => r <= limit && mediaServerCopyEndsSearch('balanced', r, limit)
    )
    const lowest = Math.min(...accepted)
    const local: StreamCandidate = {
      source: 'mediaserver',
      itemId: 'jf',
      mediaSourceId: 'ms',
      name: `Movie.${lowest}p.mkv`,
      resolution: lowest,
      cached: true,
      compatible: true,
      exact: true
    }
    const remote: StreamCandidate = {
      infoHash: 'remote',
      name: `Movie ${limit}p WEB-DL`,
      cached: true,
      compatible: true,
      exact: true
    }
    assert.equal(
      rankStreams([remote, local], 'en', { maxResolution: limit }, 'balanced')[0].source,
      'mediaserver',
      `limit ${limit}: an accepted local ${lowest}p is not outranked`
    )
  }
}
console.log('ok  media-server copy ends the search')
