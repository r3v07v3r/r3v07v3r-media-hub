// The stand-in the service layer gets for `electron` when it runs headless
// (src/headless/electronShim). These are the parts that are REAL — the ones a
// wrong answer from would lose data or leak it: where files go, how settings
// are sealed, how a handler is found and called, where a push ends up.
// Run with: npx tsx tests/electronShim.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-shim-'))
process.env.R3_USER_DATA = userData
delete process.env.R3_MASTER_KEY

// After the environment is set: the shim reads it on use, but this keeps the
// test honest about the order a real host has to respect.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  safeStorage,
  setHostActions,
  shell
} from '../src/headless/electronShim'

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  await check('every path the service layer asks for is inside the host’s data directory', () => {
    for (const name of ['userData', 'sessionData', 'logs', 'temp', 'pictures', 'downloads']) {
      const resolved = app.getPath(name)
      assert.ok(
        resolved === userData || resolved.startsWith(userData + path.sep),
        `${name} -> ${resolved} escapes ${userData}`
      )
    }
    assert.equal(app.isPackaged, true, 'a headless backend must never take a dev-server branch')
  })

  await check('with nowhere to keep data it refuses, rather than guessing a directory', () => {
    const saved = process.env.R3_USER_DATA
    delete process.env.R3_USER_DATA
    try {
      assert.throws(() => app.getPath('userData'), /R3_USER_DATA/)
    } finally {
      process.env.R3_USER_DATA = saved
    }
  })

  await check('a sealed secret opens again, and is not readable where it sits', () => {
    assert.equal(safeStorage.isEncryptionAvailable(), true)
    const sealed = safeStorage.encryptString('tb_live_abc123')
    assert.equal(sealed.includes(Buffer.from('tb_live_abc123')), false, 'plaintext is in the blob')
    assert.equal(safeStorage.decryptString(sealed), 'tb_live_abc123')
    // Same plaintext, different blob: a fresh nonce every time.
    assert.notDeepEqual(safeStorage.encryptString('tb_live_abc123'), sealed)
  })

  await check('a tampered or foreign blob is refused, never half-decrypted', () => {
    const sealed = safeStorage.encryptString('secret')
    const flipped = Buffer.from(sealed)
    flipped[flipped.length - 1] ^= 0xff
    assert.throws(() => safeStorage.decryptString(flipped))
    assert.throws(() => safeStorage.decryptString(Buffer.from('not one of ours at all, clearly')))
  })

  await check('with no key given, one is kept beside the data — owner-only, and reused', () => {
    const file = path.join(userData, 'master.key')
    assert.ok(fs.existsSync(file), 'no key file was created')
    assert.equal(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64').length, 32)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o077, 0, 'key file is readable by others')
    }
  })

  await check(
    'a registered handler is what an invoke reaches, with its event and arguments',
    async () => {
      const seen: unknown[] = []
      ipcMain.handle('test:echo', (event, payload) => {
        seen.push(event, payload)
        return { echoed: payload }
      })
      const event = { sender: 'a-window' }
      assert.deepEqual(await ipcMain.dispatchInvoke(event, 'test:echo', [{ n: 1 }]), {
        echoed: { n: 1 }
      })
      assert.deepEqual(seen, [event, { n: 1 }])
      assert.ok(ipcMain.channels().includes('test:echo'))
    }
  )

  await check('a second handler for one channel is an error, as it is in Electron', () => {
    assert.throws(() => ipcMain.handle('test:echo', () => null), /second handler/)
  })

  await check('an invoke nobody handles rejects instead of hanging', async () => {
    await assert.rejects(ipcMain.dispatchInvoke({}, 'test:nobody', []), /No handler registered/)
  })

  await check('a handler that throws rejects the invoke with that error', async () => {
    ipcMain.handle('test:boom', () => {
      throw new Error('Request failed (404)')
    })
    await assert.rejects(ipcMain.dispatchInvoke({}, 'test:boom', []), /Request failed \(404\)/)
  })

  await check('a fire-and-forget reaches its listener', () => {
    const got: unknown[] = []
    ipcMain.on('test:subscribe', (event, ...args) => got.push(event, ...args))
    ipcMain.dispatchSend({ sender: 'w' }, 'test:subscribe', ['x'])
    assert.deepEqual(got, [{ sender: 'w' }, 'x'])
  })

  await check('a push goes to whoever is listening for that window, and nowhere otherwise', () => {
    const win = new BrowserWindow()
    // Nobody connected: dropped without a word, exactly like a window with no
    // renderer listening.
    win.webContents.send('library:changed', { scopes: ['all'] })

    const delivered: Array<[string, unknown]> = []
    win.webContents.setPushSink((channel, payload) => delivered.push([channel, payload]))
    win.webContents.send('library:changed', { scopes: ['history'] })
    assert.deepEqual(delivered, [['library:changed', { scopes: ['history'] }]])

    assert.equal(win.isDestroyed(), false)
    assert.equal(BrowserWindow.fromWebContents(win.webContents), win)
    assert.ok(BrowserWindow.getAllWindows().includes(win))
    win.destroy()
    assert.equal(win.isDestroyed(), true)
    assert.equal(BrowserWindow.getAllWindows().includes(win), false)
  })

  await check('the sender a handler sees passes the service layer’s own trust check', () => {
    // ipc/trustedSender.ts requires senderFrame === sender.mainFrame and the
    // frame's url to be the app's own document. The bridge builds its event
    // from exactly these two properties.
    const { webContents } = new BrowserWindow()
    assert.equal(webContents.mainFrame.url, 'app://index.html/')
  })

  await check('native pickers answer "cancelled", which every caller already handles', async () => {
    assert.deepEqual(await dialog.showOpenDialog(), { canceled: true, filePaths: [] })
    assert.equal((await dialog.showSaveDialog()).canceled, true)
    assert.equal(Notification.isSupported(), false)
  })

  await check('opening a link is the host’s to do — refused until it says how', async () => {
    await assert.rejects(shell.openExternal('https://torbox.app/settings'), /cannot open links/)
    const opened: string[] = []
    setHostActions({ openExternal: (url) => void opened.push(url) })
    await shell.openExternal('https://torbox.app/settings')
    assert.deepEqual(opened, ['https://torbox.app/settings'])
  })

  await check('quit runs the same before-quit the desktop teardown hangs off', () => {
    let ran = false
    app.once('before-quit', () => (ran = true))
    app.quit()
    assert.equal(ran, true)
  })

  console.log(`\n${pass} passed`)
}

void main()
