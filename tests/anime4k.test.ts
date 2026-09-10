// Anime4K: the mode chains handed to mpv, and the installer's pick of files
// out of the upstream archive (src/shared/media-hub/anime4k.ts and
// src/main/media-hub/anime4kInstall.ts). The chains are upstream's documented
// high-end-GPU recipes; a typo in one would be a shader mpv fails to load
// with nothing on screen to say why, which is what pins them here.

import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import {
  ANIME4K_MODES,
  ANIME4K_REQUIRED_FILES,
  anime4kModeDescription,
  anime4kShaderChain,
  normalizeAnime4kMode
} from '../src/shared/media-hub/anime4k'
import { extractAnime4kShaders } from '../src/main/media-hub/anime4kInstall'

/** Same in-memory zip construction as zipArchive.test.ts. */
function makeZip(files: { name: string; body: Buffer | string }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, 'utf8')
    const data = zlib.deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(localBytes.length, 16)
  return Buffer.concat([localBytes, centralBytes, eocd])
}

// --- Chains -------------------------------------------------------------

// Mode A is upstream's "high-end GPU" recipe, verbatim and in order.
assert.deepEqual(anime4kShaderChain('A'), [
  'Anime4K_Clamp_Highlights.glsl',
  'Anime4K_Restore_CNN_VL.glsl',
  'Anime4K_Upscale_CNN_x2_VL.glsl',
  'Anime4K_AutoDownscalePre_x2.glsl',
  'Anime4K_AutoDownscalePre_x4.glsl',
  'Anime4K_Upscale_CNN_x2_M.glsl'
])

// The doubled modes add exactly one restore pass to their base.
assert.equal(anime4kShaderChain('A+A').length, anime4kShaderChain('A').length + 1)
assert.equal(anime4kShaderChain('B+B').length, anime4kShaderChain('B').length + 1)
assert.equal(anime4kShaderChain('C+A').length, anime4kShaderChain('C').length + 1)

for (const mode of ANIME4K_MODES) {
  const chain = anime4kShaderChain(mode)
  // Clamp_Highlights first, always — it is what the later passes undo.
  assert.equal(chain[0], 'Anime4K_Clamp_Highlights.glsl', mode)
  // Ends on the second upscale, after the downscale guards.
  assert.equal(chain[chain.length - 1], 'Anime4K_Upscale_CNN_x2_M.glsl', mode)
  for (const file of chain) {
    assert.ok(ANIME4K_REQUIRED_FILES.includes(file), `${file} must be installed for mode ${mode}`)
    assert.match(file, /^Anime4K_[A-Za-z0-9_]+\.glsl$/)
  }
  // Returned by value — a caller mutating its copy must not change the chain.
  chain.pop()
  assert.notEqual(anime4kShaderChain(mode).length, chain.length)
  assert.ok(anime4kModeDescription(mode).length > 0)
}

// Ten distinct files across the six modes; nothing else leaves the archive.
assert.equal(ANIME4K_REQUIRED_FILES.length, 10)

// --- Normalisation ------------------------------------------------------

assert.equal(normalizeAnime4kMode('C+A'), 'C+A')
assert.equal(normalizeAnime4kMode('a'), 'A')
assert.equal(normalizeAnime4kMode(undefined), 'A')
assert.equal(normalizeAnime4kMode('D'), 'A')
assert.equal(normalizeAnime4kMode({ mode: 'B' }), 'A')

// --- Extraction ---------------------------------------------------------

// Only the required files come out, even when the archive (like the real
// one) carries dozens more; a nested path is matched by its basename.
{
  const archive = makeZip([
    ...ANIME4K_REQUIRED_FILES.map((name) => ({ name, body: `// ${name}` })),
    { name: 'Anime4K_Darken_HQ.glsl', body: '// not needed' },
    { name: 'README.md', body: '# nope' }
  ])
  const shaders = extractAnime4kShaders(archive)
  assert.equal(shaders.size, ANIME4K_REQUIRED_FILES.length)
  assert.equal(
    shaders.get('Anime4K_Clamp_Highlights.glsl')?.toString('utf8'),
    '// Anime4K_Clamp_Highlights.glsl'
  )
  assert.equal(shaders.has('Anime4K_Darken_HQ.glsl'), false)
}

// A pack missing one shader is refused whole rather than installed with a
// mode that would fail in mpv later.
{
  const archive = makeZip(
    ANIME4K_REQUIRED_FILES.filter((name) => name !== 'Anime4K_Restore_CNN_M.glsl').map((name) => ({
      name,
      body: '//'
    }))
  )
  assert.throws(() => extractAnime4kShaders(archive), /Anime4K_Restore_CNN_M\.glsl/)
}

// Not a zip at all — an HTML error page with a 200, say.
assert.throws(() => extractAnime4kShaders(Buffer.from('<html>oops</html>')))

console.log('anime4k tests passed')
