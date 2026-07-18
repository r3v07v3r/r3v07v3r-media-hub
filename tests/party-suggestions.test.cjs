const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
test('the host applies suggest/vote events from a client to its own authoritative queue and rebroadcasts a fresh queue-sync to everyone, instead of just relaying the raw message like other event types',()=>{
 assert.match(main,/function broadcastQueue\(\)\{if\(!party\|\|party\.role!=='host'\)return;/);
 assert.match(main,/function handlePartyMessage\(fromId,msg\)\{if\(party\?\.role==='host'&&\(msg\?\.type==='suggest'\|\|msg\?\.type==='vote'\)\)\{/);
 assert.match(main,/party\.queue=applyQueueEvent\(party\.queue,event\);broadcastQueue\(\);return\}if\(party\?\.role==='host'&&msg\?\.type==='seek'\)return;/);
});
test('a client cannot remove a queue item by sending a message over the wire — removal is only ever applied locally by the host through its own IPC handler, never relayed as a client-originated event',()=>{
 assert.doesNotMatch(main,/msg\?\.type==='suggest'\|\|msg\?\.type==='remove'/);
 assert.match(main,/handle\('party:remove',\(_e,queueId\)=>\{if\(!party\)throw new Error\('You are not in a party\.'\);if\(party\.role!=='host'\)throw new Error\('Only the host can remove suggestions\.'\);/);
});
test('votes relayed from a client are re-stamped with that connection\'s verified member id server-side, instead of trusting whatever voterId the client message claims',()=>{
 assert.match(main,/const event=msg\.type==='vote'\?\{\.\.\.msg,voterId:fromId\}:/);
});
test('a client receiving queue-sync applies it locally and pushes the result to the renderer, mirroring how party-state already works',()=>{
 assert.match(main,/if\(msg\.type==='queue-sync'\)\{party\.queue=applyQueueEvent\(party\.queue,msg\);sendToRenderer\('party:event',\{type:'queue-sync',queue:party\.queue\}\);return\}/);
});
test('suggesting or removing applies directly when you are the host, but is sent to the host to process when you are a client, since only the host owns the authoritative queue',()=>{
 assert.match(main,/handle\('party:suggest',\(_e,item\)=>\{if\(!party\)throw new Error\('You are not in a party\.'\);if\(!item\|\|item\.id===undefined\|\|item\.id===null\)throw new Error\('Nothing to suggest\.'\);/);
 assert.match(main,/if\(party\.role==='host'\)\{party\.queue=applyQueueEvent\(party\.queue,event\);broadcastQueue\(\)\}else\{party\.ws\.send\(encryptMessage\(party\.secret,event\)\)\}return\{ok:true\}\}\);\s*handle\('party:remove'/);
});
test('preload exposes suggest, remove, vote and queue-fetch channels',()=>{
 assert.match(preload,/partySuggest:item=>ipcRenderer\.invoke\('party:suggest',item\)/);
 assert.match(preload,/partyRemove:queueId=>ipcRenderer\.invoke\('party:remove',queueId\)/);
 assert.match(preload,/partyVote:payload=>ipcRenderer\.invoke\('party:vote',payload\)/);
 assert.match(preload,/partyQueue:\(\)=>ipcRenderer\.invoke\('party:queue'\)/);
});
test('voting is only accepted once the connection knows its own verified member id, and a non-host member votes by sending the event to the host rather than mutating a local queue it does not own',()=>{
 assert.match(main,/handle\('party:vote',\(_e,\{queueId,direction\}=\{\}\)=>\{if\(!party\)throw new Error\('You are not in a party\.'\);const dir=Number\(direction\);if\(dir!==1&&dir!==-1\)throw new Error\('Invalid vote\.'\);const voterId=party\.role==='host'\?party\.hostId:party\.selfId;if\(!voterId\)throw new Error\('Still connecting to the party — try again in a moment\.'\);const event=\{type:'vote',queueId:String\(queueId\|\|''\),voterId,direction:dir\};if\(party\.role==='host'\)\{party\.queue=applyQueueEvent\(party\.queue,event\);broadcastQueue\(\)\}else\{party\.ws\.send\(encryptMessage\(party\.secret,event\)\)\}return\{ok:true\}\}\)/);
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
