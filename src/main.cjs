const {app,BrowserWindow,ipcMain,safeStorage,shell}=require('electron');
const path=require('node:path');const fs=require('node:fs');const {spawn}=require('node:child_process');
const {validateTorBoxToken,meteorConfigPath,normalizeMeta,selectPlayableStream,selectVideoFile}=require('./core.cjs');
const TORBOX='https://api.torbox.app/v1/api';
const settingsPath=()=>path.join(app.getPath('userData'),'settings.json');
function readSettings(){try{return JSON.parse(fs.readFileSync(settingsPath(),'utf8'))}catch{return{}}}
function writeSettings(v){fs.mkdirSync(path.dirname(settingsPath()),{recursive:true});fs.writeFileSync(settingsPath(),JSON.stringify(v,null,2))}
function encrypt(v){if(!safeStorage.isEncryptionAvailable())throw new Error('Windows secure storage is unavailable.');return safeStorage.encryptString(v).toString('base64')}
function decrypt(v){try{return safeStorage.decryptString(Buffer.from(v,'base64'))}catch{return''}}
function token(){return decrypt(readSettings().torboxToken||'')}
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
ipcMain.handle('torbox:connect',async(_e,raw)=>{const value=String(raw||'').trim();if(!validateTorBoxToken(value))return{ok:false,message:'Enter the API token shown in TorBox Settings.'};try{const result=await getJson(`${TORBOX}/user/me`,{headers:{Authorization:`Bearer ${value}`}});const s=readSettings();s.torboxToken=encrypt(value);writeSettings(s);return{ok:true,user:result.data||{},message:'TorBox connected.'}}catch(error){return{ok:false,message:error.message}}});
ipcMain.handle('torbox:disconnect',()=>{const s=readSettings();delete s.torboxToken;writeSettings(s);return{ok:true}});
ipcMain.handle('catalog:list',async(_e,kind)=>{const urls={movie:'https://v3-cinemeta.strem.io/catalog/movie/top.json',series:'https://v3-cinemeta.strem.io/catalog/series/top.json',anime:'https://anime-kitsu.strem.fun/catalog/anime/kitsu-anime-trending.json'};if(!urls[kind])throw new Error('Unknown catalog.');const result=await getJson(urls[kind]);return(result.metas||[]).map(x=>normalizeMeta(x,kind));});
ipcMain.handle('catalog:meta',async(_e,{type,id})=>{const url=type==='anime'?`https://anime-kitsu.strem.fun/meta/anime/${encodeURIComponent(id)}.json`:`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(id)}.json`;const result=await getJson(url);return normalizeMeta(result.meta||{},type)});
ipcMain.handle('stream:resolve',async(_e,{type,id})=>{const auth=token();if(!auth)throw new Error('TorBox is not connected.');const config=meteorConfigPath(auth);const url=`https://meteorfortheweebs.midnightignite.me/${config}/stream/${type}/${encodeURIComponent(id)}.json`;const result=await getJson(url);const streams=(result.streams||[]).filter(s=>s.url);return{streams,best:selectPlayableStream(streams)}});
ipcMain.handle('play:url',async(_e,url)=>launchPlayback(url));
ipcMain.handle('open:external',async(_e,url)=>{if(!/^https:\/\//.test(String(url)))throw new Error('Invalid external URL.');await shell.openExternal(url);return{ok:true}});
ipcMain.handle('library:list',async()=>{const result=await torbox('/torrents/mylist',{limit:100,bypass_cache:false});return Array.isArray(result.data)?result.data:[]});
ipcMain.handle('library:play',async(_e,item)=>{const auth=token();const files=item.files||item.file_list||[];const file=selectVideoFile(files);const torrentId=item.id||item.torrent_id;if(!torrentId)throw new Error('TorBox item has no torrent ID.');const result=await getJson(`${TORBOX}/torrents/requestdl?token=${encodeURIComponent(auth)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(file?.id||file?.file_id||0)}&redirect=false`);const url=typeof result.data==='string'?result.data:result.data?.url||result.data?.download_url;if(!url)throw new Error('TorBox did not return a playable URL.');return launchPlayback(url)});
app.whenReady().then(()=>{createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow()})});app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});
