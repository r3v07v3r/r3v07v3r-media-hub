// The quick status actions on a card — Plan to watch and Not interested —
// and what keeps them easy to take back.
//
// Pinned here: the toast each one raises carries an Undo that runs exactly
// the reversal it was given, and it goes away by itself after a few seconds
// rather than waiting to be dismissed like the whole-show Undo does
// (statusToasts.ts, OverlayContext's notificationTtlMs). Removing a dislike
// offers no Undo: it is already the way back.
//
// The Movies, Series and Anime grids (LibraryTile in AnimeLibraryPage.tsx)
// open the same card menu as MediaCard, on right-click and on a "..."
// button, and a right-click does not also select the tile; the side panel
// can take a title off the plan without the pill's trip through watched.
// Those are read from the source: the components need the CSS-module
// build to render, and what matters is which handler each event reaches.
//
// Run with: npx tsx tests/statusActions.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  dislikedToast,
  plannedToast,
  QUICK_UNDO_MS
} from '../src/renderer/src/lib/mediaHub/statusToasts'
import { notificationTtlMs } from '../src/renderer/src/context/OverlayContext'

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

check('the library side panel can take a title off the plan on its own', () => {
  const panel = functionSource(libraryPage, 'LibraryDetails')
  assert.match(panel, /myList\.has\(media\.id\) &&/)
  assert.match(panel, /toggleMyList\(media, false\)[\s\S]*Remove from plan/)
})

console.log(`\n${pass} passed`)
