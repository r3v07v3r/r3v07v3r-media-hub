// Unit tests for the download blocklist (src/shared/media-hub/unsafeFiles.ts).
// Run with: npx tsx tests/unsafeFiles.test.ts   (or npm.cmd test)
//
// This file is deliberately outside both tsconfig include globs so it does
// not pull node type definitions into the renderer project. It is a real
// test, not a scratch script: the evasion cases below (trailing dots,
// RTL override, double extensions) are the whole reason the matcher is
// more than a string compare, and they are easy to break by "simplifying".

import assert from 'node:assert'
import {
  blockedFilesIn,
  blockedReason,
  effectiveExtension,
  isBlockedFilename,
  isBlockedMimeType,
  releaseTextMentionsExecutable
} from '../src/shared/media-hub/unsafeFiles'

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
const blocks = (n: string) => assert.equal(isBlockedFilename(n), true, `should block ${n}`)
const allows = (n: string) => assert.equal(isBlockedFilename(n), false, `should allow ${n}`)

console.log('blocks the obvious')
check('.exe', () => blocks('setup.exe'))
check('.msi', () => blocks('installer.msi'))
check('.bat', () => blocks('run.bat'))
check('.scr', () => blocks('Movie.scr'))
check('.jar', () => blocks('payload.jar'))
check('.iso', () => blocks('disc.iso'))
check('.lnk', () => blocks('Watch Movie.lnk'))
check('.hta', () => blocks('page.hta'))

console.log('\nallows real media')
check('.mkv', () => allows('Movie.2024.1080p.mkv'))
check('.mp4', () => allows('episode.mp4'))
check('.srt', () => allows('subs.srt'))
check('.vtt', () => allows('subs.vtt'))
check('no extension', () => allows('README'))
check('dot-leading only', () => allows('.gitignore'))

console.log('\nevasion')
check('double extension .mp4.exe', () => blocks('Movie.2024.1080p.mp4.exe'))
check('uppercase .EXE', () => blocks('SETUP.EXE'))
check('mixed case .ExE', () => blocks('Setup.ExE'))
check('trailing dot (Windows strips it)', () => blocks('payload.exe.'))
check('trailing space (Windows strips it)', () => blocks('payload.exe '))
check('trailing dots and spaces', () => blocks('payload.exe. . '))
check('RTL override hiding the real extension', () => {
  // Renders to a human as "Moviexemp4.mkv"-ish; the OS still sees .exe
  blocks('Movie\u202Evkm.exe')
})
check('zero-width space padding', () => blocks('Movie\u200B.exe'))
check('path is reduced to its basename', () => blocks('Some.Movie.2024/Subs/install.exe'))
check('windows path separators too', () => blocks('C:\\downloads\\Movie\\setup.exe'))
check('a DIRECTORY named .exe does not condemn its media', () =>
  allows('Movie.exe/film.mkv')
)
check('.exe in the middle is not the effective extension', () => allows('Movie.exe.mkv'))

console.log('\neffectiveExtension')
check('reads the last extension', () =>
  assert.equal(effectiveExtension('a.b.c.mkv'), 'mkv')
)
check('empty when none', () => assert.equal(effectiveExtension('plainfile'), ''))
check('empty on a trailing dot only', () => assert.equal(effectiveExtension('weird.'), ''))

console.log('\nmime types')
check('blocks x-msdownload', () => assert.equal(isBlockedMimeType('application/x-msdownload'), true))
check('blocks with charset suffix', () =>
  assert.equal(isBlockedMimeType('application/x-msdownload; charset=binary'), true)
)
check('allows video/mp4', () => assert.equal(isBlockedMimeType('video/mp4'), false))
check('allows empty', () => assert.equal(isBlockedMimeType(''), false))

console.log('\nreasons and listing')
check('reason names the extension', () => {
  const r = blockedReason('setup.exe') || ''
  assert.ok(r.includes('.exe'), r)
})
check('reason is null for media', () => assert.equal(blockedReason('film.mkv'), null))
check('reason falls through to mime', () => {
  assert.ok(blockedReason('noext', 'application/x-msdownload'))
})
check('blockedFilesIn finds and dedupes', () => {
  assert.deepEqual(
    blockedFilesIn(['a/film.mkv', 'a/setup.exe', 'b/setup.exe', 'a/readme.txt', 'a/run.bat']),
    ['setup.exe', 'run.bat']
  )
})
check('blockedFilesIn respects the cap', () =>
  assert.equal(blockedFilesIn(['1.exe', '2.exe', '3.exe', '4.exe'], 2).length, 2)
)
check('blockedFilesIn is empty for a clean torrent', () =>
  assert.deepEqual(blockedFilesIn(['film.mkv', 'film.srt', 'poster.jpg']), [])
)

console.log('\nrelease text markers')
check('flags an exe in a file listing', () =>
  assert.equal(releaseTextMentionsExecutable('Movie 2024 1080p\nfiles: film.mkv, setup.exe'), true)
)
check('flags a bare .exe name', () =>
  assert.equal(releaseTextMentionsExecutable('Movie.2024.1080p.mp4.exe'), true)
)
check('flags .lnk', () => assert.equal(releaseTextMentionsExecutable('watch.lnk'), true))
check('does not flag ordinary release text', () =>
  assert.equal(
    releaseTextMentionsExecutable('Movie.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1-GROUP'),
    false
  )
)
check('does not flag a group name containing exe letters', () =>
  assert.equal(releaseTextMentionsExecutable('Movie.2024.1080p.WEB-DL.EXEC-TEAM.mkv'), false)
)
check('does not trip on .mkv', () =>
  assert.equal(releaseTextMentionsExecutable('Some.Movie.mkv'), false)
)

console.log(`\n${pass} passed`)
