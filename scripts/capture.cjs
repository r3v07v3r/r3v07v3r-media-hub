const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.cjs'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise(resolve => setTimeout(resolve, 800));
  const image = await win.webContents.capturePage();
  require('node:fs').mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
  require('node:fs').writeFileSync(path.join(__dirname, '..', 'artifacts', 'windows-home.png'), image.toPNG());
  app.quit();
});
