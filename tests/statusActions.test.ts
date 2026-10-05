// The quick status actions on a card — Plan to watch and Not interested —
// and what keeps them easy to take back.
//
// Pinned here: the toast each one raises carries an Undo that runs exactly
// the reversal it was given, and it goes away by itself after a few seconds
// rather than waiting to be dismissed like the whole-show Undo does
// (statusToasts.ts, notificationTtl.ts). An Undo pressed after the title
// already went back another way does nothing (toggleApplies). Removing a
// plan or a dislike offers no Undo: Plan, or Not interested, is already
// the way back.
//
// The Movies, Series and Anime grids (LibraryTile in AnimeLibraryPage.tsx)
// open the same card menu as MediaCard, on right-click and on a "..."
// button that also works from the keyboard, and a right-click does not
// also select the tile; the side panel
// can take a title off the plan without the pill's trip through watched.
// Those are read from the source: the components need the CSS-module
// build to render, and what matters is which handler each event reaches.
//
// Disliked titles are hidden from browsing unless the person switched Hide
// Disliked off (preferences.ts's hideDislikedDefault), a page can still
// show them with its own toggle, and a disliked card is marked wherever it
// is shown: MediaCard, a library tile, the detail page's More like this
// cards, the hero and the assistant's title tiles.
//
// A card acted on from Home's Recommended row, a For You rail or the hero
// keeps its slot, with its new state, until the route changes
// (heldFeed.ts): the fresh feed has the title back at its old index, the
// other entries keep their order, and the snapshot remembered for the next
// launch is the fresh answer. The library side panel keeps the title it
// was showing when that title leaves every shelf (librarySelection.ts).
//
// The phone and TV Title screen has a Not interested button beside My
// List, on the bridge's disliked:add / disliked:remove (the same preload
// api app-ui is typed against), with a one-tap Undo after a dislike.
//
// Run with: npx tsx tests/statusActions.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  dislikedToast,
  planToastAfterStatus,
  planToastAfterToggle,
  plannedToast,
  QUICK_UNDO_MS,
  toggleApplies
} from '../src/renderer/src/lib/mediaHub/statusToasts'
import { notificationTtlMs } from '../src/renderer/src/lib/notificationTtl'
import { hideDislikedDefault, logoutSettings } from '../src/main/media-hub/preferences'
import { holdEntries, holdTouchedEntries } from '../src/renderer/src/lib/mediaHub/heldFeed'
import { resolveLibrarySelection } from '../src/renderer/src/lib/mediaHub/librarySelection'
import type { HomeRail, MediaItem, Recommendation } from '../src/renderer/src/types'
import { createApi, type ApiTransport } from '../src/preload/api'
import { MEDIA_HUB_CHANNELS } from '../src/shared/media-hub/ipc-channels'
import {
  applyWatchStateFilters,
  filterStateFromSearchParams
} from '../src/renderer/src/lib/mediaHub/categoryFilters'

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

// --- undo toasts -------------------------------------------------------------

check('a plan toast names the title, is bound to the profile and undoes the plan', () => {
  let undone = 0
  const toast = plannedToast({ title: 'Dune' }, 'p1', () => undone++)
  assert.match(toast.message, /"Dune" is on your plan/)
  assert.equal(toast.profileId, 'p1')
  assert.equal(toast.action?.label, 'Undo')
  toast.action?.run()
  assert.equal(undone, 1)
})

