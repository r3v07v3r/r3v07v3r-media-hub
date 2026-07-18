const test=require('node:test'),assert=require('node:assert/strict');
const {buildAuthorizeUrl,normalizeMalEntry,localWatchedEpisodeCounts,computeReconciliation}=require('../src/mal.cjs');
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
test('local watched episode counts dedupe overlapping local and Simkl history entries and ignore non-anime titles',()=>{
 const history=[
  {id:'kitsu:7442',season:1,episode:1},
  {id:'kitsu:7442',season:1,episode:1},
  {id:'kitsu:7442',season:1,episode:2},
  {id:'tt0241527',season:null,episode:null},
  {id:'kitsu:1',season:1,episode:NaN},
 ];
 assert.deepEqual(localWatchedEpisodeCounts(history),{'kitsu:7442':2});
});
test('reconciliation diff pushes MAL-ahead titles to local/Simkl, local-ahead titles to MAL, and unmatched titles to their own bucket',()=>{
 const malEntries=[
  {malId:1,title:'Ahead on MAL',kitsuId:'kitsu:1',watchedEpisodes:12},
  {malId:2,title:'Ahead locally',kitsuId:'kitsu:2',watchedEpisodes:3},
  {malId:3,title:'Already in sync',kitsuId:'kitsu:3',watchedEpisodes:5},
  {malId:4,title:'No Kitsu mapping found',kitsuId:'',watchedEpisodes:8},
 ];
 const localProgress={'kitsu:1':4,'kitsu:2':10,'kitsu:3':5};
 const diff=computeReconciliation(malEntries,localProgress);
 assert.deepEqual(diff.toLocal,[{kitsuId:'kitsu:1',title:'Ahead on MAL',fromEpisode:5,toEpisode:12}]);
 assert.deepEqual(diff.toMal,[{kitsuId:'kitsu:2',malId:2,title:'Ahead locally',watchedEpisodes:10}]);
 assert.equal(diff.unmatched.length,1);
 assert.equal(diff.unmatched[0].title,'No Kitsu mapping found');
});
