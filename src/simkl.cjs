function mediaIds(item){const id=String(item.id||'');if(/^tt\d+$/i.test(id))return{imdb:id};for(const key of ['kitsu','mal','anilist','anidb'])if(id.startsWith(`${key}:`)){const value=Number(id.split(':')[1]);if(Number.isFinite(value))return{[key]:value}}return{}}
function mediaRef(item){return{title:item.title||item.name,year:Number.parseInt(item.year,10)||undefined,ids:mediaIds(item)}}
function episodeBlock(playback){return{number:playback.episode}}
function historyPayload(item,playback={}){const ref=mediaRef(item);if(item.type==='movie')return{movies:[ref]};const entry={...ref,seasons:[{number:playback.season||1,episodes:[episodeBlock(playback)]}]};return item.type==='anime'?{anime:[entry]}:{shows:[entry]}}
function scrobblePayload(item,playback={},progress=0){const ref=mediaRef(item);if(item.type==='movie')return{progress,movie:ref};const key=item.type==='anime'?'anime':'show';return{progress,[key]:ref,episode:{season:playback.season||1,number:playback.episode||1}}}
module.exports={mediaIds,historyPayload,scrobblePayload};
