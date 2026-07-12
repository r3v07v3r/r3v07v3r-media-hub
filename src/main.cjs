const {app,BrowserWindow,ipcMain,safeStorage,shell}=require('electron');
const path=require('node:path');const fs=require('node:fs');const {spawn}=require('node:child_process');
const {validateTorBoxToken,meteorP2PConfigPath,normalizeMeta,rankStreams,selectVideoFile}=require('./core.cjs');
const TORBOX='https://api.torbox.app/v1/api';
const settingsPath=()=>path.join(app.getPath('userData'),'settings.json');
function readSettings(){try{return JSON.parse(fs.readFileSync(settingsPath(),'utf8'))}catch{return{}}}
function writeSettings(v){fs.mkdirSync(path.dirname(settingsPath()),{recursive:true});fs.writeFileSync(settingsPath(),JSON.stringify(v,null,2))}
function encrypt(v){if(!safeStorage.isEncryptionAvailable())throw new Error('Windows secure storage is unavailable.');return safeStorage.encryptString(v).toString('base64')}
function decrypt(v){try{return safeStorage.decryptString(Buffer.from(v,'base64'))}catch{return''}}
function token(){const settings=readSettings();return settings.onboardingVersion===2?decrypt(settings.torboxToken||''):''}
async function launchPlayback(url){
  if(typeof url!=='string'||!/^https?:\/\//.test(url))throw new Error('Invalid playback URL.');
  const candidates=['C:/Program Files/VideoLAN/VLC/vlc.exe','C:/Program Files (x86)/VideoLAN/VLC/vlc.exe'];
  const vlc=candidates.find(fs.existsSync);
  if(vlc){const child=spawn(vlc,[url,'--meta-title=R3V07V3R Media Hub'],{detached:true,stdio:'ignore'});child.unref();return{ok:true,player:'VLC'}}
  await shell.openExternal(url);return{ok:true,player:'system'}
}
async function getJson(url,options={}){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),30000);try{const response=await fetch(url,{...options,signal:controller.signal});const body=await response.json().catch(()=>({}));if(!response.ok||body.success===false)throw new Error(body.detail||`Request failed (${response.status})`);return body}finally{clearTimeout(timer)}}
async function torbox(pathname,query={}){const auth=token();if(!auth)throw new Error('TorBox is not connected.');const url=new URL(TORBOX+pathname);Object.entries(query).forEach(([k,v])=>v!==undefined&&url.searchParams.set(k,String(v)));return getJson(url,{headers:{Authorization:`Bearer ${auth}`}})}
function createWindow(){new BrowserWindow({width:1440,height:900,minWidth:980,minHeight:680,backgroundColor:'#070a12',titleBarStyle:'hidden',titleBarOverlay:{color:'#070a12',symbolColor:'#cdd5e5',height:42},webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}}).loadFile(path.join(__dirname,'index.html'))}
ipcMain.handle('app:bootstrap',async()=>{const configured=Boolean(token());if(!configured)return{configured:false};try{const [user,library]=await Promise.all([torbox('/user/me'),torbox('/torrents/mylist',{limit:100})]);return{configured:true,user:user.data||{},library:library.data||[]}}catch(error){return{configured:false,error:error.message}}});
ipcMain.handle('torbox:connect',async(_e,raw)=>{const value=String(raw||'').trim();if(!validateTorBoxToken(value))return{ok:false,message:'Enter the API token shown in TorBox Settings.'};try{const result=await getJson(`${TORBOX}/user/me`,{headers:{Authorization:`Bearer ${value}`}});const s=readSettings();s.torboxToken=encrypt(value);s.onboardingVersion=2;writeSettings(s);return{ok:true,user:result.data||{},message:'TorBox connected.'}}catch(error){return{ok:false,message:error.message}}});
ipcMain.handle('torbox:disconnect',()=>{const s=readSettings();delete s.torboxToken;writeSettings(s);return{ok:true}});
ipcMain.handle('catalog:list',async(_e,kind)=>{const urls={movie:'https://v3-cinemeta.strem.io/catalog/movie/top.json',series:'https://v3-cinemeta.strem.io/catalog/series/top.json',anime:'https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-trending.json'};if(!urls[kind])throw new Error('Unknown catalog.');const result=await getJson(urls[kind]);return(result.metas||[]).map(x=>normalizeMeta(x,kind));});
ipcMain.handle('catalog:meta',async(_e,{type,id})=>{const url=type==='anime'?`https://anime-kitsu.strem.fun/meta/anime/${encodeURIComponent(id)}.json`:`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;const result=await getJson(url);return normalizeMeta(result.meta||{},type)});
ipcMain.handle('stream:resolve',async(_e,{type,id})=>{
  const auth=token();if(!auth)throw new Error('TorBox is not connected.');
  const config=meteorP2PConfigPath();
  const meteor=await getJson(`https://meteorfortheweebs.midnightignite.me/${config}/stream/${type}/${encodeURIComponent(id)}.json`);
  const discovered=(meteor.streams||[]).filter(s=>/^[a-f0-9]{40}$/i.test(s.infoHash||''));
  if(!discovered.length)return{streams:[],best:null};
  const hashes=[...new Set(discovered.map(s=>s.infoHash.toLowerCase()))].slice(0,100);
  const cached=await getJson(`${TORBOX}/torrents/checkcached?format=object&list_files=true`,{method:'POST',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},body:JSON.stringify({hashes})});
  const available=new Set(Array.isArray(cached.data)?cached.data.map(x=>String(x.hash||x).toLowerCase()):Object.keys(cached.data||{}).map(x=>x.toLowerCase()));
  const streams=rankStreams(discovered.filter(s=>available.has(s.infoHash.toLowerCase())).map(s=>({...s,cached:true,compatible:true})));
  return{streams,best:streams[0]||null};
});
ipcMain.handle('play:stream',async(_e,{stream,mediaId})=>{
  const auth=token();const hash=String(stream?.infoHash||'').toLowerCase();if(!/^[a-f0-9]{40}$/.test(hash))throw new Error('The selected source has no valid torrent hash.');
  const existing=await torbox('/torrents/mylist',{limit:1000});let item=(existing.data||[]).find(x=>String(x.hash||'').toLowerCase()===hash);
  if(!item){const magnet=new URL('magnet:');magnet.searchParams.set('xt',`urn:btih:${hash}`);for(const source of stream.sources||[])if(source.startsWith('tracker:'))magnet.searchParams.append('tr',source.slice(8));const form=new FormData();form.append('magnet',magnet.toString());form.append('add_only_if_cached','true');const created=await getJson(`${TORBOX}/torrents/createtorrent`,{method:'POST',headers:{Authorization:`Bearer ${auth}`},body:form});const torrentId=created.data?.torrent_id;const fetched=await torbox('/torrents/mylist',{id:torrentId,bypass_cache:true});item=Array.isArray(fetched.data)?fetched.data[0]:fetched.data}
  if(!item)throw new Error('TorBox could not prepare the cached torrent.');
  const parts=String(mediaId||'').split(':');const episode=Number(parts.at(-1)),season=Number(parts.at(-2));const episodic=parts.length>=3&&Number.isFinite(season)&&Number.isFinite(episode);const file=selectVideoFile(item.files||[],episodic?season:undefined,episodic?episode:undefined);if(!file)throw new Error('No matching video file was found in the TorBox torrent.');
  const result=await getJson(`${TORBOX}/torrents/requestdl?token=${encodeURIComponent(auth)}&torrent_id=${encodeURIComponent(item.id)}&file_id=${encodeURIComponent(file.id)}&redirect=false`);const url=typeof result.data==='string'?result.data:result.data?.url||result.data?.download_url;if(!url)throw new Error('TorBox did not return a playable URL.');return launchPlayback(url)
});
ipcMain.handle('play:url',async(_e,url)=>launchPlayback(url));
ipcMain.handle('open:external',async(_e,url)=>{if(!/^https:\/\//.test(String(url)))throw new Error('Invalid external URL.');await shell.openExternal(url);return{ok:true}});
ipcMain.handle('library:list',async()=>{const result=await torbox('/torrents/mylist',{limit:100,bypass_cache:false});return Array.isArray(result.data)?result.data:[]});
ipcMain.handle('library:play',async(_e,item)=>{const auth=token();const files=item.files||item.file_list||[];const file=selectVideoFile(files);const torrentId=item.id||item.torrent_id;if(!torrentId)throw new Error('TorBox item has no torrent ID.');const result=await getJson(`${TORBOX}/torrents/requestdl?token=${encodeURIComponent(auth)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(file?.id||file?.file_id||0)}&redirect=false`);const url=typeof result.data==='string'?result.data:result.data?.url||result.data?.download_url;if(!url)throw new Error('TorBox did not return a playable URL.');return launchPlayback(url)});
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
