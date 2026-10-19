// Builds src/shared/media-hub/universeData.ts — the big collections (the
// Marvel Cinematic Universe, Star Wars and the like) the Collections page
// lists in order.
//
// Why a list kept by hand. Nothing this app talks to models a universe. TMDB's
// collections stop at one film series ("Iron Man Collection") and hold no
// television at all; Wikidata's franchise links were tried and are missing
// whole trilogies (every numbered Star Wars film, for one) while listing theme
// park rides and Lego shorts. And story order — the order things happen in,
// which is half the reason to want this page — is in no catalogue anywhere.
//
// So the membership and the story order live below, and this script does the
// part a person should not: it asks Cinemeta (the catalogue the app itself
// reads) for every id, takes the title and release date from the answer, and
// refuses to write anything when an id does not resolve or resolves to a
// different title than the one written beside it here.
//
//   node scripts/build-universes.mjs
//
// Each entry is [imdb id, 'm' film | 's' series, Cinemeta's exact title, and
// optionally the title to show instead]. The last is for a title Cinemeta
// gives too bare to tell apart: three different works are all "Star Trek". A
// universe with `story: true` is written in story order; one without is in
// whatever order, and the page offers release order only.

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/shared/media-hub/universeData.ts'
)

/** Either Cinemeta host serves the same records; the second is tried when the
 *  first does not resolve. */
const HOSTS = ['https://v3-cinemeta.strem.io', 'https://cinemeta-live.strem.io']

