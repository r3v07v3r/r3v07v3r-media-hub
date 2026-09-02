// What changed in this build, as a short human-readable note.
//
// WHY A FILE RATHER THAN A FETCH. The About card should be able to say what
// this version changed while offline, on first launch, and without spending a
// GitHub API call every time Settings opens. The release workflow writes the
// note into resources/ before electron-builder runs, so the answer ships
// inside the build that it describes and can never disagree with it.
//
// Absent is a normal state, not an error: a developer build, a `npm run dev`
// run, and any build made outside the release workflow all have no note. Every
// path here degrades to '' so the card simply renders nothing.

import fs from 'node:fs'
import path from 'node:path'

/** Hard ceiling. The card is a summary, not a changelog — a release that
 *  writes more than this is truncated rather than allowed to push the rest of
 *  the Settings page around. Matches the cap the workflow already applies, so
 *  this is a backstop against a hand-edited file rather than the usual path. */
export const RELEASE_NOTES_MAX_CHARS = 500

const FILE = 'release-notes.txt'

function candidates(): string[] {
  return [
    // Packaged: electron-builder's extraResources drop, beside mpv.
    path.join(process.resourcesPath || '', FILE),
    // Packaged fallback: the asarUnpack'd copy of resources/.
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'resources', FILE),
    // Dev run, where process.resourcesPath points into electron's own bundle.
    path.join(process.cwd(), 'resources', FILE)
  ]
}

/** Trims to the cap on a word boundary so the note never ends mid-word. */
export function clampNotes(value: string): string {
  const text = value.replace(/\r\n/g, '\n').trim()
  if (text.length <= RELEASE_NOTES_MAX_CHARS) return text
  const cut = text.slice(0, RELEASE_NOTES_MAX_CHARS)
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'))
  return `${(lastBreak > RELEASE_NOTES_MAX_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`
}

let cached: string | null = null

/** The note for the running version, or '' when this build shipped without
 *  one. Read once — the file cannot change while the app is running. */
export function currentReleaseNotes(): string {
  if (cached !== null) return cached
  for (const file of candidates()) {
    try {
      if (!fs.existsSync(file)) continue
      const text = clampNotes(fs.readFileSync(file, 'utf8'))
      if (text) {
        cached = text
        return cached
      }
    } catch {
      // An unreadable note is the same as an absent one — try the next path.
    }
  }
  cached = ''
  return cached
}
