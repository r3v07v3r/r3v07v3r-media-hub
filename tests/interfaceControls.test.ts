// Interface controls the 2026-10 audit found doing nothing, or saying the
// wrong thing, held against their source.
//
// These are React components with CSS modules, which node cannot load, so
// the checks read the files the way statusActions.test.ts reads MediaCard:
// each one pins the line that was wrong and the shape of its replacement.
//
// - Save view and Rename this list named things with window.prompt, which
//   Electron's renderer does not implement (it throws), so neither saved
//   anything in the desktop app. Both are inline fields now: Enter and
//   leaving the field save, as + New list's field does, Escape cancels, an
//   empty name is ignored.
// - The Watch Party Queue tab could never receive a title, so it is hidden
//   behind one constant until a way to suggest a title returns.
// - Sharing the TorBox key with a cache server starts unticked.
// - A film marked Not interested is dimmed and named in Rest of the series,
//   and a title so marked in the library page's hero and Similar list.
// - The host's local-network hint names the relay's real place and no port.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

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

const read = (file: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../src/renderer/src', file), 'utf8')

check('Save view names the view in an inline field, not window.prompt', () => {
  const bar = read('components/category/CategoryFilterBar.tsx')
  // The comment beside the field still names window.prompt; a call must not.
  assert.doesNotMatch(bar, /window\.prompt\(/)
  // Save view opens the field rather than saving straight away. The `>` may
  // sit on its own line once prettier wraps the button's attributes.
  assert.match(bar, /onClick=\{\(\) => setViewName\(''\)\}\s*>\s*Save view/)
  // Enter submits the form and leaving the field saves the same way, as the
  // + New list field does; Escape closes the field without saving. (React
  // drops the blur the input's removal fires during a commit, so neither
  // Enter nor Escape is followed by a second save.)
  assert.match(bar, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\)\s*submitViewName\(\)/)
  assert.match(bar, /onBlur=\{submitViewName\}/)
  assert.match(bar, /event\.key === 'Escape'\) setViewName\(null\)/)
  // Clearing the filters some other way (Back) closes the field too, so a
  // stale draft cannot reopen over the next filter picked.
  assert.match(bar, /if \(!hasActiveFilter && viewName !== null\) setViewName\(null\)/)
  // An empty name saves nothing; anything else goes down the same path as
  // before, trimmed.
  assert.match(
    bar,
    /const name = viewName\?\.trim\(\)\s*setViewName\(null\)[\s\S]*?if \(name\) void saveCurrentFilter\(name\)/
  )
})

check('Rename this list uses an inline field, not window.prompt', () => {
  const page = read('routes/MyStuffPage.tsx')
  assert.doesNotMatch(page, /window\.prompt\(/)
  // Opened for the selected list, prefilled with its current name, however
  // prettier wraps the object.
  assert.match(
    page,
    /onClick=\{\(\) =>\s*setRenaming\(\{\s*listId: selectedList\.id,\s*draft: selectedList\.name,?\s*\}\)\s*\}/
  )
  // Only drawn for the list it was opened for, so a switch mid-edit cannot
  // rename a different one.
  assert.match(page, /renaming\?\.listId === selectedList\.id \?/)
  // Leaving the field renames, like the + New list field beside it creates;
  // Escape cancels.
  assert.match(page, /onBlur=\{submitRename\}/)
  assert.match(page, /onBlur=\{\(\) => void submitName\(\)\}/)
  assert.match(page, /event\.key === 'Escape'\) setRenaming\(null\)/)
  assert.match(
    page,
    /const name = renaming\.draft\.trim\(\)\s*setRenaming\(null\)[\s\S]*?if \(name\) void rename\(renaming\.listId, name\)/
  )
})

check('the Watch Party Queue tab is hidden behind one constant', () => {
  const hub = read('components/party/SessionHub.tsx')
  assert.match(hub, /const QUEUE_TAB_ENABLED = false/)
  // Left out of the tab list, and its panel cannot render either.
  assert.match(hub, /\.filter\(\(\[key\]\) => key !== 'queue' \|\| QUEUE_TAB_ENABLED\)/)
  assert.match(hub, /\{QUEUE_TAB_ENABLED && tab === 'queue' && \(/)
  // The party opens on Chat, never on the hidden tab.
  assert.match(hub, /useState<PartyTab>\('chat'\)/)
})

check("the host's hint names Control centre, Community and no port", () => {
  const hub = read('components/party/SessionHub.tsx')
  assert.doesNotMatch(hub, /Forward TCP/)
  assert.match(
    hub,
    /'Local network only\. Connect R3 Party Sync under Control centre → Community for guests outside it\.'/
  )
})

check('sharing the TorBox key with a cache server starts unticked', () => {
  const caching = read('components/controlcentre/sections/CachingSection.tsx')
  assert.match(caching, /const \[shareTorbox, setShareTorbox\] = useState\(false\)/)
  // Nothing else ticks it: the only writer is the checkbox itself.
  const writes = caching.match(/setShareTorbox\(/g) ?? []
  assert.equal(writes.length, 1, 'only the checkbox sets the TorBox opt-in')
  assert.match(caching, /onChange=\{\(event\) => setShareTorbox\(event\.target\.checked\)\}/)
})

check('Rest of the series dims and names a film marked Not interested', () => {
  const panel = read('components/detail/CollectionPanel.tsx')
  assert.match(panel, /const disliked = dislikedIds\.has\(item\.id\)/)
  assert.match(panel, /disliked \? styles\.entryDisliked : ''/)
  assert.match(panel, /\{disliked && \([\s\S]*?Not interested/)
  const css = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/components/detail/CollectionPanel.module.css'),
    'utf8'
  )
  // The same dimming MediaCard applies to its art.
  assert.match(
    css,
    /\.entryDisliked \.artImage \{\s*filter: grayscale\(0\.85\) brightness\(0\.6\);/
  )
})

check('the library hero and Similar list dim and name a title marked Not interested', () => {
  const page = read('components/category/AnimeLibraryPage.tsx').replace(/\r\n/g, '\n')
  const similar = page.slice(
    page.indexOf('function LibrarySimilar('),
    page.indexOf('export function LibraryPage(')
  )
  assert.match(similar, /const \{ dislikedIds \} = useAppState\(\)/)
  assert.match(similar, /const disliked = dislikedIds\.has\(item\.id\)/)
  assert.match(similar, /disliked \? styles\.similarRowDisliked : ''/)
  assert.match(similar, /\{disliked && \([\s\S]*?thumbs-down[\s\S]*?Not interested/)
  const hero = page.slice(page.indexOf('export function LibraryPage('))
  assert.match(
    hero,
    /const heroDisliked = activeHero \? dislikedIds\.has\(activeHero\.id\) : false/
  )
  assert.match(hero, /heroDisliked \? styles\.heroDisliked : ''/)
  assert.match(hero, /heroDisliked \? ', not interested' : ''/)
  assert.match(hero, /\{heroDisliked && \([\s\S]*?thumbs-down[\s\S]*?Not interested/)
  const css = read('components/category/AnimeLibraryPage.module.css')
  for (const rule of ['.heroDisliked .heroArtwork', '.similarRowDisliked .similarThumb']) {
    const at = css.indexOf(`${rule} {`)
    assert.ok(at >= 0, `${rule} is styled`)
    assert.match(css.slice(at), /^[^}]*filter: grayscale\(0\.85\) brightness\(0\.6\);/)
  }
})

console.log(`\n${pass} passed`)
