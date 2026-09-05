// Builds the short "what changed" note that both the GitHub release body and
// the app's About card show.
//
// Sourced from the commit subjects since the previous release tag, because
// that is the one description of a change that already exists and is already
// written for a human — a squash-merged PR's subject IS its title. Nothing
// here invents a summary; it selects and trims.
//
// The 500-character cap is the product constraint, not a formatting detail:
// the About card is a summary, not a changelog, and a release that touched
// forty files still has to fit in a paragraph somebody will actually read.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const MAX_CHARS = 500

/** Subjects that describe the release process rather than the release. */
const NOISE =
  /^(merge (branch|pull request|remote)|revert "|bump version|v?\d+\.\d+\.\d+$|ci:|chore\(release\)|chore: release)/i

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * The tag this release's notes should start after.
 *
 * Deliberately the previous tag reachable from HEAD rather than the newest
 * tag in the repo: a Preview build cut while a Stable promotion is in flight
 * must not describe itself as containing everything since a tag on another
 * branch.
 */
export function previousTag() {
  return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD^'])
}

/** A squash-merged PR keeps its number in the subject; strip it for display
 *  but use its presence as a signal the line was a real, reviewed change. */
function clean(subject) {
  return subject.replace(/\s*\(#\d+\)\s*$/, '').trim()
}

export function selectSubjects(subjects) {
  const seen = new Set()
  const kept = []
  // PR-numbered subjects first: they are the reviewed units of change, and on
  // a busy release they are what somebody wants to read about.
  const ordered = [
    ...subjects.filter((s) => /\(#\d+\)\s*$/.test(s)),
    ...subjects.filter((s) => !/\(#\d+\)\s*$/.test(s))
  ]
  for (const subject of ordered) {
    if (NOISE.test(subject)) continue
    const text = clean(subject)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(text)
  }
  return kept
}

/**
 * Formats to at most MAX_CHARS, whole bullets only.
 *
 * A truncated final bullet reads as a bug, so a line that will not fit is
 * dropped and the count of what was left out is reported instead — which is
 * also the honest thing to show: the note says it is a summary.
 */
export function formatNotes(subjects) {
  const kept = selectSubjects(subjects)
  if (!kept.length) return ''

  const lines = []
  let used = 0
  let dropped = 0
  for (const subject of kept) {
    const line = `• ${subject}`
    // +1 for the newline this line will need once it is not the first.
    const cost = line.length + (lines.length ? 1 : 0)
    // Leave room for the "and N more" tail if anything is going to be cut.
    const tailRoom = 24
    if (used + cost > MAX_CHARS - (kept.length > lines.length + 1 ? tailRoom : 0)) {
      dropped = kept.length - lines.length
      break
    }
    lines.push(line)
    used += cost
  }

  if (!lines.length) {
    // A single subject longer than the whole budget: trim that one on a word
    // boundary rather than emitting nothing.
    // Budget the bullet prefix and the ellipsis explicitly: '• ' is two
    // characters and '…' is one, so the subject itself gets MAX_CHARS - 3.
    const only = kept[0].slice(0, MAX_CHARS - 3)
    const at = only.lastIndexOf(' ')
    const trimmed = (at > MAX_CHARS * 0.5 ? only.slice(0, at) : only).trimEnd()
    return `• ${trimmed}…`
  }
  if (dropped > 0) lines.push(`…and ${dropped} more change${dropped === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

export function buildNotes() {
  const from = previousTag()
  const range = from ? `${from}..HEAD` : 'HEAD'
  const log = git(['log', range, '--no-merges', '--pretty=%s'])
  return formatNotes(log ? log.split('\n') : [])
}

// Written into resources/ BEFORE electron-builder runs, so the note ships
// inside the build it describes — see main/media-hub/releaseNotes.ts for why
// that matters (offline, first launch, no API call per Settings visit).
function main() {
  const notes = buildNotes()
  const out = path.join(process.cwd(), 'resources', 'release-notes.txt')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, notes ? `${notes}\n` : '', 'utf8')
  process.stdout.write(notes)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main()
