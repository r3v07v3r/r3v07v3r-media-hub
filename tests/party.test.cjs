const test=require('node:test'),assert=require('node:assert/strict');
const {isValidEndpoint,encodeShareCode,decodeShareCode,deriveKey,encryptMessage,decryptMessage,createMemberId,applyQueueEvent}=require('../src/party.cjs');
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
test('decoding rejects malformed, tampered, or wrong-version share codes instead of throwing',()=>{
 assert.equal(decodeShareCode('not-base64-json'),null);
 assert.equal(decodeShareCode(''),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:2,lan:{ip:'1.2.3.4',port:1},secret:'x'})).toString('base64url')),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:1,lan:{ip:'1.2.3.4',port:99999},secret:'x'})).toString('base64url')),null);
 assert.equal(decodeShareCode(Buffer.from(JSON.stringify({v:1,lan:{ip:'1.2.3.4',port:1}})).toString('base64url')),null);
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
test('suggesting a title adds it to the queue but a second suggestion of the same catalog item is silently deduped',()=>{
 const first=applyQueueEvent([],{type:'suggest',queueId:'q1',item:{id:'tt1',title:'A Movie'},suggestedBy:'Alex'});
 assert.deepEqual(first,[{queueId:'q1',item:{id:'tt1',title:'A Movie'},suggestedBy:'Alex'}]);
 const second=applyQueueEvent(first,{type:'suggest',queueId:'q2',item:{id:'tt1',title:'A Movie'},suggestedBy:'Sam'});
 assert.equal(second.length,1);
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
