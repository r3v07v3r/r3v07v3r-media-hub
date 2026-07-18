const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8'),indexHtml=fs.readFileSync(path.join(root,'src/index.html'),'utf8'),playback=fs.readFileSync(path.join(root,'src/playback.cjs'),'utf8'),pkg=require(path.join(root,'package.json'));
test('ws and the UPnP mapper are real runtime dependencies, not just devDependencies, since the app needs them at runtime to host/join a party',()=>{
 assert.ok(pkg.dependencies.ws,'ws should be a runtime dependency');
 assert.ok(pkg.dependencies['@achingbrain/nat-port-mapper'],'the UPnP package should be a runtime dependency');
});
test('the party WebSocket server and any outbound party connection live entirely in the main process, never opening a socket from the renderer, so no CSP change was needed',()=>{
 assert.match(main,/const \{WebSocketServer,WebSocket\}=require\('ws'\)/);
 assert.doesNotMatch(renderer,/new WebSocket\(/);
 assert.match(indexHtml,/connect-src 'self'/);
 assert.doesNotMatch(indexHtml,/connect-src[^"]*\bws:/);
});
test('a client is only admitted to the party after its first message decrypts successfully with the shared secret; anything else gets the socket closed',()=>{
 assert.match(main,/const msg=decryptMessage\(secret,raw\.toString\(\)\);if\(!msg\)\{ws\.close\(\);return\}/);
 assert.match(main,/if\(msg\.type==='hello'&&!memberId\)\{memberId=createMemberId\(\)/);
});
test('hosting attempts UPnP port mapping but never lets a failure block starting the party, always falling back to LAN-only',()=>{
 assert.match(main,/const mapping=await attemptPortMapping\(port,getLocalLanIp\(\)\)\.catch\(\(\)=>null\)/);
 assert.match(main,/const lan=\{ip:getLocalLanIp\(\),port\},wan=mapping\?\{ip:mapping\.ip,port:mapping\.port\}:null/);
});
test('attemptPortMapping in upnp.cjs never throws, resolving null on any failure so the caller cannot skip the fallback path',()=>{
 const upnp=fs.readFileSync(path.join(root,'src/upnp.cjs'),'utf8');
 assert.match(upnp,/\}catch\{\s*return null;?\s*\}/);
});
test('the party feature does not touch the existing SSRF guards that protect real TorBox media URLs, since connecting to a private LAN peer is a deliberate feature here, not a bug to fix in playback.cjs',()=>{
 assert.match(playback,/function isPrivateAddress\(value\)\{const address=String\(value\)/);
 assert.match(playback,/function isAllowedRemoteMediaUrl\(value\)\{try\{const url=new URL\(String\(value\)\),host=url\.hostname/);
 assert.doesNotMatch(playback,/party/i);
});
test('leaving or quitting cleanly tears down whichever role is active: the host closes every member socket, the server, and any UPnP mapping; a client just closes its own socket',()=>{
 assert.match(main,/function closeParty\(\)\{if\(!party\)return;if\(party\.role==='host'&&party\.mode!=='relay'\)\{for\(const m of party\.members\.values\(\)\)try\{m\.ws\?\.close\(\)\}catch\{\}try\{party\.wss\.close\(\)\}catch\{\}party\.upnpStop\?\.\(\)\}else\{if\(party\.mode==='relay'\)try\{party\.ws\.send\(encryptMessage\(party\.secret,\{type:'leave'\}\)\)\}catch\{\}try\{party\.ws\.close\(\)\}catch\{\}\}party=null\}/);
 assert.match(main,/app\.on\('before-quit',\(\)=>\{playbackProxy\.close\(\)\.catch\(\(\)=>\{\}\);vlcTranscoder\.stop\(\)\.catch\(\(\)=>\{\}\);closeParty\(\);/);
});
test('preload exposes the party host/join/leave/status channels and a subscription for party events pushed from main',()=>{
 assert.match(preload,/partyHost:\(name,mode\)=>ipcRenderer\.invoke\('party:host',\{name,mode\}\)/);
 assert.match(preload,/partyJoin:payload=>ipcRenderer\.invoke\('party:join',payload\)/);
 assert.match(preload,/partyLeave:\(\)=>ipcRenderer\.invoke\('party:leave'\)/);
 assert.match(preload,/partyStatus:\(\)=>ipcRenderer\.invoke\('party:status'\)/);
 assert.match(preload,/onPartyEvent:callback=>\{const listener=\(_event,value\)=>callback\(value\);ipcRenderer\.on\('party:event',listener\)/);
});
test('a new Party nav item exists and toggles a slide-out panel instead of navigating the catalog pipeline',()=>{
 assert.match(indexHtml,/data-section="party">☍ <span>Party<\/span>/);
 assert.match(indexHtml,/<aside id="partyPanel" class="party-panel"><\/aside>/);
 assert.match(renderer,/if\(b\.dataset\.section==='party'\)\{togglePartyPanel\(\);return\}/);
 assert.doesNotMatch(renderer,/if\(next==='party'\)/);
});
test('the party lobby lets you host or join, and the room view shows the share code and a LAN-only warning to the host, driven by fresh IPC status rather than stale local state',()=>{
 assert.match(renderer,/async function renderPartyPanel\(\)\{const status=await window\.mediaHub\.partyStatus\(\)/);
 assert.match(renderer,/window\.mediaHub\.partyHost\(\$\('#partyHostName'\)\.value,\$\('#partyHostMode'\)\.value\)/);
 assert.match(renderer,/window\.mediaHub\.partyJoin\(\{code:\$\('#partyJoinCode'\)\.value\.trim\(\),name:\$\('#partyJoinName'\)\.value\}\)/);
 assert.match(renderer,/status\.role==='host'&&lastPartyCode/);
 assert.match(renderer,/Automatic internet port-forwarding was unavailable/);
});
test('the panel shows the party name and your own display name at the top of the room view, and a close control that hides the panel without leaving the party',()=>{
 assert.match(renderer,/\$\{esc\(status\.hostName\|\|'Watch Party'\)\}'s Party/);
 assert.match(renderer,/You: \$\{esc\(status\.selfName\|\|''\)\}/);
 assert.match(renderer,/function togglePartyPanel\(forceOpen\)\{partyPanelOpen=forceOpen!==undefined\?forceOpen:!partyPanelOpen;\$\('#partyPanel'\)\.classList\.toggle\('open',partyPanelOpen\)/);
 assert.match(renderer,/\$\('#partyPanelClose'\)\.onclick=\(\)=>togglePartyPanel\(false\)/);
});
