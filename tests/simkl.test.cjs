const test=require('node:test');const assert=require('node:assert/strict');const {mediaIds,historyPayload,seasonHistoryPayload,scrobblePayload,watchedFromAllItems}=require('../src/simkl.cjs');
test('Simkl IDs map IMDb movies and Kitsu anime',()=>{assert.deepEqual(mediaIds({id:'tt1375666',type:'movie'}),{imdb:'tt1375666'});assert.deepEqual(mediaIds({id:'kitsu:7442',type:'anime'}),{kitsu:7442})});
test('movie history payload uses movies array',()=>{const p=historyPayload({id:'tt1375666',type:'movie',title:'Inception',year:'2010'},{});assert.equal(p.movies[0].ids.imdb,'tt1375666')});
test('series history payload nests requested season and episode',()=>{const p=historyPayload({id:'tt123',type:'series',title:'Show',year:'2026'},{season:2,episode:4});assert.equal(p.shows[0].seasons[0].number,2);assert.equal(p.shows[0].seasons[0].episodes[0].number,4)});
test('scrobble payload distinguishes anime and includes progress',()=>{const p=scrobblePayload({id:'kitsu:9',type:'anime',title:'Anime',year:'2025'},{season:1,episode:3},0);assert.equal(p.anime.ids.kitsu,9);assert.equal(p.episode.number,3);assert.equal(p.progress,0)});
test('pulled Simkl watched history maps completed movies and per-episode show progress by IMDb ID',()=>{
 const movies={movies:[{status:'completed',last_watched_at:'1994-09-01T16:00:00Z',movie:{title:'The Godfather',ids:{imdb:'tt0068646'}}},{status:'completed',last_watched_at:null,movie:{title:'No IMDb match',ids:{simkl:1}}}]};
 const shows={shows:[{show:{title:'The Walking Dead',ids:{imdb:'tt1520211'}},seasons:[{number:1,episodes:[{number:2,watched_at:'2026-05-15T00:32:20Z'},{number:3,watched_at:null}]}]}]};
 const entries=watchedFromAllItems(movies,shows);
 assert.deepEqual(entries,[{id:'tt0068646',type:'movie',season:null,episode:null,watchedAt:'1994-09-01T16:00:00Z'},{id:'tt1520211',type:'series',season:1,episode:2,watchedAt:'2026-05-15T00:32:20Z'}]);
});
test('watchedFromAllItems tolerates missing payloads',()=>{assert.deepEqual(watchedFromAllItems(),[]);assert.deepEqual(watchedFromAllItems({},{}),[])});
test('season history payload nests every episode of the season in a single request instead of one call per episode',()=>{const p=seasonHistoryPayload({id:'tt123',type:'series',title:'Show',year:'2026'},3,[1,2,3]);assert.equal(p.shows[0].seasons[0].number,3);assert.deepEqual(p.shows[0].seasons[0].episodes,[{number:1},{number:2},{number:3}])});
test('season history payload uses the anime array for anime titles',()=>{const p=seasonHistoryPayload({id:'kitsu:9',type:'anime',title:'Anime',year:'2025'},1,[1,2]);assert.ok(p.anime);assert.equal(p.anime[0].seasons[0].number,1)});
