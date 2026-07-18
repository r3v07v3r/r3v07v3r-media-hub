const test=require('node:test'),assert=require('node:assert/strict');
const {buildSearchParams,normalizeSubtitleResult,srtToVtt}=require('../src/opensubtitles.cjs');
test('search params use the IMDB id for movies and series, and a title query with season/episode for anime which has no IMDB equivalent',()=>{
 assert.deepEqual(buildSearchParams({id:'tt0241527',type:'movie',title:'Harry Potter'},{language:'en'}),{languages:'en',imdb_id:'0241527'});
 assert.deepEqual(buildSearchParams({id:'tt11198330',type:'series',title:'House of the Dragon'},{language:'en',season:1,episode:3}),{languages:'en',imdb_id:'11198330',season_number:1,episode_number:3});
 assert.deepEqual(buildSearchParams({id:'kitsu:42',type:'anime',title:'Elfen Lied'},{language:'en',season:1,episode:1}),{languages:'en',query:'Elfen Lied',season_number:1,episode_number:1});
});
test('search params default to English and omit season/episode for movies',()=>{
 assert.deepEqual(buildSearchParams({id:'tt1',type:'movie',title:'A Movie'}),{languages:'en',imdb_id:'1'});
});
test('subtitle results normalize the first file, tolerate missing fields, and reject entries with no downloadable file',()=>{
 const entry=normalizeSubtitleResult({id:'123',attributes:{language:'en',release:'Elfen.Lied.S01E01.BluRay',download_count:450,uploader:{name:'subber'},hearing_impaired:false,files:[{file_id:998877,file_name:'elfen.lied.s01e01.srt'}]}});
 assert.deepEqual(entry,{id:'123',fileId:998877,fileName:'elfen.lied.s01e01.srt',language:'en',releaseName:'Elfen.Lied.S01E01.BluRay',downloadCount:450,uploader:'subber',hearingImpaired:false});
 assert.deepEqual(normalizeSubtitleResult({}),{id:'',fileId:0,fileName:'',language:'',releaseName:'',downloadCount:0,uploader:'Anonymous',hearingImpaired:false});
});
test('SRT is converted to WebVTT by adding the header and switching comma to period in timestamps',()=>{
 const srt='1\r\n00:00:01,000 --> 00:00:04,500\r\nHello there\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\nSecond line\r\n';
 const vtt=srtToVtt(srt);
 assert.match(vtt,/^WEBVTT\n\n/);
 assert.match(vtt,/00:00:01\.000 --> 00:00:04\.500/);
 assert.match(vtt,/00:00:05\.000 --> 00:00:07\.000/);
 assert.doesNotMatch(vtt,/,\d{3} -->/);
});
