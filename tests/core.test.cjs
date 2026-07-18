const test=require('node:test');const assert=require('node:assert/strict');
const {filterCatalog,isItemWatched,dedupeCatalog,episodeWatchState,airingStatus,continueWatchingList,createRoomCode,rankStreams,validateTorBoxToken,meteorConfigPath,meteorP2PConfigPath,normalizeMeta,normalizeKitsuAnime,normalizeKitsuEpisode,normalizeSimklCatalog,normalizeSimklSearchResult,filterAnimeRelationships,normalizeTmdbCollectionPart,parseReleaseName,enrichTorBoxItem,selectPlayableStream,selectVideoFile}=require('../src/core.cjs');
const catalog=[{title:'Dune: Part Two',type:'movie',year:2024},{title:'Frieren',type:'anime',year:2023},{title:'Shōgun',type:'series',year:2024}];
test('catalog filtering combines section and search query',()=>assert.deepEqual(filterCatalog(catalog,'anime','frie').map(x=>x.title),['Frieren']));
test('catalog filters include wanted genres and reject unwanted genres',()=>{const items=[{title:'Space Drama',year:2024,type:'movie',rating:'8.2',genres:['Drama','Sci-Fi']},{title:'Family Laughs',year:2023,type:'movie',rating:'7.5',genres:['Comedy','Family']},{title:'Dark Laughs',year:2022,type:'movie',rating:'8.8',genres:['Comedy','Horror']}];const result=filterCatalog(items,'movie','',{includeGenres:['Comedy'],excludeGenres:['Horror']});assert.deepEqual(result.map(x=>x.title),['Family Laughs'])});
test('an active genre filter does not hide live-search results, since Kitsu\'s search endpoint never returns genre data unlike the full catalog/detail endpoints',()=>{const items=[{title:'Prince of Tennis',year:2001,type:'anime',rating:'7.8',genres:[]},{title:'Random Comedy',year:2020,type:'anime',rating:'7.0',genres:['Comedy']},{title:'Random Drama',year:2020,type:'anime',rating:'7.0',genres:['Drama']}];const result=filterCatalog(items,'anime','',{includeGenres:['Comedy']});assert.deepEqual(result.map(x=>x.title),['Prince of Tennis','Random Comedy'])});
test('catalog filters rating and year then sorts by rating',()=>{const items=[{title:'Older',year:'2018',type:'movie',rating:'9.1',genres:[]},{title:'Lower',year:'2024',type:'movie',rating:'7.2',genres:[]},{title:'Best',year:'2023',type:'movie',rating:'8.8',genres:[]},{title:'Good',year:'2022',type:'movie',rating:'8.1',genres:[]}];const result=filterCatalog(items,'movie','',{minRating:8,minYear:2020,sort:'rating'});assert.deepEqual(result.map(x=>x.title),['Best','Good'])});
test('watch state recognizes title and episode history across catalog IDs',()=>{const history=[{id:'movie-1'},{id:'9001',season:1,episode:2}];assert.equal(isItemWatched({id:'movie-1'},history),true);assert.equal(isItemWatched({id:'series-imdb',simklId:9001},history),true);assert.equal(isItemWatched({id:'new-title'},history),false)});
test('catalog watch filter supports both unwatched-only and watched-only modes',()=>{const items=[{id:'a',title:'Watched',type:'movie'},{id:'b',title:'New',type:'movie'}],history=[{id:'a'}];assert.deepEqual(filterCatalog(items,'movie','',{watchMode:'both',history}).map(x=>x.id),['a','b']);assert.deepEqual(filterCatalog(items,'movie','',{watchMode:'unwatched',history}).map(x=>x.id),['b']);assert.deepEqual(filterCatalog(items,'movie','',{watchMode:'watched',history}).map(x=>x.id),['a'])});
test('tracked catalog keeps movies series and anime together',()=>{const source=[{id:'m',type:'movie',title:'Movie'},{id:'s',type:'series',title:'Series'},{id:'a',type:'anime',title:'Anime'}];assert.deepEqual(filterCatalog(source,'tracked').map(x=>x.id),['m','s','a'])});
test('episode watch state exposes watched episodes progress and next episode',()=>{const episodes=[{season:1,episode:1},{season:1,episode:2},{season:2,episode:1}],history=[{id:'show-1',season:1,episode:1},{id:'show-1',season:1,episode:2},{id:'other',season:2,episode:1}];const state=episodeWatchState(episodes,history,'show-1');assert.equal(state.watchedCount,2);assert.equal(state.percent,67);assert.equal(state.nextIndex,2);assert.deepEqual([...state.watchedKeys],['1:1','1:2'])});
test('broad catalog merging removes duplicate IDs without dropping source order',()=>{const merged=dedupeCatalog([[{id:'a',title:'A'},{id:'b',title:'B'}],[{id:'b',title:'B duplicate'},{id:'c',title:'C'}]]);assert.deepEqual(merged.map(x=>x.title),['A','B','C'])});
test('room codes are human-readable and avoid ambiguous characters',()=>{const code=createRoomCode(()=>.1);assert.match(code,/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);assert.equal(/[01IO]/.test(code),false)});
test('stream ranking prefers exact cached compatible releases over raw resolution',()=>{const s=[{name:'4K mismatch',exact:false,cached:true,compatible:true,resolution:2160},{name:'1080p exact',exact:true,cached:true,compatible:true,resolution:1080}];assert.equal(rankStreams(s)[0].name,'1080p exact')});
test('TorBox token validation rejects empty and implausibly short tokens',()=>{assert.equal(validateTorBoxToken(''),false);assert.equal(validateTorBoxToken('short'),false);assert.equal(validateTorBoxToken('tbx_example_token_value_1234567890'),true)});
test('Meteor configuration path is base64url JSON with TorBox credentials',()=>{const p=meteorConfigPath('token_abcdefghijklmnopqrstuvwxyz'),parsed=JSON.parse(Buffer.from(p,'base64url').toString());assert.equal(/[+/=]/.test(p),false);assert.equal(parsed.debridService,'torbox');assert.equal(parsed.debridApiKey,'token_abcdefghijklmnopqrstuvwxyz')});
test('Meteor P2P discovery configuration contains no TorBox credential',()=>{const parsed=JSON.parse(Buffer.from(meteorP2PConfigPath(),'base64url').toString());assert.equal(parsed.debridService,'torrent');assert.equal(parsed.debridApiKey,'');assert.equal(JSON.stringify(parsed).includes('token'),false)});
test('live catalog metadata normalizes artwork genres and trailers',()=>{const item=normalizeMeta({id:'tt123',name:'Live title',type:'movie',poster:'https://img',background:'https://backdrop',logo:'https://logo',year:'2026',genre:['Drama'],trailers:[{source:'abc123',type:'Trailer'}]},'movie');assert.deepEqual(item,{id:'tt123',title:'Live title',type:'movie',poster:'https://img',background:'https://backdrop',logo:'https://logo',year:'2026',status:'',description:'',rating:'',runtime:'',genres:['Drama'],videos:[],trailers:[{source:'abc123',type:'Trailer',name:'Trailer'}]})});
test('metadata carries through an explicit airing status field when the source provides one',()=>{const item=normalizeMeta({id:'tt999',name:'Returning show',type:'series',status:'Returning Series'},'series');assert.equal(item.status,'Returning Series')});
test('direct Kitsu records normalize into app anime and episode metadata',()=>{const anime=normalizeKitsuAnime({id:'7442',attributes:{canonicalTitle:'Attack on Titan',posterImage:{large:'poster'},coverImage:{large:'cover'},startDate:'2013-04-07',synopsis:'Titans',averageRating:'84.48',episodeCount:25,youtubeVideoId:'trailer123',status:'current'}});assert.equal(anime.id,'kitsu:7442');assert.equal(anime.title,'Attack on Titan');assert.equal(anime.status,'current');assert.equal(anime.trailers[0].source,'trailer123');const episode=normalizeKitsuEpisode({id:'1',attributes:{canonicalTitle:'To You',seasonNumber:1,number:2,airdate:'2013-04-14'}},'kitsu:7442');assert.deepEqual(episode,{id:'kitsu:7442:1:2',season:1,episode:2,number:2,title:'To You',released:'2013-04-14'})});
test('airing status normalizes Kitsu and Cinemeta/TMDB vocabularies into one set of states',()=>{assert.equal(airingStatus({status:'current'}),'airing');assert.equal(airingStatus({status:'Returning Series'}),'airing');assert.equal(airingStatus({status:'In Production'}),'airing');assert.equal(airingStatus({status:'finished'}),'ended');assert.equal(airingStatus({status:'Ended'}),'ended');assert.equal(airingStatus({status:'Canceled'}),'ended');assert.equal(airingStatus({status:'upcoming'}),'upcoming');assert.equal(airingStatus({status:'Planned'}),'upcoming');assert.equal(airingStatus({status:'Pilot'}),'upcoming');assert.equal(airingStatus({}),'unknown')});
test('airing status falls back to a release-date heuristic when no explicit status string is present',()=>{const now=new Date('2026-06-01');assert.equal(airingStatus({videos:[{released:'2026-07-01'}]},now),'airing');assert.equal(airingStatus({videos:[{released:'2026-05-20'}]},now),'airing');assert.equal(airingStatus({videos:[{released:'2020-01-01'}]},now),'unknown');assert.equal(airingStatus({videos:[]},now),'unknown')});
test('Simkl fallback catalogs normalize IMDb IDs artwork and trailers',()=>{const item=normalizeSimklCatalog({title:'House of the Dragon',poster:'12/poster',fanart:'86/fanart',ids:{simkl_id:1197910,imdb:'tt11198330'},release_date:'08/22/2022',overview:'Dragons',runtime:'1h 7m',genres:['Drama'],trailer:'Wg86eQkdudI',ratings:{imdb:{rating:8.3}}},'series');assert.equal(item.id,'tt11198330');assert.equal(item.simklId,1197910);assert.match(item.poster,/simkl\.in\/posters/);assert.equal(item.trailers[0].source,'Wg86eQkdudI')});
test('release names become readable titles with episode data',()=>assert.deepEqual(parseReleaseName('House.of.the.Dragon.S02E03.2160p.WEB-DL.DDP5.1.mkv'),{title:'House of the Dragon',year:'',season:2,episode:3}));
test('TorBox entries inherit matching catalog artwork and keep raw playback data',()=>{const raw={id:7,name:'Dune.Part.Two.2024.1080p.BluRay.mkv',download_state:'completed'};const item=enrichTorBoxItem(raw,[{id:'tt1',title:'Dune: Part Two',type:'movie',year:'2024',poster:'poster.jpg',background:'fanart.jpg'}]);assert.equal(item.title,'Dune: Part Two');assert.equal(item.poster,'poster.jpg');assert.equal(item.raw,raw);assert.equal(item.type,'library')});
test('playable stream selection rejects non-URL streams and prefers cached 1080p exact',()=>{const best=selectPlayableStream([{name:'P2P',infoHash:'abc'},{name:'[TB+] 1080p',url:'https://play',title:'cached exact'}]);assert.equal(best.url,'https://play')});
test('stored TorBox file selection chooses the largest video file',()=>{const file=selectVideoFile([{id:1,name:'sample.mkv',size:100},{id:2,name:'movie.mkv',size:10000},{id:3,name:'readme.txt',size:20000}]);assert.equal(file.id,2)});
test('episode file selection chooses the requested episode instead of the largest pack file',()=>{const file=selectVideoFile([{id:1,name:'Show.S01E01.mkv',size:1000},{id:2,name:'Show.S01E02.mkv',size:2000}],1,1);assert.equal(file.id,1)});
test('file selection returns nothing when a TorBox item has no recognizable video file, so callers can error instead of guessing file 0',()=>{assert.ok(!selectVideoFile([{id:1,name:'readme.txt',size:100},{id:2,name:'cover.jpg',size:200}]));assert.ok(!selectVideoFile([]))});
test('anime relationship filtering keeps franchise links (sequel, side story) and drops manga adaptations and unrelated roles',()=>{
 const payload={data:[
  {id:'1',type:'mediaRelationships',attributes:{role:'sequel'},relationships:{destination:{data:{type:'anime',id:'885'}}}},
  {id:'2',type:'mediaRelationships',attributes:{role:'adaptation'},relationships:{destination:{data:{type:'manga',id:'128'}}}},
  {id:'3',type:'mediaRelationships',attributes:{role:'side_story'},relationships:{destination:{data:{type:'anime',id:'721'}}}},
  {id:'4',type:'mediaRelationships',attributes:{role:'character'},relationships:{destination:{data:{type:'anime',id:'999'}}}},
  {id:'5',type:'mediaRelationships',attributes:{role:'sequel'},relationships:{destination:{data:{type:'anime',id:'404'}}}}
 ],included:[
  {id:'885',type:'anime',attributes:{canonicalTitle:'Prince of Tennis: The National Tournament',startDate:'2005-09-17'}},
  {id:'128',type:'manga',attributes:{canonicalTitle:'Tennis no Ouji-sama'}},
  {id:'721',type:'anime',attributes:{canonicalTitle:"Prince of Tennis: Atobe's Gift",startDate:'2005-01-29'}},
  {id:'999',type:'anime',attributes:{canonicalTitle:'Some Character Cameo'}}
 ]};
 const related=filterAnimeRelationships(payload);
 assert.deepEqual(related.map(x=>x.id),['kitsu:885','kitsu:721']);
 assert.equal(related[0].title,'Prince of Tennis: The National Tournament');
 assert.equal(related[0].type,'anime');
});
test('anime relationship filtering tolerates a missing or empty payload',()=>{assert.deepEqual(filterAnimeRelationships(),[]);assert.deepEqual(filterAnimeRelationships({data:[],included:[]}),[])});
test('TMDB collection parts map to a playable card shape keyed by the resolved IMDb id',()=>{
 const part={id:603,title:'The Matrix',release_date:'1999-03-30',poster_path:'/matrix.jpg',overview:'A hacker discovers reality is a simulation.',vote_average:8.2};
 const item=normalizeTmdbCollectionPart(part,'tt0133093');
 assert.deepEqual(item,{id:'tt0133093',type:'movie',title:'The Matrix',poster:'https://image.tmdb.org/t/p/w500/matrix.jpg',background:'',logo:'',year:'1999',description:'A hacker discovers reality is a simulation.',rating:'8.2',runtime:'',genres:[],videos:[],trailers:[]});
});
test('Simkl search results become clickable cards with a temporary simkl: id, since search has no IMDb id yet',()=>{
 const item=normalizeSimklSearchResult({title:'John Wick',year:2014,poster:'30/3002370dbc564e5d8',ratings:{imdb:{rating:7.5}},ids:{simkl_id:342994,slug:'john-wick',tmdb:'245891'}},'movie');
 assert.equal(item.id,'simkl:342994');
 assert.equal(item.title,'John Wick');
 assert.equal(item.poster,'https://simkl.in/posters/30/3002370dbc564e5d8_m.jpg');
 assert.equal(item.rating,'7.5');
});
test('continue watching lists shows with some progress but not fully caught up, sorted by most recent watch activity, and skips never-started or finished shows',()=>{
 const showA={id:'tt1',type:'series',title:'Partially Watched',videos:[{season:1,episode:1},{season:1,episode:2},{season:1,episode:3}]};
 const showB={id:'tt2',type:'series',title:'Never Started',videos:[{season:1,episode:1},{season:1,episode:2}]};
 const showC={id:'tt3',type:'series',title:'Fully Caught Up',videos:[{season:1,episode:1}]};
 const history=[
  {id:'tt1',season:1,episode:1,watchedAt:'2026-01-01T00:00:00Z'},
  {id:'tt3',season:1,episode:1,watchedAt:'2026-01-05T00:00:00Z'},
  {id:'tt1',season:1,episode:2,watchedAt:'2026-01-10T00:00:00Z'}
 ];
 const list=continueWatchingList([showA,showB,showC],history);
 assert.deepEqual(list.map(x=>x.id),['tt1']);
 assert.equal(list[0].continueSeason,1);
 assert.equal(list[0].continueEpisode,3);
 assert.equal(list[0].watchedCount,2);
 assert.equal(list[0].totalCount,3);
 assert.equal(list[0].lastWatchedAt,'2026-01-10T00:00:00Z');
});
test('continue watching sorts multiple in-progress shows by most recently watched first',()=>{
 const older={id:'tt1',type:'series',title:'Older',videos:[{season:1,episode:1},{season:1,episode:2}]};
 const newer={id:'tt2',type:'series',title:'Newer',videos:[{season:1,episode:1},{season:1,episode:2}]};
 const history=[
  {id:'tt1',season:1,episode:1,watchedAt:'2026-01-01T00:00:00Z'},
  {id:'tt2',season:1,episode:1,watchedAt:'2026-02-01T00:00:00Z'}
 ];
 const list=continueWatchingList([older,newer],history);
 assert.deepEqual(list.map(x=>x.id),['tt2','tt1']);
});
test('continue watching tolerates shows with no episode list',()=>{assert.deepEqual(continueWatchingList([{id:'tt1',type:'series',videos:[]}],[]),[]);assert.deepEqual(continueWatchingList([],[]),[])});