check('a dislike toast carries an Undo that takes the dislike back', () => {
  let undone = 0
  const toast = dislikedToast({ title: 'Dune' }, true, 'p1', () => undone++)
  assert.equal(toast.action?.label, 'Undo')
  assert.equal(toast.profileId, 'p1')
  assert.match(toast.message, /won't be recommended/)
  toast.action?.run()
  assert.equal(undone, 1)
})

check('removing a dislike says so and offers no Undo', () => {
  const toast = dislikedToast({ title: 'Dune' }, false, 'p1', () => {
    throw new Error('not offered')
  })
  assert.equal(toast.action, undefined)
  assert.match(toast.message, /see "Dune" again/)
})

check('the quick Undo toasts leave by themselves; other Undo toasts still wait', () => {
  const planned = plannedToast({ title: 'Dune' }, 'p1', () => {})
  const disliked = dislikedToast({ title: 'Dune' }, true, 'p1', () => {})
  assert.equal(notificationTtlMs(planned), QUICK_UNDO_MS)
  assert.equal(notificationTtlMs(disliked), QUICK_UNDO_MS)
  // The whole-show mark's Undo names no duration and stays until used.
  assert.equal(
    notificationTtlMs({ tone: 'success', action: { label: 'Undo', run: () => {} } }),
    null
  )
  assert.ok((notificationTtlMs({ tone: 'info' }) ?? 0) > 0)
})

check('an Undo reverses only a change that is still there', () => {
  // A plain click (no target) always toggles.
  assert.equal(toggleApplies(false), true)
  assert.equal(toggleApplies(true), true)
  // An Undo names the state it restores and runs only if the title is not
  // already in it.
  assert.equal(toggleApplies(true, false), true)
  assert.equal(toggleApplies(false, false), false)
  assert.equal(toggleApplies(false, true), true)
  assert.equal(toggleApplies(true, true), false)
  // The sequence it guards: Plan, then Remove from plan from the card
  // menu, then the plan toast's Undo. The Undo must not plan it again.
  let planned = new Set<string>()
  const toggle = (id: string, to?: boolean): void => {
    if (!toggleApplies(planned.has(id), to)) return
    planned = new Set(planned)
    if (planned.has(id)) planned.delete(id)
    else planned.add(id)
  }
  toggle('dune')
  toggle('dune')
  toggle('dune', false)
  assert.equal(planned.has('dune'), false)
  // And while the plan is still there, the Undo takes it off.
  toggle('dune')
  toggle('dune', false)
  assert.equal(planned.has('dune'), false)
})

check('both toggles in AppStateContext check the Undo target before acting', () => {
  const context = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/context/AppStateContext.tsx'),
    'utf8'
  )
  assert.match(context, /if \(!toggleApplies\(myListRef\.current\.has\(media\.id\), to\)\) return/)
  assert.match(context, /if \(!toggleApplies\(prev\.has\(media\.id\), to\)\) return prev/)
  assert.match(context, /if \(planToastAfterToggle\(result\?\.tracked\)\)/)
  assert.match(context, /if \(planToastAfterStatus\(status, wasPlanned, episodes\)\)/)
})

check('the card menu raises the plan toast for a plan and not for a removal', () => {
  assert.equal(planToastAfterToggle(true), true)
  assert.equal(planToastAfterToggle(false), false)
  // No answer from the write (no bridge, or a failed call): no toast.
  assert.equal(planToastAfterToggle(undefined), false)
})

check('the status pill raises the plan toast only for a new plan', () => {
  assert.equal(planToastAfterStatus('planned', false, undefined), true)
  // Already planned: the Undo would take it somewhere it was not.
  assert.equal(planToastAfterStatus('planned', true, undefined), false)
  // Watched and not watched are not plans.
  assert.equal(planToastAfterStatus('watched', false, undefined), false)
  assert.equal(planToastAfterStatus('unwatched', true, undefined), false)
  // A replay of the whole-show Undo is not offered another.
  assert.equal(planToastAfterStatus('planned', false, []), false)
})

// --- the library grids' card menu ------------------------------------------

const libraryPage = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/src/components/category/AnimeLibraryPage.tsx'),
  'utf8'
)

