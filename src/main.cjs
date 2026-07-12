const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { validateTorBoxToken } = require('./core.cjs');

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } }
function writeSettings(settings) { fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); }
function encrypt(value) { return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : ''; }
function decrypt(value) { try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; } }

function createWindow() {
  const win = new BrowserWindow({ width: 1440, height: 900, minWidth: 980, minHeight: 680, backgroundColor: '#070a12', titleBarStyle: 'hidden', titleBarOverlay: { color: '#070a12', symbolColor: '#cdd5e5', height: 42 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('settings:status', () => ({ torboxConfigured: Boolean(readSettings().torboxToken) }));
ipcMain.handle('torbox:save', async (_event, rawToken) => {
  const token = String(rawToken || '').trim();
  if (!validateTorBoxToken(token)) return { ok: false, message: 'Enter a valid TorBox API token.' };
  try {
    const response = await fetch('https://api.torbox.app/v1/api/user/me', { headers: { Authorization: `Bearer ${token}` } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success === false) return { ok: false, message: result.detail || `TorBox rejected the token (${response.status}).` };
    const settings = readSettings(); settings.torboxToken = encrypt(token); writeSettings(settings);
    return { ok: true, message: 'TorBox connected securely.', user: result.data?.email || result.data?.username || 'TorBox account' };
  } catch (error) { return { ok: false, message: `Could not reach TorBox: ${error.message}` }; }
});
ipcMain.handle('torbox:test', async () => {
  const token = decrypt(readSettings().torboxToken || '');
  if (!token) return { ok: false, message: 'No TorBox token is saved.' };
  try { const response = await fetch('https://api.torbox.app/v1/api/user/me', { headers: { Authorization: `Bearer ${token}` } }); const result = await response.json(); return { ok: response.ok && result.success !== false, message: response.ok ? 'TorBox connection is healthy.' : (result.detail || 'Connection failed.') }; }
  catch (error) { return { ok: false, message: error.message }; }
});

app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
