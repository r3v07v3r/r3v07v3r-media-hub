// The requires-setup rule (2026-11-08): nothing is switched on, or offered,
// when the service it needs is not set up, unless it says so and offers the
// way there. Held against the source here:
//
// - every place lib/setupPlaces.ts sends a Set up button to exists: its
//   heading id is rendered somewhere in the renderer, and its section is a
//   control centre section;
// - missingServices() names nothing until readiness has loaded, nothing
//   when any one of an "any" set is ready, and every missing one otherwise;
// - <RequiresSetup> draws one button per service, each opening the control
//   centre at that service's section and heading;
// - the switches that used to read On while inert (scrobbling, two-way
//   watchlist sync, automatic subtitles) carry the notice.
//
// React components with CSS modules cannot load in node, so the component
// checks read the files; the hook module loads (its React and context
// imports are not called at import time), so missingServices is the real one.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { ServiceReadiness } from '../src/renderer/src/hooks/useServiceReadiness'

let pass = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const RENDERER = path.resolve(__dirname, '../src/renderer/src')
const read = (file: string): string => fs.readFileSync(path.join(RENDERER, file), 'utf8')

/** Every .ts/.tsx file under the renderer, as text. */
function rendererSources(dir = RENDERER): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...rendererSources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'))
  }
  return out
}

const places = read('lib/setupPlaces.ts')
const anchors = [...places.matchAll(/anchor: '([^']+)'/g)].map((match) => match[1])
const sections = [...places.matchAll(/section: '([^']+)'/g)].map((match) => match[1])

const NONE: ServiceReadiness = {
  loaded: true,
  torbox: false,
  mediaServer: false,
  source: false,
  tmdb: false,
  omdb: false,
  subdl: false,
  opensubtitles: false,
  subtitles: false,
  ollama: false,
  relay: false,
  simkl: false,
  trakt: false,
  mal: false,
  tracker: false,
  lanCache: false,
  anime4k: false
}