/** One top-level function's source, up to the next top-level function. */
function functionSource(source: string, name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`)
  assert.ok(start >= 0, `${name} not found`)
  const rest = source.slice(start + 1)
  const end = rest.search(/\n(export )?function /)
  return end < 0 ? rest : rest.slice(0, end)
}

/** The body of the JSX handler `prop={...}` inside `source`. */
function handlerSource(source: string, prop: string): string {
  const start = source.indexOf(`${prop}={`)
  assert.ok(start >= 0, `${prop} not found`)
  let depth = 0
  for (let i = start + prop.length + 1; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`${prop} is not closed`)
}

check('a right-click on a library tile opens the card menu and does not select it', () => {
  const tile = functionSource(libraryPage, 'LibraryTile')
  const handler = handlerSource(tile, 'onContextMenu')
  assert.match(handler, /preventDefault\(\)/)
  assert.match(handler, /openContextMenu\(event\.clientX, event\.clientY, media\)/)
  assert.ok(!handler.includes('onSelect'), 'the right-click handler selects the tile')
})

check('a library tile has a "..." button that opens the menu without selecting', () => {
  const tile = functionSource(libraryPage, 'LibraryTile')
  const at = tile.indexOf('More actions for')
  assert.ok(at >= 0, 'no "..." button on the tile')
  const button = tile.slice(tile.lastIndexOf('<button', at), at)
  assert.match(button, /stopPropagation\(\)[\s\S]*openContextMenu\(/)
})

check('Enter or Space on a tile button reaches the button, and a focused button is shown', () => {
  const tile = functionSource(libraryPage, 'LibraryTile')
  const keys = handlerSource(tile, 'onKeyDown')
  // The tile's own handler steps aside for a key pressed on a child, before
  // it would cancel that key's click and select the tile.
  const guard = keys.indexOf('if (event.target !== event.currentTarget) return')
  assert.ok(guard >= 0, 'the tile handles keys pressed on its buttons')
  assert.ok(guard < keys.indexOf('onSelect(media)'))
  const css = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/components/category/AnimeLibraryPage.module.css'),
    'utf8'
  )
  assert.match(css, /\.tile:has\(\.tileOpen:focus-visible\) \.tileOpen \{\s*opacity: 1;/)
})

check('the library side panel can take a title off the plan on its own', () => {
  const panel = functionSource(libraryPage, 'LibraryDetails')
  assert.match(panel, /myList\.has\(media\.id\) &&/)
  assert.match(panel, /toggleMyList\(media, false\)[\s\S]*Remove from plan/)
})

// --- Hide Disliked on by default --------------------------------------------

check('Hide Disliked is on unless the person turned it off', () => {
  assert.equal(hideDislikedDefault({}), true)
  assert.equal(hideDislikedDefault({ hideDislikedDefault: true }), true)
  assert.equal(hideDislikedDefault({ hideDislikedDefault: false }), false)
  // Signing out keeps the choice, and keeps an unset one unset-and-on.
  assert.equal(logoutSettings({}).hideDislikedDefault, true)
  assert.equal(logoutSettings({ hideDislikedDefault: false }).hideDislikedDefault, false)
})

check('a browse page starts from the default and its own toggle can show disliked titles', () => {
  const defaults = { hideWatched: false, hideCompleted: false, hideDisliked: true }
  const fresh = filterStateFromSearchParams(new URLSearchParams(), defaults)
  assert.equal(fresh.hideDisliked, true)
  const shown = filterStateFromSearchParams(new URLSearchParams('hideDisliked=0'), defaults)
  assert.equal(shown.hideDisliked, false)
  const items = [
    { id: 'a', disliked: true },
    { id: 'b', disliked: false }
  ]
  assert.deepEqual(
    applyWatchStateFilters(items as never[], fresh).map((item: { id: string }) => item.id),
    ['b']
  )
  assert.equal(applyWatchStateFilters(items as never[], shown).length, 2)
})

check('every renderer reader of the setting falls back to on', () => {
  const root = path.resolve(__dirname, '../src/renderer/src')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) {
        if (/hideDislikedDefault \?\? false/.test(fs.readFileSync(full, 'utf8')))
          offenders.push(full)
      }
    }
  }
  walk(root)
  assert.deepEqual(offenders, [])
})

check('a disliked card is marked on MediaCard and on a library tile', () => {
  const card = fs.readFileSync(
    path.resolve(
      __dirname,
      '../src/renderer/src/components/home/RecommendationCarousel/MediaCard.tsx'
    ),
    'utf8'
  )
  assert.match(card, /const disliked = dislikedIds\.has\(media\.id\)/)
  assert.match(card, /disliked \? styles\.cardDisliked/)
  assert.match(card, /\{disliked && \([\s\S]*?Not interested/)
  const tile = functionSource(libraryPage, 'LibraryTile')
  assert.match(tile, /const disliked = dislikedIds\.has\(media\.id\)/)
  assert.match(tile, /disliked \? styles\.tileDisliked/)
  assert.match(tile, /\{disliked && \([\s\S]*?Not interested/)
})

check('a disliked title is marked on the More like this cards, the hero and the AI tiles', () => {
  const read = (file: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../src/renderer/src', file), 'utf8')
  const similar = read('components/detail/SimilarPanel.tsx')
  assert.match(similar, /const disliked = dislikedIds\.has\(item\.id\)/)
  assert.match(similar, /disliked \? styles\.cardItemDisliked/)
  assert.match(similar, /\{disliked && \([\s\S]*?Not interested/)
  // The hero: a title disliked from Home stays there until the page is left.
  const hero = read('components/home/FeaturedHero/FeaturedMetadata.tsx')
  assert.match(hero, /const disliked = dislikedIds\.has\(item\.id\)/)
  assert.match(hero, /\{disliked && \([\s\S]*?Not interested/)
  const ai = read('components/overlays/AIResponsePanel.tsx')
  assert.equal(ai.match(/disliked=\{dislikedIds\.has\(media\.id\)\}/g)?.length, 2)
  assert.match(ai, /disliked \? styles\.aiTileDisliked/)
})

// --- a card acted on keeps its slot -----------------------------------------

const ids = (list: readonly { id: string }[]): string[] => list.map((entry) => entry.id)
const same = (entry: { id: string }) => entry

check('a held title goes back to the index it had, the rest keep their order', () => {
  const previous = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  const next = ['a', 'c', 'd', 'e'].map((id) => ({ id }))
  const held = new Set(['b'])
  assert.deepEqual(ids(holdEntries(previous, next, held, (x) => x.id, same)), [
    'a',
    'b',
    'c',
    'd',
    'e'
  ])
})

check('several held titles, the first one included, each land at their old index', () => {
  const previous = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const next = ['c', 'e', 'f'].map((id) => ({ id }))
  const held = new Set(['a', 'b', 'd'])
  assert.deepEqual(ids(holdEntries(previous, next, held, (x) => x.id, same)), [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f'
  ])
})

check('a held title still in the fresh feed takes its old slot with the fresh copy', () => {
  const previous = [
    { id: 'a', v: 1 },
    { id: 'b', v: 1 }
  ]
  const next = [
    { id: 'b', v: 2 },
    { id: 'a', v: 2 }
  ]
  const result = holdEntries(previous, next, new Set(['a']), (x) => x.id, same)
  assert.deepEqual(result, [
    { id: 'a', v: 2 },
    { id: 'b', v: 2 }
  ])
})

check('a held id that was not on screen is left where the fresh feed put it', () => {
  const previous = [{ id: 'a' }]
  const next = [{ id: 'b' }, { id: 'z' }]
  assert.deepEqual(ids(holdEntries(previous, next, new Set(['z']), (x) => x.id, same)), ['b', 'z'])
})

function media(id: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { id, title: id, mediaType: 'movie', ...extra } as MediaItem
}
function rec(id: string, extra: Partial<MediaItem> = {}): Recommendation {
  return { media: media(id, extra), reasons: [] } as unknown as Recommendation
}

check('the recommendations, the hero pool and the rails all hold the title', () => {
  const previous = {
    recommendations: [rec('a'), rec('b'), rec('c')],
    featured: [media('a'), media('b'), media('c')],
    rails: [{ id: 'genre:x', title: 'X', items: [media('b'), media('c')] }] as HomeRail[]
  }
  const next = {
    recommendations: [rec('a'), rec('c')],
    featured: [media('a'), media('c')],
    rails: [{ id: 'genre:x', title: 'X', items: [media('c')] }] as HomeRail[],
    preferredGenres: []
  }
  const held = new Map([['b', { watched: true, completed: true }]])
  const result = holdTouchedEntries(previous, next, held, new Set(['b']))
  assert.deepEqual(
    result.recommendations.map((r) => r.media.id),
    ['a', 'b', 'c']
  )
  assert.deepEqual(ids(result.featured), ['a', 'b', 'c'])
  assert.deepEqual(ids(result.rails[0].items), ['b', 'c'])
  // The held copy carries the change and the fresh plan state.
  const held0 = result.recommendations[1].media
  assert.equal(held0.completed, true)
  assert.equal(held0.watched, true)
  assert.equal(held0.inMyList, true)
  assert.equal(result.featured[1].completed, true)
  // Other fields of the fresh feed come through untouched.
  assert.deepEqual(result.preferredGenres, [])
})

check('with nothing held the fresh feed is returned as it is', () => {
  const next = { recommendations: [rec('a')], featured: [media('a')], rails: [] as HomeRail[] }
  const previous = {
    recommendations: [rec('b')],
    featured: [media('b')],
    rails: [] as HomeRail[]
  }
  assert.equal(holdTouchedEntries(previous, next, new Map(), new Set()), next)
})

const hooksSource = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/src/lib/mediaHub/hooks.ts'),
  'utf8'
)
const contextSource = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/src/context/AppStateContext.tsx'),
  'utf8'
)

check('the home feed holds only within one library, and remembers the fresh answer', () => {
  assert.match(hooksSource, /previous && sameLibrary && heldNow\.size > 0/)
  assert.match(hooksSource, /holdTouchedEntries\(previous, next, heldNow, trackedIds\)/)
  assert.match(hooksSource, /rememberHomeFeed\(\{\s*featured: next\.featured,/)
})

check('the status actions hold the title, and a route change lets it go and refetches', () => {
  for (const name of ['toggleMyList', 'toggleDisliked', 'setTitleStatus']) {
    const start = contextSource.indexOf(`const ${name} = useCallback(`)
    assert.ok(start >= 0, `${name} not found`)
    const body = contextSource.slice(start, contextSource.indexOf('\n  )\n', start))
    assert.match(body, /holdInFeed\(/, `${name} does not hold the title`)
  }
  assert.match(
    contextSource,
    /heldFeedRef\.current\.clear\(\)\s*refreshHomeFeedForHeld\(\)\s*\}, \[location\.pathname,/
  )
})

// --- the library side panel keeps its title ----------------------------------

check('the side panel keeps the selected title after it leaves every shelf', () => {
  const hero = media('hero')
  const picked = media('picked', { inMyList: false })
  const fresh = media('picked', { inMyList: true })
  assert.equal(resolveLibrarySelection([[hero, fresh]], picked, hero), fresh)
  assert.equal(resolveLibrarySelection([[hero]], picked, hero), picked)
  assert.equal(resolveLibrarySelection([[hero]], null, hero), hero)
})

// --- the phone's Not interested ---------------------------------------------

check('the api app-ui is typed against reaches the disliked channels', () => {
  const calls: { channel: string; args: unknown[] }[] = []
  const transport: ApiTransport = {
    invoke: <T>(channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      return Promise.resolve(undefined as T)
    },
    on: () => () => {},
    send: () => {}
  }
  const api = createApi(transport).mediaHub
  const item = { id: 'tt1', type: 'movie', title: 'Dune' } as Parameters<typeof api.disliked.add>[0]
  void api.disliked.add(item)
  void api.disliked.remove('tt1')
  void api.disliked.list()
  assert.deepEqual(
    calls.map((call) => call.channel),
    [
      MEDIA_HUB_CHANNELS.dislikedAdd,
      MEDIA_HUB_CHANNELS.dislikedRemove,
      MEDIA_HUB_CHANNELS.dislikedList
    ]
  )
  assert.deepEqual(calls[1].args, [{ id: 'tt1' }])
})

check('the phone Title screen sets and takes back Not interested, with an Undo', () => {
  const title = fs.readFileSync(path.resolve(__dirname, '../src/app-ui/screens/Title.tsx'), 'utf8')
  assert.match(title, /mediaHub\.disliked\.add\(item\)/)
  assert.match(title, /mediaHub\.disliked\.remove\(item\.id\)/)
  const button = title.slice(title.indexOf('title-screen__dislike'))
  assert.match(button, /onClick=\{\(\) => setDisliked\(!isDisliked\)\}/)
  assert.match(button, /setDisliked\(false\)\}>\s*Undo/)
})

console.log(`\n${pass} passed`)
