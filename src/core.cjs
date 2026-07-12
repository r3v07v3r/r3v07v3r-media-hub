const ROOM_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function filterCatalog(items,section='home',query=''){const q=query.trim().toLowerCase();return items.filter(item=>(section==='home'||item.type===section)&&(!q||`${item.title} ${item.year}`.toLowerCase().includes(q)))}
function createRoomCode(random=Math.random){let value='';for(let i=0;i<6;i++)value+=ROOM_ALPHABET[Math.floor(random()*ROOM_ALPHABET.length)%ROOM_ALPHABET.length];return`${value.slice(0,3)}-${value.slice(3)}`}
function streamResolution(stream){const text=`${stream.name||''} ${stream.title||''}`.toLowerCase();if(/2160|4k/.test(text))return 2160;if(/1080/.test(text))return 1080;if(/720/.test(text))return 720;return stream.resolution||0}
function rankStreams(streams){const score=s=>(s.exact===false?0:100000)+(s.cached===false?0:20000)+(s.compatible===false?-50000:10000)+streamResolution(s);return[...streams].sort((a,b)=>score(b)-score(a))}
function validateTorBoxToken(token){return typeof token==='string'&&token.trim().length>=24&&!/\s/.test(token.trim())}
function meteorConfigPath(token){return Buffer.from(JSON.stringify({debridService:'torbox',debridApiKey:token,maxResults:'20',cachedOnly:true,allowP2P:false}),'utf8').toString('base64url')}
function normalizeMeta(meta,fallbackType){return{id:meta.id||meta.imdb_id,title:meta.name||meta.title||'Untitled',type:fallbackType||meta.type,poster:meta.poster||'',background:meta.background||'',year:String(meta.year||''),description:meta.description||'',rating:String(meta.imdbRating||meta.rating||''),videos:Array.isArray(meta.videos)?meta.videos:[]}}
function selectPlayableStream(streams){const playable=(streams||[]).filter(s=>typeof s.url==='string'&&/^https?:\/\//.test(s.url));return rankStreams(playable)[0]||null}
function selectVideoFile(files){const video=/\.(mkv|mp4|avi|mov|webm|m4v|ts)$/i;return[...(files||[])].filter(f=>video.test(f.name||f.short_name||'')).sort((a,b)=>(b.size||0)-(a.size||0))[0]||null}
module.exports={filterCatalog,createRoomCode,rankStreams,validateTorBoxToken,meteorConfigPath,normalizeMeta,selectPlayableStream,selectVideoFile};