const UNIVERSES = [
  {
    id: 'marvel-cinematic-universe',
    name: 'Marvel Cinematic Universe',
    blurb: 'Every film and series, from Iron Man to the Multiverse Saga.',
    story: true,
    entries: [
      ['tt0458339', 'm', 'Captain America: The First Avenger'],
      ['tt3475734', 's', "Marvel's Agent Carter"],
      ['tt4154664', 'm', 'Captain Marvel'],
      ['tt0371746', 'm', 'Iron Man'],
      ['tt1228705', 'm', 'Iron Man 2'],
      ['tt0800080', 'm', 'The Incredible Hulk'],
      ['tt0800369', 'm', 'Thor'],
      ['tt0848228', 'm', 'The Avengers'],
      ['tt1981115', 'm', 'Thor: The Dark World'],
      ['tt1300854', 'm', 'Iron Man 3'],
      ['tt2364582', 's', "Marvel's Agents of S.H.I.E.L.D."],
      ['tt1843866', 'm', 'Captain America: The Winter Soldier'],
      ['tt2015381', 'm', 'Guardians of the Galaxy'],
      ['tt3896198', 'm', 'Guardians of the Galaxy Vol. 2'],
      ['tt13623148', 's', 'I Am Groot'],
      ['tt3322312', 's', "Marvel's Daredevil"],
      ['tt2357547', 's', "Marvel's Jessica Jones"],
      ['tt2395427', 'm', 'Avengers: Age of Ultron'],
      ['tt0478970', 'm', 'Ant-Man'],
      ['tt3322314', 's', "Marvel's Luke Cage"],
      ['tt3322310', 's', "Marvel's Iron Fist"],
      ['tt4230076', 's', "Marvel's The Defenders"],
      ['tt3498820', 'm', 'Captain America: Civil War'],
      ['tt3480822', 'm', 'Black Widow'],
      ['tt1825683', 'm', 'Black Panther'],
      ['tt2250912', 'm', 'Spider-Man: Homecoming'],
      ['tt5675620', 's', "Marvel's The Punisher"],
      ['tt1211837', 'm', 'Doctor Strange'],
      ['tt3501632', 'm', 'Thor: Ragnarok'],
      ['tt4154858', 's', "Marvel's Inhumans"],
      ['tt1236246', 's', "Marvel's Runaways"],
      ['tt5614844', 's', "Marvel's Cloak & Dagger"],
      ['tt5095030', 'm', 'Ant-Man and the Wasp'],
      ['tt4154756', 'm', 'Avengers: Infinity War'],
      ['tt4154796', 'm', 'Avengers: Endgame'],
      ['tt9140554', 's', 'Loki'],
      ['tt10168312', 's', 'What If...?'],
      ['tt9140560', 's', 'WandaVision'],
      ['tt9208876', 's', 'The Falcon and the Winter Soldier'],
      ['tt9376612', 'm', 'Shang-Chi and the Legend of the Ten Rings'],
      ['tt9032400', 'm', 'Eternals'],
      ['tt6320628', 'm', 'Spider-Man: Far From Home'],
      ['tt10872600', 'm', 'Spider-Man: No Way Home'],
      ['tt9419884', 'm', 'Doctor Strange in the Multiverse of Madness'],
      ['tt10160804', 's', 'Hawkeye'],
      ['tt10234724', 's', 'Moon Knight'],
      ['tt10857160', 's', 'She-Hulk: Attorney at Law'],
      ['tt10857164', 's', 'Ms. Marvel'],
      ['tt10648342', 'm', 'Thor: Love and Thunder'],
      ['tt15318872', 'm', 'Werewolf by Night'],
      ['tt9114286', 'm', 'Black Panther: Wakanda Forever'],
      ['tt13623136', 'm', 'The Guardians of the Galaxy Holiday Special'],
      ['tt10954600', 'm', 'Ant-Man and the Wasp: Quantumania'],
      ['tt6791350', 'm', 'Guardians of the Galaxy Vol. 3'],
      ['tt13157618', 's', 'Secret Invasion'],
      ['tt10676048', 'm', 'The Marvels'],
      ['tt13966962', 's', 'Echo'],
      ['tt6263850', 'm', 'Deadpool & Wolverine'],
      ['tt15571732', 's', 'Agatha All Along'],
      ['tt18923754', 's', 'Daredevil: Born Again'],
      ['tt14513804', 'm', 'Captain America: Brave New World'],
      ['tt20969586', 'm', 'Thunderbolts*'],
      ['tt13623126', 's', 'Ironheart'],
      ['tt10676052', 'm', 'The Fantastic 4: First Steps'],
      ['tt21066182', 's', 'Wonder Man'],
      ['tt22084616', 'm', 'Spider-Man: Brand New Day'],
      ['tt23112594', 's', 'VisionQuest'],
      ['tt21357150', 'm', 'Avengers: Doomsday']
    ]
  },
  {
    id: 'star-wars',
    name: 'Star Wars',
    blurb: 'The saga, the standalone films and every series around them.',
    story: true,
    entries: [
      ['tt20674124', 's', 'Star Wars: Young Jedi Adventures'],
      ['tt12262202', 's', 'The Acolyte'],
      ['tt0120915', 'm', 'Star Wars: Episode I - The Phantom Menace'],
      ['tt0121765', 'm', 'Star Wars: Episode II - Attack of the Clones'],
      ['tt0361243', 's', 'Star Wars: Clone Wars'],
      ['tt1185834', 'm', 'Star Wars: The Clone Wars'],
      ['tt0458290', 's', 'Star Wars: The Clone Wars'],
      ['tt20723374', 's', 'Star Wars: Tales of the Jedi'],
      ['tt0121766', 'm', 'Star Wars: Episode III - Revenge of the Sith'],
      ['tt12708542', 's', 'Star Wars: The Bad Batch'],
      ['tt32019314', 's', 'Star Wars: Tales of the Empire'],
      ['tt36414431', 's', 'Star Wars: Tales of the Underworld'],
      ['tt36594331', 's', 'Star Wars: Maul - Shadow Lord'],
      ['tt3778644', 'm', 'Solo: A Star Wars Story'],
      ['tt8466564', 's', 'Obi-Wan Kenobi'],
      ['tt9253284', 's', 'Andor'],
      ['tt0088510', 's', 'Star Wars: Droids'],
      ['tt2930604', 's', 'Star Wars Rebels'],
      ['tt3748528', 'm', 'Rogue One: A Star Wars Story'],
      ['tt0076759', 'm', 'Star Wars', 'Star Wars: Episode IV - A New Hope'],
      [
        'tt0080684',
        'm',
        'The Empire Strikes Back',
        'Star Wars: Episode V - The Empire Strikes Back'
      ],
      ['tt0087225', 'm', 'The Ewok Adventure'],
      ['tt0089110', 'm', 'Ewoks: The Battle for Endor'],
      ['tt0088515', 's', 'Ewoks'],
      ['tt0086190', 'm', 'Return of the Jedi', 'Star Wars: Episode VI - Return of the Jedi'],
      ['tt8111088', 's', 'The Mandalorian'],
      ['tt13668894', 's', 'The Book of Boba Fett'],
      ['tt13622776', 's', 'Ahsoka'],
      ['tt20600980', 's', 'Star Wars: Skeleton Crew'],
      ['tt30825738', 'm', 'The Mandalorian and Grogu'],
      ['tt8336340', 's', 'Star Wars Resistance'],
      ['tt2488496', 'm', 'Star Wars: The Force Awakens'],
      ['tt2527336', 'm', 'Star Wars: The Last Jedi'],
      ['tt2527338', 'm', 'Star Wars: The Rise of Skywalker'],
      ['tt13622982', 's', 'Star Wars: Visions']
    ]
  },
  {
    id: 'dc-extended-universe',
    name: 'DC Extended Universe',
    blurb: 'Man of Steel through Aquaman and the Lost Kingdom.',
    entries: [
      ['tt0770828', 'm', 'Man of Steel'],
      ['tt2975590', 'm', 'Batman v Superman: Dawn of Justice'],
      ['tt1386697', 'm', 'Suicide Squad'],
      ['tt0451279', 'm', 'Wonder Woman'],
      ['tt0974015', 'm', 'Justice League'],
      ['tt1477834', 'm', 'Aquaman'],
      ['tt0448115', 'm', 'Shazam!'],
      ['tt7713068', 'm', 'Birds of Prey (and the Fantabulous Emancipation of One Harley Quinn)'],
      ['tt7126948', 'm', 'Wonder Woman 1984'],
      ['tt12361974', 'm', "Zack Snyder's Justice League"],
      ['tt6334354', 'm', 'The Suicide Squad'],
      ['tt13146488', 's', 'Peacemaker'],
      ['tt6443346', 'm', 'Black Adam'],
      ['tt10151854', 'm', 'Shazam! Fury of the Gods'],
      ['tt0439572', 'm', 'The Flash'],
      ['tt9362930', 'm', 'Blue Beetle'],
      ['tt9663764', 'm', 'Aquaman and the Lost Kingdom']
    ]
  },
  {
    id: 'x-men',
    name: 'X-Men',
    blurb: "Fox's mutants: the films, Deadpool, Logan and the two series.",
    entries: [
      ['tt0120903', 'm', 'X-Men'],
      ['tt0290334', 'm', 'X2'],
      ['tt0376994', 'm', 'X-Men: The Last Stand'],
      ['tt0458525', 'm', 'X-Men Origins: Wolverine'],
      ['tt1270798', 'm', 'X-Men: First Class'],
      ['tt1430132', 'm', 'The Wolverine'],
      ['tt1877832', 'm', 'X-Men: Days of Future Past'],
      ['tt1431045', 'm', 'Deadpool'],
      ['tt3385516', 'm', 'X-Men: Apocalypse'],
      ['tt5114356', 's', 'Legion'],
      ['tt3315342', 'm', 'Logan'],
      ['tt4396630', 's', 'The Gifted'],
      ['tt5463162', 'm', 'Deadpool 2'],
      ['tt6565702', 'm', 'Dark Phoenix'],
      ['tt4682266', 'm', 'The New Mutants']
    ]
  },
  {
    id: 'wizarding-world',
    name: 'Wizarding World',
    blurb: 'Fantastic Beasts and Harry Potter.',
    story: true,
    entries: [
      ['tt3183660', 'm', 'Fantastic Beasts and Where to Find Them'],
      ['tt4123430', 'm', 'Fantastic Beasts: The Crimes of Grindelwald'],
      ['tt4123432', 'm', 'Fantastic Beasts: The Secrets of Dumbledore'],
      ['tt0241527', 'm', "Harry Potter and the Philosopher's Stone"],
      ['tt0295297', 'm', 'Harry Potter and the Chamber of Secrets'],
      ['tt0304141', 'm', 'Harry Potter and the Prisoner of Azkaban'],
      ['tt0330373', 'm', 'Harry Potter and the Goblet of Fire'],
      ['tt0373889', 'm', 'Harry Potter and the Order of the Phoenix'],
      ['tt0417741', 'm', 'Harry Potter and the Half-Blood Prince'],
      ['tt0926084', 'm', 'Harry Potter and the Deathly Hallows: Part 1'],
      ['tt1201607', 'm', 'Harry Potter and the Deathly Hallows: Part 2']
    ]
  },
  {
    id: 'middle-earth',
    name: 'Middle-earth',
    blurb: 'The Rings of Power, The Hobbit and The Lord of the Rings.',
    story: true,
    entries: [
      ['tt7631058', 's', 'The Lord of the Rings: The Rings of Power'],
      ['tt14824600', 'm', 'The Lord of the Rings: The War of the Rohirrim'],
      ['tt0903624', 'm', 'The Hobbit: An Unexpected Journey'],
      ['tt1170358', 'm', 'The Hobbit: The Desolation of Smaug'],
      ['tt2310332', 'm', 'The Hobbit: The Battle of the Five Armies'],
      ['tt0120737', 'm', 'The Lord of the Rings: The Fellowship of the Ring'],
      ['tt0167261', 'm', 'The Lord of the Rings: The Two Towers'],
      ['tt0167260', 'm', 'The Lord of the Rings: The Return of the King']
    ]
  },
  {
    id: 'star-trek',
    name: 'Star Trek',
    blurb: 'Sixty years of series and films.',
    entries: [
      ['tt0060028', 's', 'Star Trek', 'Star Trek: The Original Series'],
      ['tt0069637', 's', 'Star Trek', 'Star Trek: The Animated Series'],
      ['tt0079945', 'm', 'Star Trek: The Motion Picture'],
      ['tt0084726', 'm', 'Star Trek II: The Wrath of Khan'],
      ['tt0088170', 'm', 'Star Trek III: The Search for Spock'],
      ['tt0092007', 'm', 'Star Trek IV: The Voyage Home'],
      ['tt0092455', 's', 'Star Trek: The Next Generation'],
      ['tt0098382', 'm', 'Star Trek V: The Final Frontier'],
      ['tt0102975', 'm', 'Star Trek VI: The Undiscovered Country'],
      ['tt0106145', 's', 'Star Trek: Deep Space Nine'],
      ['tt0111280', 'm', 'Star Trek: Generations'],
      ['tt0112178', 's', 'Star Trek: Voyager'],
      ['tt0117731', 'm', 'Star Trek: First Contact'],
      ['tt0120844', 'm', 'Star Trek: Insurrection'],
      ['tt0244365', 's', 'Star Trek: Enterprise'],
      ['tt0253754', 'm', 'Star Trek: Nemesis'],
      ['tt0796366', 'm', 'Star Trek'],
      ['tt1408101', 'm', 'Star Trek Into Darkness'],
      ['tt2660888', 'm', 'Star Trek Beyond'],
      ['tt5171438', 's', 'Star Trek: Discovery'],
      ['tt8806524', 's', 'Star Trek: Picard'],
      ['tt9184820', 's', 'Star Trek: Lower Decks'],
      ['tt9795876', 's', 'Star Trek: Prodigy'],
      ['tt12327578', 's', 'Star Trek: Strange New Worlds'],
      ['tt9603060', 'm', 'Star Trek: Section 31']
    ]
  },
  {
    id: 'alien-and-predator',
    name: 'Alien & Predator',
    blurb: 'Both series, and the films where they meet.',
    entries: [
      ['tt0078748', 'm', 'Alien'],
      ['tt0090605', 'm', 'Aliens'],
      ['tt0093773', 'm', 'Predator'],
      ['tt0100403', 'm', 'Predator 2'],
      ['tt0103644', 'm', 'Alien³'],
      ['tt0118583', 'm', 'Alien Resurrection'],
      ['tt0370263', 'm', 'AVP: Alien vs. Predator'],
      ['tt0758730', 'm', 'Aliens vs. Predator: Requiem'],
      ['tt1424381', 'm', 'Predators'],
      ['tt1446714', 'm', 'Prometheus'],
      ['tt2316204', 'm', 'Alien: Covenant'],
      ['tt3829266', 'm', 'The Predator'],
      ['tt11866324', 'm', 'Prey'],
      ['tt18412256', 'm', 'Alien: Romulus'],
      ['tt36463894', 'm', 'Predator: Killer of Killers'],
      ['tt13623632', 's', 'Alien: Earth'],
      ['tt31227572', 'm', 'Predator: Badlands']
    ]
  },
  {
    id: 'monsterverse',
    name: 'MonsterVerse',
    blurb: 'Godzilla, Kong and Monarch.',
    entries: [
      ['tt0831387', 'm', 'Godzilla'],
      ['tt3731562', 'm', 'Kong: Skull Island'],
      ['tt3741700', 'm', 'Godzilla: King of the Monsters'],
      ['tt5034838', 'm', 'Godzilla vs. Kong'],
      ['tt13929756', 's', 'Skull Island'],
      ['tt17220216', 's', 'Monarch: Legacy of Monsters'],
      ['tt14539740', 'm', 'Godzilla x Kong: The New Empire']
    ]
  }
]

