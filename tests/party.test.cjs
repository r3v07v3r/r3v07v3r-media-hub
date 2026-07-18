const test=require('node:test'),assert=require('node:assert/strict');
const {isValidEndpoint,isValidRelayEndpoint,encodeShareCode,encodeRelayShareCode,decodeShareCode,deriveKey,encryptMessage,decryptMessage,createMemberId,applyQueueEvent,queueScore,sortQueue}=require('../src/party.cjs');
test('endpoints are only valid with a real IP/host string and an in-range port',()=>{
 assert.equal(isValidEndpoint({ip:'192.168.1.50',port:41234}),true);
 assert.equal(isValidEndpoint({ip:'203.0.113.7',port:80}),true);
 assert.equal(isValidEndpoint({ip:'192.168.1.50',port:0}),false);
 assert.equal(isValidEndpoint({ip:'192.168.1.50',port:70000}),false);
 assert.equal(isValidEndpoint({ip:'',port:41234}),false);
 assert.equal(isValidEndpoint({ip:'evil";DROP TABLE',port:41234}),false);
 assert.equal(isValidEndpoint(null),false);
});
test('a share code round-trips the LAN endpoint, secret and name, and omits WAN when unavailable',()=>{
 const code=encodeShareCode({lan:{ip:'192.168.1.50',port:41234},wan:null,secret:'s3cr3t',name:'Alex'});
 const decoded=decodeShareCode(code);
 assert.deepEqual(decoded,{v:1,lan:{ip:'192.168.1.50',port:41234},wan:null,secret:'s3cr3t',name:'Alex'});
});
test('a share code carries both LAN and WAN endpoints when UPnP mapping succeeded',()=>{
 const code=encodeShareCode({lan:{ip:'192.168.1.50',port:41234},wan:{ip:'203.0.113.7',port:55000},secret:'s3cr3t',name:'Alex'});
 assert.deepEqual(decodeShareCode(code).wan,{ip:'203.0.113.7',port:55000});
});
test('decoding rejects malformed, tampered, or unsupported-version share codes instead of throwing',()=>{
 assert.equal(decodeShareCode('not-base64-json'),null);
 assert.equal(decodeShareCode(''),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:3,lan:{ip:'1.2.3.4',port:1},secret:'x'})).toString('base64url')),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:1,lan:{ip:'1.2.3.4',port:99999},secret:'x'})).toString('base64url')),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:1,lan:{ip:'1.2.3.4',port:1}})).toString('base64url')),null);
});
test('a v2 (relay) share code with no relay endpoint at all is rejected the same as any other malformed code',()=>{
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:2,secret:'x'})).toString('base64url')),null);
});
test('relay endpoints are only valid with an https URL and a UUID-shaped room id, matching exactly what the Worker mints',()=>{
 assert.equal(isValidRelayEndpoint({url:'https://sync.example.workers.dev',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'}),true);
 assert.equal(isValidRelayEndpoint({url:'http://sync.example.workers.dev',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'}),false);
 assert.equal(isValidRelayEndpoint({url:'https://sync.example.workers.dev',roomId:'not-a-uuid'}),false);
 assert.equal(isValidRelayEndpoint({url:'not a url',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'}),false);
 assert.equal(isValidRelayEndpoint(null),false);
});
test('a relay share code round-trips the worker url, room id, secret and name',()=>{
 const relay={url:'https://sync.example.workers.dev',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'};
 const code=encodeRelayShareCode({relay,secret:'s3cr3t',name:'Alex'});
 assert.deepEqual(decodeShareCode(code),{v:2,relay,secret:'s3cr3t',name:'Alex'});
});
test('encoding a relay share code rejects an invalid relay endpoint or a missing secret up front',()=>{
 assert.throws(()=>encodeRelayShareCode({relay:{url:'not a url',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'},secret:'s'}));
 assert.throws(()=>encodeRelayShareCode({relay:{url:'https://sync.example.workers.dev',roomId:'8f14e45f-ceea-4a3d-8e0f-9c1a4f5b6c7d'},secret:''}));
});
test('encoding rejects an invalid LAN endpoint or a missing secret up front, since every party needs at least a reachable host and a key',()=>{
 assert.throws(()=>encodeShareCode({lan:{ip:'',port:1},secret:'s'}));
 assert.throws(()=>encodeShareCode({lan:{ip:'1.2.3.4',port:1},secret:''}));
});
test('messages encrypted with one secret cannot be decrypted with a different one, and tampered ciphertext is rejected by the GCM auth tag',()=>{
 const raw=encryptMessage('correct-secret',{type:'hello',name:'Alex'});
 assert.deepEqual(decryptMessage('correct-secret',raw),{type:'hello',name:'Alex'});
 assert.equal(decryptMessage('wrong-secret',raw),null);
 const tampered=JSON.parse(raw);tampered.ct=Buffer.from('tampered payload').toString('base64');
 assert.equal(decryptMessage('correct-secret',JSON.stringify(tampered)),null);
});
test('deriveKey produces a stable 32-byte AES-256 key for a given secret',()=>{
 const key=deriveKey('some-secret');
 assert.equal(key.length,32);
 assert.deepEqual(key,deriveKey('some-secret'));
 assert.notDeepEqual(key,deriveKey('other-secret'));
});
test('member ids are short random hex strings suitable as map keys',()=>{
 const id=createMemberId(size=>Buffer.alloc(size,7));
 assert.equal(id,'07'.repeat(8));
 assert.equal(typeof createMemberId(),'string');
 assert.equal(createMemberId().length,16);
});
test('suggesting a title adds it to the queue at rank zero (no votes yet), but a second suggestion of the same catalog item is silently deduped',()=>{
 const first=applyQueueEvent([],{type:'suggest',queueId:'q1',item:{id:'tt1',title:'A Movie'},suggestedBy:'Alex'});
 assert.deepEqual(first,[{queueId:'q1',item:{id:'tt1',title:'A Movie'},suggestedBy:'Alex',votes:{}}]);
 assert.equal(queueScore(first[0]),0);
 const second=applyQueueEvent(first,{type:'suggest',queueId:'q2',item:{id:'tt1',title:'A Movie'},suggestedBy:'Sam'});
 assert.equal(second.length,1);
});
test('voting up or down changes an item\'s score and re-sorts the queue highest-first, ties keeping their original order',()=>{
 const queue=[{queueId:'q1',item:{id:'a'},suggestedBy:'Alex',votes:{}},{queueId:'q2',item:{id:'b'},suggestedBy:'Sam',votes:{}}];
 const upvoted=applyQueueEvent(queue,{type:'vote',queueId:'q2',voterId:'v1',direction:1});
 assert.equal(queueScore(upvoted.find(x=>x.queueId==='q2')),1);
 assert.deepEqual(upvoted.map(x=>x.queueId),['q2','q1']);
 const alsoUp=applyQueueEvent(upvoted,{type:'vote',queueId:'q1',voterId:'v2',direction:-1});
 assert.equal(queueScore(alsoUp.find(x=>x.queueId==='q1')),-1);
 assert.deepEqual(alsoUp.map(x=>x.queueId),['q2','q1']);
});
test('voting the same direction twice retracts the vote instead of double-counting it',()=>{
 const queue=[{queueId:'q1',item:{id:'a'},votes:{}}];
 const voted=applyQueueEvent(queue,{type:'vote',queueId:'q1',voterId:'v1',direction:1});
 assert.equal(queueScore(voted[0]),1);
 const retracted=applyQueueEvent(voted,{type:'vote',queueId:'q1',voterId:'v1',direction:1});
 assert.equal(queueScore(retracted[0]),0);
});
test('switching a vote from up to down replaces the prior vote rather than stacking both',()=>{
 const queue=[{queueId:'q1',item:{id:'a'},votes:{}}];
 const up=applyQueueEvent(queue,{type:'vote',queueId:'q1',voterId:'v1',direction:1});
 const switched=applyQueueEvent(up,{type:'vote',queueId:'q1',voterId:'v1',direction:-1});
 assert.equal(queueScore(switched[0]),-1);
});
test('a vote with an invalid direction or missing voter id is ignored instead of corrupting the queue',()=>{
 const queue=[{queueId:'q1',item:{id:'a'},votes:{}}];
 assert.deepEqual(applyQueueEvent(queue,{type:'vote',queueId:'q1',voterId:'v1',direction:0}),queue);
 assert.deepEqual(applyQueueEvent(queue,{type:'vote',queueId:'q1',voterId:'',direction:1}),queue);
});
test('sortQueue orders by descending score and is stable for ties',()=>{
 const list=[{queueId:'a',votes:{x:1}},{queueId:'b',votes:{}},{queueId:'c',votes:{x:1,y:1}},{queueId:'d',votes:{}}];
 assert.deepEqual(sortQueue(list).map(x=>x.queueId),['c','a','b','d']);
});
test('suggesting with no item, or one with no id, is ignored rather than corrupting the queue',()=>{
 assert.deepEqual(applyQueueEvent([],{type:'suggest',queueId:'q1'}),[]);
 assert.deepEqual(applyQueueEvent([],{type:'suggest',queueId:'q1',item:{title:'No id'}}),[]);
});
test('removing drops only the matching queue entry by its own queueId, leaving the rest untouched',()=>{
 const queue=[{queueId:'q1',item:{id:'a'},suggestedBy:'Alex'},{queueId:'q2',item:{id:'b'},suggestedBy:'Sam'}];
 assert.deepEqual(applyQueueEvent(queue,{type:'remove',queueId:'q1'}),[{queueId:'q2',item:{id:'b'},suggestedBy:'Sam'}]);
 assert.deepEqual(applyQueueEvent(queue,{type:'remove',queueId:'not-present'}),queue);
});
test('a queue-sync event replaces the whole local queue with the host\'s authoritative list',()=>{
 const incoming=[{queueId:'q9',item:{id:'z'},suggestedBy:'Host'}];
 assert.deepEqual(applyQueueEvent([{queueId:'stale',item:{id:'old'}}],{type:'queue-sync',queue:incoming}),incoming);
});
test('an unrecognized event type leaves the queue unchanged instead of throwing',()=>{
 const queue=[{queueId:'q1',item:{id:'a'}}];
 assert.deepEqual(applyQueueEvent(queue,{type:'nowPlaying'}),queue);
 assert.deepEqual(applyQueueEvent(queue,null),queue);
});
