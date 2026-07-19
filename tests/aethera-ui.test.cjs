const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');

test('Aethera is the :root default palette while Neon keeps its own named theme block, so existing users who picked Neon see no change',()=>{
 assert.match(css,/:root,\[data-theme="aethera"\]\{--bg:#03090b/);
 assert.match(css,/\[data-theme="neon"\]\{--bg:#070910;--panel:#0d111c/);
 assert.match(renderer,/function applyTheme\(theme\)\{document\.documentElement\.dataset\.theme=theme\|\|'aethera'\}/);
});
test('the design-language layer is palette-driven (var(--accent)/var(--glow)) rather than hardcoding Aethera teal, so every theme gets the outlined-glow look in its own colors',()=>{
 assert.match(css,/\.primary\{background:color-mix\(in srgb,var\(--accent\) 12%,transparent\);border:1px solid var\(--accent\);color:var\(--cyan\)/);
 assert.match(css,/\.nav-item\.active\{border:1px solid var\(--accent\)/);
 assert.match(css,/\.card:hover\{border-color:var\(--accent\);box-shadow:0 0 24px var\(--glow\)/);
});
test('the player bar is split into Aethera clusters: volume left, an outlined glass seek bar center with the play orb centered on its top edge, CC and fullscreen right',()=>{
 assert.match(renderer,/<div class="pc-cluster pc-left"><button type="button" id="playerMute"/);
 assert.match(renderer,/<div class="pc-bar"><button type="button" id="playerPlayPause"/);
 assert.match(renderer,/<div class="pc-cluster pc-right"><button type="button" id="playerCC"[^>]*>CC<\/button><button type="button" id="playerControlsFullscreen"/);
 assert.match(css,/#playerPlayPause\{position:absolute;left:50%;top:0;transform:translate\(-50%,-50%\);width:58px;height:58px/);
 assert.match(css,/\.pc-bar\{position:relative;flex:1;[^}]*border:1px solid var\(--line\);border-radius:18px/);
 assert.match(css,/\.seek-fill\{background:linear-gradient\(90deg,var\(--accent\),var\(--cyan\)\);box-shadow:0 0 12px var\(--glow\)\}/);
});
test('the CC button jumps straight into the OpenSubtitles search, opening the playback panel first if it is closed',()=>{
 assert.match(renderer,/\$\('#playerCC'\)\.onclick=\(\)=>\{const panel=\$\('#playerTrackPanel'\);if\(panel\.classList\.contains\('hidden'\)\)\$\('#playerSettings'\)\.onclick\(\);\$\('#fixPlayerSubtitles'\)\.onclick\(\)\}/);
});
test('the sidebar collapses to a glowing icon rail with tooltips and the header becomes a command bar with brand, user status and clock',()=>{
 assert.match(css,/\.app-shell\{grid-template-columns:88px 1fr\}/);
 assert.match(css,/\.nav-item span\{display:none\}/);
 assert.match(renderer,/USER: \$\{\(user\.username\|\|user\.email\|\|'GUEST'\)\.toUpperCase\(\)\} • ONLINE/);
 assert.match(renderer,/function tickClock\(\)/);
});
test('settings are organized behind a left tab rail showing one panel at a time, with the connections panel visible by default',()=>{
 assert.match(renderer,/class="settings-tab active" data-settings-tab="0"/);
 assert.match(renderer,/class="settings-section" data-settings-panel="0"/);
 assert.match(renderer,/class="settings-section hidden" data-settings-panel="1"/);
 assert.match(renderer,/class="settings-section hidden" data-settings-panel="2"/);
 assert.match(renderer,/\$\$\('\.settings-tab'\)\.forEach\(tab=>tab\.onclick=\(\)=>\{\$\$\('\.settings-tab'\)\.forEach\(x=>x\.classList\.toggle\('active',x===tab\)\);\$\$\('\[data-settings-panel\]'\)\.forEach\(panel=>panel\.classList\.toggle\('hidden',panel\.dataset\.settingsPanel!==tab\.dataset\.settingsTab\)\)\}\)/);
 assert.match(css,/\.settings-layout\{display:grid;grid-template-columns:190px 1fr/);
 assert.match(css,/\.settings-tab\.active\{border-color:var\(--accent\)/);
});
