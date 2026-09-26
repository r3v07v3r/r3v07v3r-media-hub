// Stages the Node runtime the Android app runs its backend on.
//
// The phone/TV app is the desktop's service layer, run headless
// (dist-headless/backend.cjs) under a real Node. Termux's prebuilt
// `nodejs-lts` is that Node: built against Android's bionic, and proven on
// real hardware to run backend.cjs unchanged (node:sqlite, TLS, WebSocket,
// Ed25519 — see the Android section of the project plan). This script fetches
// it and everything it links against, and lays it out the way an APK can
// carry it.
//
// Two Android rules shape the layout:
// - An app may only execute code from its native library directory, and an
//   APK only puts files named `lib*.so` there. So `node` ships as
//   `libnode.so`, and every library ships under a `libr3_*.so` name.
// - The libraries' real names (libz.so.1, libssl.so.3, libicuuc.so.78) are
//   what the binaries ask the linker for. The app recreates those names as
//   symlinks into the native library directory at startup
//   (android/.../Backend.kt), from the map written here. Nothing is patched.
//   Renaming everything, rather than only the versioned names, also keeps a
//   library of ours from ever being confused with the system's own libssl.so
//   or libz.so.
//
// Termux keeps only the current version of each package in its pool, so
// versions cannot be pinned: last week's libc++ is already gone. Instead the
// current index is read, every download is checked against the SHA-256 it
// lists, and the dependency walk below follows the binaries themselves, so a
// soname bump (ICU 78 -> 79) is picked up rather than breaking the build.
// The Node major IS pinned: a different major is a different runtime.
//
// Runs in CI on Linux (needs dpkg-deb). Usage:
//   node scripts/android-node-payload.mjs <jniLibs/arm64-v8a dir> <assets dir>

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = 'https://packages.termux.dev/apt/termux-main'
const ARCH = 'aarch64'
const NODE_PACKAGE = 'nodejs-lts'
const NODE_MAJOR = '24'
/** Provided by Android itself; never shipped. */
const SYSTEM_LIBS = new Set(['libc.so', 'libm.so', 'libdl.so', 'liblog.so', 'libandroid.so'])

const [jniDir, assetsDir] = process.argv.slice(2)
if (!jniDir || !assetsDir) {
  console.error('usage: android-node-payload.mjs <jniLibs abi dir> <assets dir>')
  process.exit(2)
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function parseIndex(text) {
  const packages = new Map()
  for (const stanza of text.split(/\n\n+/)) {
    const fields = {}
    let last = null
    for (const line of stanza.split('\n')) {
      if (/^\s/.test(line) && last) fields[last] += '\n' + line.trim()
      else {
        const colon = line.indexOf(':')
        if (colon < 0) continue
        last = line.slice(0, colon)
        fields[last] = line.slice(colon + 1).trim()
      }
    }
    if (fields.Package) packages.set(fields.Package, fields)
  }
  return packages
}

/** `a (>= 1), b | c` -> ['a', 'b']: the first of each alternative. */
function dependsOf(fields) {
  return String(fields.Depends || '')
    .split(',')
    .map((d) => d.split('|')[0].trim().split(/\s|\(/)[0])
    .filter(Boolean)
}

// ---- ELF: DT_NEEDED and DT_SONAME of a 64-bit little-endian object --------

function elfNeeded(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x464c457f) throw new Error(`not ELF: ${file}`)
  if (buf[4] !== 2) throw new Error(`not ELF64: ${file}`)
  const phoff = Number(buf.readBigUInt64LE(0x20))
  const phentsize = buf.readUInt16LE(0x36)
  const phnum = buf.readUInt16LE(0x38)
  const headers = []
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize
    headers.push({
      type: buf.readUInt32LE(off),
      offset: Number(buf.readBigUInt64LE(off + 8)),
      vaddr: Number(buf.readBigUInt64LE(off + 16)),
      filesz: Number(buf.readBigUInt64LE(off + 32)),
      memsz: Number(buf.readBigUInt64LE(off + 40))
    })
  }
  const toOffset = (vaddr) => {
    const load = headers.find((h) => h.type === 1 && vaddr >= h.vaddr && vaddr < h.vaddr + h.memsz)
    return load ? load.offset + (vaddr - load.vaddr) : null
  }
  const dynamic = headers.find((h) => h.type === 2)
  if (!dynamic) return []
  const entries = []
  for (let off = dynamic.offset; off < dynamic.offset + dynamic.filesz; off += 16) {
    const tag = Number(buf.readBigInt64LE(off))
    if (tag === 0) break
    entries.push({ tag, value: Number(buf.readBigUInt64LE(off + 8)) })
  }
  const strtab = entries.find((e) => e.tag === 5)
  const base = strtab ? toOffset(strtab.value) : null
  if (base === null) throw new Error(`no string table: ${file}`)
  const str = (at) => buf.toString('utf8', at, buf.indexOf(0, at))
  return entries.filter((e) => e.tag === 1).map((e) => str(base + e.value))
}

