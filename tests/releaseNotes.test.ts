import assert from 'node:assert/strict'
import { clampNotes, RELEASE_NOTES_MAX_CHARS } from '../src/main/media-hub/releaseNotes'

async function main(): Promise<void> {
  const { formatNotes, selectSubjects, MAX_CHARS } = await import('../scripts/release-notes.mjs')

  // The app's reader and the workflow's writer must agree on the budget, or
  // the card silently truncates notes the release considered complete.
  assert.equal(MAX_CHARS, RELEASE_NOTES_MAX_CHARS, 'writer and reader caps must match')

  // --- what counts as a change worth reading about ------------------------
  assert.deepEqual(
    selectSubjects([
      'Merge pull request #12 from x/y',
      'Add a thing (#41)',
      'ci: pin an action',
      '1.0.84',
      'Fix a bug'
    ]),
    ['Add a thing', 'Fix a bug'],
    'release plumbing is not a change; the PR number is stripped for display'
  )

  assert.deepEqual(
    selectSubjects(['Fix a bug', 'Reviewed change (#7)']),
    ['Reviewed change', 'Fix a bug'],
    'reviewed PR subjects lead'
  )

  assert.deepEqual(selectSubjects(['Same thing', 'same thing']), ['Same thing'], 'deduped')

  // --- the cap holds, on whole bullets ------------------------------------
  const many = Array.from({ length: 40 }, (_, i) => `Change number ${i} that is fairly wordy`)
  const capped = formatNotes(many)
  assert.ok(capped.length <= MAX_CHARS, `formatted note is ${capped.length} chars`)
  assert.ok(/…and \d+ more changes\.$/.test(capped), 'says what it left out')
  for (const line of capped.split('\n')) {
    if (line.startsWith('•')) {
      assert.ok(many.includes(line.slice(2)), `bullet must be a whole subject: ${line}`)
    }
  }

  // --- one subject longer than the entire budget --------------------------
  const huge = formatNotes(['x'.repeat(50) + ' ' + 'y'.repeat(600)])
  assert.ok(huge.length <= MAX_CHARS, 'an oversized single subject is still capped')
  assert.ok(huge.endsWith('…'), 'and is marked as trimmed')

  // --- nothing to say is empty, not a heading with no content -------------
  assert.equal(formatNotes([]), '')
  assert.equal(formatNotes(['ci: only plumbing', 'Merge branch main']), '')

  // --- the reader's own clamp --------------------------------------------
  assert.equal(clampNotes('  hello\r\nworld  '), 'hello\nworld', 'normalizes and trims')
  const long = clampNotes('word '.repeat(400))
  assert.ok(long.length <= RELEASE_NOTES_MAX_CHARS + 1, 'reader clamps too')
  assert.ok(long.endsWith('…'))
  assert.ok(!long.slice(0, -1).endsWith(' '), 'no trailing space before the ellipsis')

  console.log('ok  release notes')
}

void main()
