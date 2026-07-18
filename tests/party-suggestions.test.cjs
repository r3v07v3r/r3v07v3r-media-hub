const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
test('the host applies suggest/remove events to its own authoritative queue and rebroadcasts a fresh queue-sync to everyone, instead of just relaying the raw message like other event types',()=>{
 assert.match(main,/function broadcastQueue\(\)\{if\(!party\|\|party\.role!=='host'\)return;/);
 assert.match(main,/function handlePartyMessage\(fromId,msg\)\{if\(party\?\.role==='host'&&\(msg\?\.type==='suggest'\|\|msg\?\.type==='remove'\)\)\{party\.queue=applyQueueEvent\(party\.queue,msg\);broadcastQueue\(\);return\}/);
});
test('a client receiving queue-sync applies it locally and pushes the result to the renderer, mirroring how party-state already works',()=>{
 assert.match(main,/if\(msg\.type==='queue-sync'\)\{party\.queue=applyQueueEvent\(party\.queue,msg\);sendToRenderer\('party:event',\{type:'queue-sync',queue:party\.queue\}\);return\}/);
});
test('suggesting or removing applies directly when you are the host, but is sent to the host to process when you are a client, since only the host owns the authoritative queue',()=>{
 assert.match(main,/handle\('party:suggest',\(_e,item\)=>\{if\(!party\)throw new Error\('You are not in a party\.'\);if\(!item\|\|item\.id===undefined\|\|item\.id===null\)throw new Error\('Nothing to suggest\.'\);/);
 assert.match(main,/if\(party\.role==='host'\)\{party\.queue=applyQueueEvent\(party\.queue,event\);broadcastQueue\(\)\}else\{party\.ws\.send\(encryptMessage\(party\.secret,event\)\)\}return\{ok:true\}\}\);\s*handle\('party:remove'/);
});
test('preload exposes suggest, remove and queue-fetch channels',()=>{
 assert.match(preload,/partySuggest:item=>ipcRenderer\.invoke\('party:suggest',item\)/);
 assert.match(preload,/partyRemove:queueId=>ipcRenderer\.invoke\('party:remove',queueId\)/);
 assert.match(preload,/partyQueue:\(\)=>ipcRenderer\.invoke\('party:queue'\)/);
});
test('the party room lets any member search the live catalog and suggest a result, reusing the existing search IPC rather than a new lookup path',()=>{
 assert.match(renderer,/id="partySuggestKind"/);
 assert.match(renderer,/id="partySuggestQuery"/);
 assert.match(renderer,/window\.mediaHub\.search\(\$\('#partySuggestKind'\)\.value,query\)/);
 assert.match(renderer,/window\.mediaHub\.partySuggest\(\{id:picked\.id,type:picked\.type,title:picked\.title,poster:picked\.poster,year:picked\.year\}\)/);
});
test('the shared queue renders every suggestion with who suggested it and a remove control, and fetches fresh from IPC rather than caching stale state across re-renders',()=>{
 assert.match(renderer,/const\{queue\}=await window\.mediaHub\.partyQueue\(\)/);
 assert.match(renderer,/Suggested by \$\{esc\(q\.suggestedBy\|\|'Someone'\)\}/);
 assert.match(renderer,/window\.mediaHub\.partyRemove\(button\.dataset\.queueId\)/);
 assert.match(renderer,/Nothing suggested yet\./);
});
