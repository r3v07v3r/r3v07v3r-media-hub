const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8'),preferences=fs.readFileSync(path.join(root,'src/preferences.cjs'),'utf8');

test('a single mode-aware broadcast helper replaces every scattered per-member-socket loop, so direct-mode host keeps one socket per member while every other case (direct client, relay host, relay client) sends on its one outbound socket',()=>{
 assert.match(main,/function partyBroadcast\(payload\)\{if\(!party\)return;if\(party\.role==='host'&&party\.mode!=='relay'\)\{for\(const m of party\.members\.values\(\)\)if\(m\.ws&&m\.ws\.readyState===WebSocket\.OPEN\)m\.ws\.send\(payload\);return\}if\(party\.ws&&party\.ws\.readyState===WebSocket\.OPEN\)party\.ws\.send\(payload\)\}/);
 assert.match(main,/broadcastPartyState\(\)\{if\(!party\|\|party\.role!=='host'\)return;const memberList=partyMemberSummaries\(\),payload=encryptMessage\(party\.secret,\{type:'party-state',members:memberList\}\);partyBroadcast\(payload\);/);
 assert.match(main,/broadcastQueue\(\)\{if\(!party\|\|party\.role!=='host'\)return;const payload=encryptMessage\(party\.secret,\{type:'queue-sync',queue:party\.queue\}\);partyBroadcast\(payload\);/);
 assert.match(main,/handle\('party:now-playing',[\s\S]{0,600}partyBroadcast\(encryptMessage\(party\.secret,event\)\);return\{ok:true\}\}\);/);
 assert.match(main,/handle\('party:playback-action',\(_e,action=\{\}\)=>\{if\(!party\)return\{ok:false\};if\(action\.type==='seek'&&party\.role!=='host'\)throw new Error\('Only the host can seek\.'\);const event=\{type:action\.type,position:Number\(action\.position\)\};partyBroadcast\(encryptMessage\(party\.secret,event\)\);return\{ok:true\}\}\);/);
});

test('in relay mode the host never re-broadcasts a client\'s raw message itself - the relay already delivered it directly to every other peer, so a second host-originated copy would double-apply play/pause/position on everyone else',()=>{
 assert.match(main,/if\(party\?\.role==='host'&&party\.mode!=='relay'\)\{const payload=encryptMessage\(party\.secret,\{\.\.\.msg,from:fromId\}\);for\(const\[id,m\]of party\.members\)if\(id!==fromId&&m\.ws&&m\.ws\.readyState===WebSocket\.OPEN\)m\.ws\.send\(payload\)\}sendToRenderer\('party:event',\{type:'message',from:fromId,message:msg\}\)/);
});

test('hosting with mode "relay" requires R3-Party-Sync to be configured in Settings first, and fails with a clear error rather than silently falling back to direct mode',()=>{
 assert.match(main,/handle\('party:host',async\(_e,\{name:rawName,mode\}=\{\}\)=>\{if\(party\)throw new Error\('You are already in a party\. Leave it first\.'\);/);
 assert.match(main,/if\(mode==='relay'\)\{const creds=partySyncCredentials\(\);if\(!creds\.url\|\|!creds\.inviteKey\)throw new Error\('Configure R3-Party-Sync in Settings first\.'\);/);
});

test('the relay host branch calls the worker\'s /host endpoint to mint a room, opens its own claiming connection with the returned token, and encodes a v2 relay share code instead of a LAN/WAN one',()=>{
 assert.match(main,/const\{roomId,roomToken\}=await getJson\(`\$\{creds\.url\}\/host`,\{method:'POST',headers:\{'Content-Type':'application\/json'\},body:JSON\.stringify\(\{inviteKey:creds\.inviteKey\}\)\}\);/);
 assert.match(main,/const ws=await connectRelayWs\(creds\.url,roomId,\{token:roomToken\}\);/);
 assert.match(main,/party=\{role:'host',mode:'relay',ws,relayUrl:creds\.url,roomId,secret,members,hostId,selfName:name,hostName:name,queue:\[\]\};/);
 assert.match(main,/return\{ok:true,code:encodeRelayShareCode\(\{relay:\{url:creds\.url,roomId\},secret,name\}\)\}\}/);
});

test('the relay host derives sender identity from the routing envelope\'s connId, not a self-declared field, and registers a member only once it has said hello',()=>{
 assert.match(main,/if\(envelope\.type!=='relay'\)return;const msg=decryptMessage\(secret,envelope\.body\);if\(!msg\)return;const fromId=String\(envelope\.connId\|\|''\);if\(msg\.type==='hello'\)\{members\.set\(fromId,\{id:fromId,name:String\(msg\.name\|\|'Guest'\)\.slice\(0,40\)\|\|'Guest',isHost:false\}\);broadcastPartyState\(\);return\}/);
 assert.match(main,/if\(msg\.type==='leave'\)\{if\(members\.delete\(fromId\)\)broadcastPartyState\(\);return\}if\(!members\.has\(fromId\)\)return;handlePartyMessage\(fromId,msg\)/);
});

test('joining a v2 share code connects to the relay instead of a direct LAN/WAN endpoint, learning its own id from the room\'s assigned frame instead of waiting on a direct-mode welcome reply',()=>{
 assert.match(main,/if\(parsed\.v===2\)\{const ws=await connectRelayWs\(parsed\.relay\.url,parsed\.relay\.roomId,\{secret:parsed\.secret,helloName:displayName\}\);party=\{role:'client',mode:'relay',ws,secret:parsed\.secret,members:\[\],selfName:displayName,hostName:parsed\.name\|\|'',selfId:'',queue:\[\]\};/);
 assert.match(main,/if\(envelope\.type==='assigned'\)\{party\.selfId=String\(envelope\.connId\|\|''\);return\}/);
});

test('a relay-mode client only trusts a nowPlaying or seek message when the envelope says it came from the server-verified host connection, since the relay is a mesh and any peer could otherwise deliver a forged one directly to another peer',()=>{
 assert.match(main,/if\(!envelope\.isHost&&\(msg\.type==='nowPlaying'\|\|msg\.type==='seek'\)\)return;handlePartyMessage\(envelope\.isHost\?'host':String\(envelope\.connId\|\|''\),msg\)/);
});

test('a graceful host departure is recognized by a relay-mode client and treated the same as a direct-mode host disconnecting',()=>{
 assert.match(main,/if\(envelope\.isHost&&msg\.type==='leave'\)\{party=null;sendToRenderer\('party:event',\{type:'host-disconnected'\}\);return\}/);
});

test('direct-mode host and client party objects are explicitly tagged mode:\'direct\', so the relay checks elsewhere have a defined value to compare against rather than relying on undefined',()=>{
 assert.match(main,/party=\{role:'host',mode:'direct',wss,port,secret,members,hostId,selfName:name,hostName:name,queue:\[\]\};/);
 assert.match(main,/party=\{role:'client',mode:'direct',ws,secret:parsed\.secret,members:\[\],selfName:displayName,hostName:parsed\.name\|\|'',selfId:'',queue:\[\]\};/);
});

test('connectRelayWs builds a wss:// URL under the room path, appends the claim token only when present, and times out like the direct-mode connector instead of hanging forever',()=>{
 assert.match(main,/function connectRelayWs\(relayUrl,roomId,\{token='',secret='',helloName='',WebSocketImpl=WebSocket\}=\{\}\)\{return new Promise\(\(resolve,reject\)=>\{const wsUrl=`\$\{relayUrl\.replace\(\/\^http\/,'ws'\)\}\/party\/\$\{encodeURIComponent\(roomId\)\}\$\{token\?`\?token=\$\{encodeURIComponent\(token\)\}`:''\}`;/);
 assert.match(main,/const timer=setTimeout\(\(\)=>\{ws\.terminate\?\.\(\);reject\(new Error\('R3-Party-Sync connection timed out\.'\)\)\},8000\);/);
});

test('closing a relay party sends a best-effort leave message before closing its one socket, and disconnecting from the worker/party-sync connect flow discards the room it verified with rather than actually joining it',()=>{
 assert.match(main,/if\(party\.mode==='relay'\)try\{party\.ws\.send\(encryptMessage\(party\.secret,\{type:'leave'\}\)\)\}catch\{\}/);
});

test('R3-Party-Sync credentials are stored encrypted like every other integration, and connecting probes the worker\'s /host endpoint once before saving so a bad URL or revoked key fails immediately in Settings',()=>{
 assert.match(main,/function partySyncCredentials\(\)\{const s=readSettings\(\);return\{url:s\.partySyncUrl\|\|'',inviteKey:decrypt\(s\.partySyncInviteKey\|\|''\)\}\}/);
 assert.match(main,/handle\('party-sync:connect',async\(_e,\{url,inviteKey\}=\{\}\)=>\{/);
 assert.match(main,/try\{await getJson\(`\$\{trimmedUrl\}\/host`,\{method:'POST',headers:\{'Content-Type':'application\/json'\},body:JSON\.stringify\(\{inviteKey:key\}\)\}\);const s=readSettings\(\);s\.partySyncUrl=trimmedUrl;s\.partySyncInviteKey=encrypt\(key\);writeSettings\(s\);/);
 assert.match(main,/handle\('party-sync:disconnect',\(\)=>\{const s=readSettings\(\);delete s\.partySyncUrl;delete s\.partySyncInviteKey;writeSettings\(s\);return\{ok:true\}\}\);/);
});

test('an admin/host API error surfaces its real reason (the worker responds with an "error" field, not TorBox\'s "detail" convention) instead of a generic status-code message',()=>{
 assert.match(main,/const error=new Error\(body\.detail\|\|body\.error\|\|`Request failed \(\$\{response\.status\}\)`\);/);
});

test('settings:get exposes whether R3-Party-Sync is connected, and the worker URL is included in the settings the renderer can prefill',()=>{
 assert.match(main,/partySyncConnected:Boolean\(partySyncCredentials\(\)\.url&&partySyncCredentials\(\)\.inviteKey\)/);
 assert.match(preferences,/partySyncUrl:String\(settings\.partySyncUrl\|\|''\)/);
});

test('preload exposes the party-sync connect/disconnect channels and the host channel now carries a mode alongside the display name',()=>{
 assert.match(preload,/partyHost:\(name,mode\)=>ipcRenderer\.invoke\('party:host',\{name,mode\}\)/);
 assert.match(preload,/partySyncConnect:payload=>ipcRenderer\.invoke\('party-sync:connect',payload\)/);
 assert.match(preload,/partySyncDisconnect:\(\)=>ipcRenderer\.invoke\('party-sync:disconnect'\)/);
});

test('the host lobby offers a connection mode choice and passes it through when hosting, and the share-code panel skips the LAN-only warning for a relay-hosted party',()=>{
 assert.match(renderer,/<select id="partyHostMode"><option value="direct">Direct \(LAN\/UPnP\)<\/option><option value="relay">R3-Party-Sync<\/option><\/select>/);
 assert.match(renderer,/window\.mediaHub\.partyHost\(\$\('#partyHostName'\)\.value,\$\('#partyHostMode'\)\.value\)/);
 assert.match(renderer,/\$\{status\.mode==='relay'\|\|lastPartyWan\?'':'<p class="muted-note">Automatic internet port-forwarding was unavailable/);
});

test('the Settings page has an R3-Party-Sync card that verifies and saves the worker URL and invite key, and offers to disconnect once connected',()=>{
 assert.match(renderer,/<b>R3-Party-Sync<\/b><span class="connection-pill \$\{settings\.partySyncConnected\?'connected':''\}">/);
 assert.match(renderer,/id="settingsPartySyncUrl"[\s\S]{0,120}value="\$\{esc\(settings\.partySyncUrl\|\|''\)\}"/);
 assert.match(renderer,/\$\('#savePartySync'\)\.onclick=async\(\)=>\{const button=\$\('#savePartySync'\),url=\$\('#settingsPartySyncUrl'\)\.value,inviteKey=\$\('#settingsPartySyncKey'\)\.value;[\s\S]{0,200}window\.mediaHub\.partySyncConnect\(\{url,inviteKey\}\)/);
 assert.match(renderer,/if\(\$\('#disconnectPartySync'\)\)\$\('#disconnectPartySync'\)\.onclick=async\(\)=>\{await window\.mediaHub\.partySyncDisconnect\(\);openAppSettings\(\)\}/);
});
