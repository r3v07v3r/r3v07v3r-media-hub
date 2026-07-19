const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),pkg=require('../package.json'),html=fs.readFileSync(path.join(root,'src/index.html'),'utf8'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8');
const {normalizeUpdateChannel,publicSettings,logoutSettings}=require('../src/preferences.cjs');
test('product is renamed without changing its stable update identity',()=>{assert.equal(pkg.build.productName,'R3 Media Hub');assert.equal(pkg.build.nsis.shortcutName,'R3 Media Hub');assert.equal(pkg.build.appId,'za.co.r3v07v3r.mediahub');assert.match(pkg.build.win.artifactName,/R3-Media-Hub/)});
test('sidebar exposes a clickable app version',()=>{assert.match(html,/id="versionButton"/);assert.match(main,/appVersion:app\.getVersion\(\)/);assert.match(renderer,/settings\.appVersion/);assert.match(renderer,/versionButton/)});
test('version dialog checks updates and offers restart only when downloaded',()=>{assert.match(renderer,/function openVersionDialog/);assert.match(renderer,/id="manualUpdateCheck"/);assert.match(renderer,/id="manualUpdateInstall"/);assert.match(renderer,/updateReady/);assert.match(renderer,/closeModal.*installUpdate/s);assert.match(main,/updateReady\)autoUpdater\.quitAndInstall/)});
test('update channel defaults to stable and only "preview" is ever accepted, so a corrupted or unset setting cannot silently opt a device into unstable builds',()=>{
 assert.equal(normalizeUpdateChannel(undefined),'stable');
 assert.equal(normalizeUpdateChannel('nonsense'),'stable');
 assert.equal(normalizeUpdateChannel('preview'),'preview');
 assert.equal(publicSettings({}).updateChannel,'stable');
 assert.equal(publicSettings({updateChannel:'preview'}).updateChannel,'preview');
});
test('the update channel preference is a device setting, not an account credential, so logging out preserves it exactly like the theme',()=>{
 assert.deepEqual(logoutSettings({theme:'ember',updateChannel:'preview',torboxToken:'secret'}),{theme:'ember',updateChannel:'preview'});
});
test('every autoUpdater.checkForUpdates call first re-reads the saved channel and sets allowPrerelease from it, so a channel switch takes effect on the very next check without restarting the app',()=>{
 assert.match(main,/const check=\(\)=>\{autoUpdater\.allowPrerelease=normalizeUpdateChannel\(readSettings\(\)\.updateChannel\)==='preview';autoUpdater\.checkForUpdates\(\)/);
 assert.match(main,/handle\('update:check',async\(\)=>\{if\(!app\.isPackaged\)return\{state:'development',version:app\.getVersion\(\)\};autoUpdater\.allowPrerelease=normalizeUpdateChannel\(readSettings\(\)\.updateChannel\)==='preview';/);
});
test('switching the update channel persists the choice and applies it to the live autoUpdater instance immediately, not just on the next check',()=>{
 assert.match(main,/handle\('update:set-channel',\(_e,channel\)=>\{const value=normalizeUpdateChannel\(channel\);const s=readSettings\(\);s\.updateChannel=value;writeSettings\(s\);autoUpdater\.allowPrerelease=value==='preview';return\{ok:true,channel:value\}\}\);/);
 assert.match(preload,/setUpdateChannel:channel=>ipcRenderer\.invoke\('update:set-channel',channel\)/);
});
test('Settings offers a toggle between the stable and preview update channels, and immediately checks for updates after switching so a preview build is found right away instead of waiting for the periodic background check',()=>{
 assert.match(renderer,/id="toggleUpdateChannel">\$\{settings\.updateChannel==='preview'\?'Switch back to stable':'Switch to preview builds'\}<\/button>/);
 assert.match(renderer,/const next=settings\.updateChannel==='preview'\?'stable':'preview';await window\.mediaHub\.setUpdateChannel\(next\);const result=await window\.mediaHub\.checkForUpdates\(\);/);
});