/** Letters and digits only, so "Thunderbolts*" and "Maul – Shadow Lord"
 *  compare equal to however Cinemeta punctuates them. */
const fold = (title) =>
  String(title ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')

async function meta(id, kind) {
  const type = kind === 'm' ? 'movie' : 'series'
  // Twice round: a single dropped request otherwise reads as an id that
  // does not resolve, and stops the whole run.
  for (const host of [...HOSTS, ...HOSTS]) {
    try {
      const response = await fetch(`${host}/meta/${type}/${id}.json`)
      if (!response.ok) continue
      const body = await response.json()
      if (body?.meta?.name) return body.meta
    } catch {
      // The next host.
    }
  }
  return null
}

const isoDay = (value) =>
  /^\d{4}-\d{2}-\d{2}/.test(String(value ?? '')) ? String(value).slice(0, 10) : ''

/** A series' first aired episode — specials (season 0) can predate the show. */
function firstEpisodeDay(videos) {
  const days = (Array.isArray(videos) ? videos : [])
    .filter((video) => Number(video?.season) > 0)
    .map((video) => isoDay(video?.released))
    .filter(Boolean)
    .sort()
  return days[0] ?? ''
}

/**
 * The earliest release Wikidata records for each IMDb id, to the day.
 * Statements known only to the year are left out: Wikidata writes those as
 * 1 January, which would put a November film ahead of everything else that
 * year. Best-rank statements only — the rest include every date a film was
 * once announced for, and the earliest of those put No Way Home in July.
 */
async function wikidataReleaseDays(ids) {
  const days = new Map()
  for (let start = 0; start < ids.length; start += 80) {
    const values = ids
      .slice(start, start + 80)
      .map((id) => `"${id}"`)
      .join(' ')
    const query = `SELECT ?imdb (MIN(?when) AS ?first) WHERE { VALUES ?imdb { ${values} } ?work wdt:P345 ?imdb; p:P577 ?statement. ?statement a wikibase:BestRank; psv:P577 ?node. ?node wikibase:timeValue ?when; wikibase:timePrecision 11 . } GROUP BY ?imdb`
    try {
      const response = await fetch(
        `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
        { headers: { 'User-Agent': 'r3-media-hub build-universes (development script)' } }
      )
      const body = await response.json()
      for (const row of body?.results?.bindings ?? []) {
        days.set(row.imdb.value, isoDay(row.first.value))
      }
    } catch (error) {
      console.warn(`Wikidata lookup failed: ${error?.message ?? error}`)
    }
  }
  return days
}

const problems = []
const built = []
for (const universe of UNIVERSES) {
  const seen = new Set()
  const entries = []
  for (const [id, kind, expected, label] of universe.entries) {
    if (seen.has(id)) problems.push(`${universe.id}: ${id} is listed twice`)
    seen.add(id)
    const found = await meta(id, kind)
    if (!found) {
      problems.push(`${universe.id}: ${id} (${expected}) did not resolve as a ${kind}`)
      continue
    }
    // Exactly, once punctuation is set aside. A partial match let a bare
    // "Star Trek" stand for The Animated Series, which is how a wrong id
    // would slip through too.
    if (fold(found.name) !== fold(expected)) {
      problems.push(`${universe.id}: ${id} is "${found.name}", expected "${expected}"`)
    }
    const released = isoDay(found.released) || firstEpisodeDay(found.videos)
    entries.push({
      id,
      type: kind === 'm' ? 'movie' : 'series',
      title: label ?? String(found.name),
      year: released.slice(0, 4) || String(found.releaseInfo ?? found.year ?? '').slice(0, 4),
      released
    })
  }
  built.push({
    id: universe.id,
    name: universe.name,
    blurb: universe.blurb,
    hasStoryOrder: Boolean(universe.story),
    entries
  })
  console.log(`${universe.name}: ${entries.length} of ${universe.entries.length}`)
}

// A film's record on the fallback host carries a year and no date, and a year
// cannot order two films that share one. Wikidata has the day.
const dateless = built.flatMap((universe) => universe.entries.filter((entry) => !entry.released))
if (dateless.length) {
  const days = await wikidataReleaseDays(dateless.map((entry) => entry.id))
  for (const entry of dateless) {
    const day = days.get(entry.id) ?? ''
    // Only a date inside the year Cinemeta gives: an earlier one is a festival
    // screening or a different cut, and the catalogue's year is the one shown.
    if (day.slice(0, 4) === entry.year) entry.released = day
    else console.warn(`No release date for ${entry.id} ${entry.title} (${entry.year})`)
  }
}

if (problems.length) {
  console.error(`\n${problems.join('\n')}\n\nNothing written.`)
  process.exit(1)
}

writeFileSync(
  OUT,
  `// GENERATED by scripts/build-universes.mjs — edit the lists there and run it,
// not this file. Titles and release dates are Cinemeta's; which titles belong
// and the order a story runs in are the script's.

import type { UniverseDefinition } from './universes'

export const UNIVERSE_DATA: UniverseDefinition[] = ${JSON.stringify(built, null, 2)}
`
)
// Formatted as the repository formats, so regenerating with nothing changed
// leaves no diff.
execSync(`npx prettier --write "${OUT}"`, { stdio: 'ignore' })
console.log(`\nWrote ${OUT}`)
