const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
test('only the host can broadcast what is now playing, and only the host can seek - both are enforced in main.cjs, not just hidden in the UI',()=>{
 assert.match(main,/handle\('party:now-playing',\(_e,payload=\{\}\)=>\{if\(!party\|\|party\.role!=='host'\)throw new Error\('Only the host can start party playback\.'\)/);
 assert.match(main,/handle\('party:playback-action',\(_e,action=\{\}\)=>\{if\(!party\)return\{ok:false\};if\(action\.type==='seek'&&party\.role!=='host'\)throw new Error\('Only the host can seek\.'\)/);
 assert.match(main,/if\(party\?\.role==='host'&&msg\?\.type==='seek'\)return;/,'a seek message arriving from a connected client (the only way handlePartyMessage sees one) must be dropped, since the host\'s own seeks never route through this relay path');
});
test('play and pause from any member relay to everyone through the existing generic message path, since only suggest/remove/seek get special-cased',()=>{
 assert.doesNotMatch(main,/msg\?\.type==='play'/,'play should not be special-cased out of the generic relay - it needs to reach every other member, same as pause');
 assert.match(main,/const event=\{type:action\.type,position:Number\(action\.position\)\}/);
});
test('preload exposes the nowPlaying broadcast and the generic playback-action channel',()=>{
 assert.match(preload,/partyNowPlaying:payload=>ipcRenderer\.invoke\('party:now-playing',payload\)/);
 assert.match(preload,/partyPlaybackAction:action=>ipcRenderer\.invoke\('party:playback-action',action\)/);
});
test('starting any stream checks live party status and, only when hosting, broadcasts nowPlaying and marks the local player as the party host - never for a client, who would otherwise start a second independent broadcast',()=>{
 assert.match(renderer,/partyStatusNow=await window\.mediaHub\.partyStatus\(\)\.catch\(\(\)=>\(\{inParty:false\}\)\)/);
 assert.match(renderer,/if\(partyStatusNow\.inParty&&partyStatusNow\.role==='host'\)await window\.mediaHub\.partyNowPlaying\(/);
 assert.match(renderer,/partyStatusNow\.inParty&&partyStatusNow\.role==='host'\?'host':null\)\}/);
});
test('openPlayer takes an explicit party role and threads it into a module-level flag used by every playback-sync decision made afterward',()=>{
 assert.match(renderer,/function openPlayer\(prepared,title,subtitle,simklTracking,subtitleContext=\{\},partyRole=null\)\{/);
 assert.match(renderer,/const player=\$\('#mediaPlayer'\);activePartyRole=partyRole;/);
 assert.match(renderer,/playerSignal\.addEventListener\('abort',\(\)=>\{clearTimeout\(controlsTimer\);clearInterval\(partyPositionTimer\);activePartyRole=null;/);
});
test('play/pause always broadcasts when in a party (any member can toggle), but seeking is blocked outright for clients and only broadcasts for the host, enforced in three separate places: the seek bar, arrow-key seeking, and the disabled-state toggle',()=>{
 assert.match(renderer,/const togglePlayPause=\(\)=>\{const wasPaused=player\.paused;if\(player\.paused\)player\.play\(\);else player\.pause\(\);revealControls\(\);if\(activePartyRole\)window\.mediaHub\.partyPlaybackAction\(\{type:wasPaused\?'play':'pause'\}\)\.catch\(\(\)=>\{\}\)\};/);
 assert.match(renderer,/const seekBy=delta=>\{if\(!Number\.isFinite\(player\.duration\)\|\|activePartyRole==='client'\)return;.*if\(activePartyRole==='host'\)window\.mediaHub\.partyPlaybackAction\(\{type:'seek',position:player\.currentTime\}\)\.catch\(\(\)=>\{\}\)\};/);
 assert.match(renderer,/toggle\('disabled',!hasDuration\|\|activePartyRole==='client'\)/);
 assert.match(renderer,/if\(activePartyRole==='host'\)window\.mediaHub\.partyPlaybackAction\(\{type:'seek',position:player\.currentTime\}\)\.catch\(\(\)=>\{\}\)\}\},\{signal:playerSignal\}\);/);
});
test('a nowPlaying message triggers a fresh independent playStream call using only the infoHash and metadata that traveled over the party channel, reusing the exact same play pipeline as a normal local play',()=>{
 assert.match(renderer,/async function autoPlayPartyNowPlaying\(msg\)\{try\{const prepared=await window\.mediaHub\.playStream\(\{infoHash:msg\.infoHash,sources:msg\.sources\},msg\.mediaId\);openPlayer\(prepared,msg\.item\?\.title\|\|'Now playing',[\s\S]{0,200}'client'\)/);
});
test('incoming play/pause/seek/position messages are only ever applied to a currently-open party player, and position corrections only apply to clients past a drift threshold so the host is never fighting its own broadcast',()=>{
 assert.match(renderer,/function handlePartyPlaybackMessage\(msg\)\{if\(!msg\)return;if\(msg\.type==='nowPlaying'\)\{autoPlayPartyNowPlaying\(msg\);return\}if\(!activePartyRole\)return;/);
 assert.match(renderer,/activePartyRole==='client'&&Number\.isFinite\(msg\.position\)&&Math\.abs\(player\.currentTime-msg\.position\)>5/);
});
test('the shared queue only shows a Play button to the host, and clicking it opens the existing title detail flow rather than a separate playback path',()=>{
 assert.match(renderer,/status\.role==='host'\?`<button type="button" class="party-queue-play" data-queue-index="\$\{i\}" title="Play this" aria-label="Play this">▶<\/button>`:''/);
 assert.match(renderer,/const picked=queue\[Number\(button\.dataset\.queueIndex\)\];if\(picked\)openItem\(\{id:picked\.item\.id,type:picked\.item\.type,title:picked\.item\.title,poster:picked\.item\.poster\}\)/);
});
