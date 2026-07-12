const test = require('node:test');
const assert = require('node:assert/strict');
const { filterCatalog, createRoomCode, rankStreams, validateTorBoxToken, meteorConfigPath, normalizeMeta, selectPlayableStream, selectVideoFile } = require('../src/core.cjs');

const catalog = [{ title:'Dune: Part Two',type:'movie',year:2024 },{ title:'Frieren',type:'anime',year:2023 },{ title:'Shōgun',type:'series',year:2024 }];
test('catalog filtering combines section and search query',()=>assert.deepEqual(filterCatalog(catalog,'anime','frie').map(x=>x.title),['Frieren']));
test('room codes are human-readable and avoid ambiguous characters',()=>{const code=createRoomCode(()=>.1);assert.match(code,/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);assert.equal(/[01IO]/.test(code),false)});
test('stream ranking prefers exact cached compatible releases over raw resolution',()=>{const s=[{name:'4K mismatch',exact:false,cached:true,compatible:true,resolution:2160},{name:'1080p exact',exact:true,cached:true,compatible:true,resolution:1080}];assert.equal(rankStreams(s)[0].name,'1080p exact')});
test('TorBox token validation rejects empty and implausibly short tokens',()=>{assert.equal(validateTorBoxToken(''),false);assert.equal(validateTorBoxToken('short'),false);assert.equal(validateTorBoxToken('tbx_example_token_value_1234567890'),true)});
test('Meteor configuration path is base64url JSON with TorBox credentials',()=>{const path=meteorConfigPath('token_abcdefghijklmnopqrstuvwxyz');assert.equal(/[+/=]/.test(path),false);const parsed=JSON.parse(Buffer.from(path,'base64url').toString());assert.equal(parsed.debridService,'torbox');assert.equal(parsed.debridApiKey,'token_abcdefghijklmnopqrstuvwxyz')});
test('live catalog metadata normalizes IDs posters and content type',()=>{const item=normalizeMeta({id:'tt123',name:'Live title',type:'movie',poster:'https://img',year:'2026'},'movie');assert.deepEqual(item,{id:'tt123',title:'Live title',type:'movie',poster:'https://img',background:'',year:'2026',description:'',rating:'',videos:[]})});
test('playable stream selection rejects non-URL streams and prefers cached 1080p exact',()=>{const best=selectPlayableStream([{name:'P2P',infoHash:'abc'},{name:'[TB+] 1080p',url:'https://play',title:'cached exact'}]);assert.equal(best.url,'https://play')});
test('stored TorBox file selection chooses the largest video file',()=>{const file=selectVideoFile([{id:1,name:'sample.mkv',size:100},{id:2,name:'movie.mkv',size:10000},{id:3,name:'readme.txt',size:20000}]);assert.equal(file.id,2)});