// ---- main -------------------------------------------------------------------

const index = parseIndex(
  (await download(`${REPO}/dists/stable/main/binary-${ARCH}/Packages`)).toString('utf8')
)
const node = index.get(NODE_PACKAGE)
if (!node) throw new Error(`${NODE_PACKAGE} is not in the Termux index`)
if (!node.Version.startsWith(`${NODE_MAJOR}.`)) {
  throw new Error(
    `${NODE_PACKAGE} is now ${node.Version}, not Node ${NODE_MAJOR}. Move NODE_MAJOR on purpose, after testing.`
  )
}

// Every package nodejs-lts depends on, transitively.
const wanted = new Map()
const queue = [NODE_PACKAGE]
while (queue.length) {
  const name = queue.shift()
  if (wanted.has(name)) continue
  const fields = index.get(name)
  if (!fields) throw new Error(`dependency ${name} is not in the Termux index`)
  wanted.set(name, fields)
  queue.push(...dependsOf(fields))
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-node-'))
for (const [name, fields] of wanted) {
  const deb = await download(`${REPO}/${fields.Filename}`)
  const digest = crypto.createHash('sha256').update(deb).digest('hex')
  if (digest !== fields.SHA256) {
    throw new Error(`${name}: SHA-256 ${digest} does not match the index (${fields.SHA256})`)
  }
  const file = path.join(work, `${name}.deb`)
  fs.writeFileSync(file, deb)
  execFileSync('dpkg-deb', ['-x', file, path.join(work, 'root')])
  console.log(`[node-payload] ${name} ${fields.Version} (sha256 ok)`)
}

const usr = path.join(work, 'root', 'data', 'data', 'com.termux', 'files', 'usr')
const libDir = path.join(usr, 'lib')

fs.mkdirSync(jniDir, { recursive: true })
fs.mkdirSync(assetsDir, { recursive: true })
fs.copyFileSync(path.join(usr, 'bin', 'node'), path.join(jniDir, 'libnode.so'))

// Walk what the linker will be asked for, starting from node itself.
const packaged = new Map()
const pending = [path.join(usr, 'bin', 'node')]
while (pending.length) {
  for (const needed of elfNeeded(pending.shift())) {
    if (SYSTEM_LIBS.has(needed) || packaged.has(needed)) continue
    const source = path.join(libDir, needed)
    if (!fs.existsSync(source)) throw new Error(`${needed} is needed but no package provides it`)
    const shipped = `libr3_${needed.replace(/[^A-Za-z0-9]/g, '_')}.so`
    // copyFileSync follows symlinks: libz.so.1 -> libz.so.1.3.2 ships as the file.
    fs.copyFileSync(fs.realpathSync(source), path.join(jniDir, shipped))
    packaged.set(needed, shipped)
    pending.push(source)
  }
}

const versions = [...wanted].map(([name, f]) => `${name} ${f.Version}`).join(', ')
fs.writeFileSync(
  path.join(assetsDir, 'node-libs.txt'),
  [
    `# Termux ${ARCH}: ${versions}`,
    '# <name the linker asks for> <file in the native library directory>',
    ...[...packaged].map(([needed, shipped]) => `${needed} ${shipped}`),
    ''
  ].join('\n')
)
console.log(`[node-payload] node ${node.Version} + ${packaged.size} libraries -> ${jniDir}`)
fs.rmSync(work, { recursive: true, force: true })
