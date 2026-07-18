const test=require('node:test'),assert=require('node:assert/strict');
const {buildAuthorizeUrl,normalizeMalEntry}=require('../src/mal.cjs');
test('MAL authorize URL uses PKCE plain method since MyAnimeList does not support S256',()=>{
 const url=new URL(buildAuthorizeUrl('client-123','state-abc','verifier-xyz','http://127.0.0.1:48765/mal/callback'));
 assert.equal(url.origin+url.pathname,'https://myanimelist.net/v1/oauth2/authorize');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('client_id'),'client-123');
 assert.equal(url.searchParams.get('state'),'state-abc');
 assert.equal(url.searchParams.get('redirect_uri'),'http://127.0.0.1:48765/mal/callback');
 assert.equal(url.searchParams.get('code_challenge'),'verifier-xyz');
 assert.equal(url.searchParams.get('code_challenge_method'),'plain');
});
test('MAL list entries normalize node and list_status fields with safe fallbacks',()=>{
 const entry=normalizeMalEntry({node:{id:5114,title:'Fullmetal Alchemist: Brotherhood'},list_status:{status:'watching',num_episodes_watched:12}});
 assert.deepEqual(entry,{malId:5114,title:'Fullmetal Alchemist: Brotherhood',status:'watching',watchedEpisodes:12});
 assert.deepEqual(normalizeMalEntry({}),{malId:0,title:'Untitled',status:'',watchedEpisodes:0});
});