async function main(): Promise<void> {
  await check('every Set up anchor is a heading id the renderer draws', () => {
    assert.ok(anchors.length >= 10, `found ${anchors.length} anchors in setupPlaces.ts`)
    const sources = rendererSources()
    const missing = anchors.filter(
      // A heading draws it as id="…", or a row takes it as titleId="…" and
      // puts it on its title span (SettingsPage's ActionRow).
      (anchor) =>
        !sources.some(
          (source) => source.includes(`id="${anchor}"`) || source.includes(`Id="${anchor}"`)
        )
    )
    assert.deepEqual(missing, [], `anchors with no id="…" in src/renderer/src: ${missing}`)
  })

  await check('every Set up section is a control centre section', () => {
    const ids = new Set(
      [...read('components/controlcentre/sections.ts').matchAll(/id: '([^']+)'/g)].map(
        (match) => match[1]
      )
    )
    assert.ok(ids.size > 0, 'sections.ts lists its ids')
    assert.ok(sections.length >= 10, `found ${sections.length} sections in setupPlaces.ts`)
    const unknown = sections.filter((section) => !ids.has(section))
    assert.deepEqual(unknown, [], `sections not in sections.ts: ${unknown}`)
  })

  const { missingServices } = await import('../src/renderer/src/hooks/useServiceReadiness')

  await check('missingServices names nothing before readiness has loaded', () => {
    assert.deepEqual(missingServices({ ...NONE, loaded: false }, ['simkl', 'trakt']), [])
    assert.deepEqual(missingServices({ ...NONE, loaded: false }, ['tmdb'], 'all'), [])
  })

  await check('any mode: nothing missing once one of the set is ready', () => {
    assert.deepEqual(missingServices({ ...NONE, trakt: true }, ['simkl', 'trakt']), [])
    assert.deepEqual(missingServices(NONE, ['simkl', 'trakt']), ['simkl', 'trakt'])
    assert.deepEqual(missingServices(NONE, ['subdl', 'opensubtitles']), ['subdl', 'opensubtitles'])
  })

  await check('all mode: names each one that is not ready', () => {
    assert.deepEqual(missingServices({ ...NONE, torbox: true }, ['torbox', 'tmdb'], 'all'), [
      'tmdb'
    ])
    assert.deepEqual(
      missingServices({ ...NONE, torbox: true, tmdb: true }, ['torbox', 'tmdb'], 'all'),
      []
    )
  })

  await check('RequiresSetup draws one Set up button per service, to its place', () => {
    const component = read('components/layout/RequiresSetup.tsx')
    assert.match(component, /if \(services\.length === 0\) return null/)
    // The verb may agree with a plural subject; the sentence's shape stays.
    assert.match(component, /requires'?\}? \$\{nameServices\(services\)\} to be set up\./)
    assert.match(
      component,
      /services\.map\(\(service\) => \{\s*const place = SETUP_PLACES\[service\][\s\S]*?<button[\s\S]*?key=\{service\}/
    )
    assert.match(
      component,
      /onClick=\{\(\) => openControlCentre\(place\.section, place\.anchor\)\}/
    )
    assert.match(component, />\s*Set up \{place\.name/)
  })

  await check('scrobbling, two-way sync and Sync now each carry their notice', () => {
    const section = read('components/settings/WatchlistSyncSection.tsx')
    for (const what of ['Scrobbling', 'Keeping watchlists in sync', 'Syncing watchlists']) {
      assert.ok(section.includes(`what="${what}"`), `a notice for "${what}"`)
    }
  })

  await check('the automatic subtitles switch carries the notice', () => {
    // Pinned to its own subject: the page has other notices, and any one of
    // them would otherwise stand in for this switch.
    assert.match(read('routes/SettingsPage.tsx'), /what="Automatic subtitles"/)
  })

  await check('every anchored Set up button lands in the section its heading is in', () => {
    // A heading's section is the settings category its component is rendered
    // under in SettingsPage (`{shows('accounts') && (` ... up to the next
    // shows), mapped back to a rail entry by sections.ts.
    const settingsPage = read('routes/SettingsPage.tsx')
    const serviceSections = read('routes/MediaHubSettingsSections.tsx')
    const railFor = new Map<string, string>()
    const mapText = read('components/controlcentre/sections.ts').split('SETTINGS_CATEGORY_FOR')[1]
    for (const match of mapText.matchAll(/'?([a-z-]+)'?: '([a-z]+)'/g))
      railFor.set(match[2], match[1])
    const blocks: Array<{ category: string; text: string }> = []
    const starts = [...settingsPage.matchAll(/\{shows\('([a-z]+)'\) && \(/g)]
    starts.forEach((start, index) => {
      const end = starts[index + 1]?.index ?? settingsPage.length
      blocks.push({ category: start[1], text: settingsPage.slice(start.index, end) })
    })
    assert.ok(blocks.length >= 6, `found ${blocks.length} settings categories`)
    // component name -> heading id, from the service sections file.
    const componentFor = new Map<string, string>()
    for (const match of serviceSections.matchAll(
      /export function (\w+)\(\)[\s\S]*?id="(settings-[a-z-]+)"/g
    )) {
      componentFor.set(match[2], match[1])
    }
    const placeEntries = [...places.matchAll(/section: '([a-z-]+)',\s*anchor: '([a-z-]+)'/g)].map(
      (match) => ({ section: match[1], anchor: match[2] })
    )
    assert.ok(placeEntries.length >= 10, `found ${placeEntries.length} anchored places`)
    const wrong: string[] = []
    for (const { section, anchor } of placeEntries) {
      const component = componentFor.get(anchor)
      const needle = component ? `<${component} />` : `"${anchor}"`
      const host = blocks.find((block) => block.text.includes(needle))
      if (!host) continue // drawn outside SettingsPage (the Caching section)
      const expected = railFor.get(host.category) ?? host.category
      if (expected !== section)
        wrong.push(`${anchor}: setupPlaces says ${section}, drawn in ${expected}`)
    }
    assert.deepEqual(wrong, [], wrong.join('; '))
  })

  console.log(`\n${pass} passed`)
}

void main()
