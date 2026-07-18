const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
test('subtitle search uses the current preferred language setting and normalizes results, capped and filtered to results that actually have a downloadable file',()=>{
 assert.match(main,/const language=readSettings\(\)\.subtitleLanguage\|\|'en',params=buildSearchParams\(item\|\|\{\},\{\.\.\.playback,language\}\)/);
 assert.match(main,/\(result\.data\|\|\[\]\)\.map\(normalizeSubtitleResult\)\.filter\(x=>x\.fileId\)\.slice\(0,20\)/);
});
test('applying a subtitle for direct playback returns a WebVTT data URL instead of writing a temp file, since VLC is not involved',()=>{
 assert.match(main,/if\(!compatibility\)return\{ok:true,compatibility:false,vttDataUrl:`data:text\/vtt;base64,\$\{Buffer\.from\(srtToVtt\(srtText\)\)\.toString\('base64'\)\}`\}/);
});
test('applying a subtitle for compatibility mode writes the raw SRT to a dedicated cache directory, restarts VLC with --sub-file, and cleans up the previous file first',()=>{
 assert.match(main,/function subtitleCacheDir\(\)\{return path\.join\(app\.getPath\('userData'\),'subtitles-cache'\)\}/);
 assert.match(main,/function clearActiveSubtitle\(\)\{if\(activeSubtitlePath\)\{try\{fs\.unlinkSync\(activeSubtitlePath\)\}catch\{\}activeSubtitlePath=''\}\}/);
 assert.match(main,/clearActiveSubtitle\(\);const dir=subtitleCacheDir\(\);fs\.mkdirSync\(dir,\{recursive:true\}\)/);
 assert.match(main,/externalSubtitlePath:filePath/);
 assert.match(main,/activeSubtitlePath=filePath/);
});
test('the temp subtitle file is cleaned up when playback stops, not left behind after the session ends',()=>{
 assert.match(main,/async function stopPlayback\(\)\{activeMediaUrl='';activeMediaTracks=\{video:\[\],audio:\[\],subtitle:\[\],probed:false\};clearActiveSubtitle\(\);/);
});
test('downloading a subtitle validates the OpenSubtitles response before treating it as a real file',()=>{
 assert.match(main,/if\(!result\.link\)throw new Error\('OpenSubtitles did not return a download link\.'\)/);
 assert.match(main,/if\(!response\.ok\)throw new Error\('Could not download the subtitle file\.'\)/);
});
test('preload exposes the subtitle search and apply channels',()=>{
 assert.match(preload,/subtitlesSearch:payload=>ipcRenderer\.invoke\('subtitles:search',payload\)/);
 assert.match(preload,/subtitlesApply:payload=>ipcRenderer\.invoke\('subtitles:apply',payload\)/);
});
test('the player carries enough context (type, id, title, season, episode) from both the catalog and TorBox library playback paths to search subtitles',()=>{
 assert.match(renderer,/openPlayer\(prepared,meta\.title,playback\.season\?`Season \$\{playback\.season\} • Episode \$\{playback\.episode\}`:'',scrobble\.connected,\{type:meta\.type,id:meta\.id,title:meta\.title,season:playback\.season,episode:playback\.episode\}\)/);
 assert.match(renderer,/openPlayer\(prepared,item\.title,item\.season\?`Season \$\{item\.season\} • Episode \$\{item\.episode\}`:'',false,\{type:item\.type\|\|'movie',id:item\.id,title:item\.title,season:item\.season,episode:item\.episode\}\)/);
 assert.match(renderer,/function openPlayer\(prepared,title,subtitle,simklTracking,subtitleContext=\{\}\)/);
});
test('the player offers a Search subtitles action that lists OpenSubtitles results and applies the chosen one through the correct path for the current playback engine',()=>{
 assert.match(renderer,/id="fixPlayerSubtitles" class="compatibility-card"/);
 assert.match(renderer,/id="subtitleResults" class="subtitle-results hidden"/);
 assert.match(renderer,/window\.mediaHub\.subtitlesSearch\(\{item:subtitleContext,playback:subtitleContext\}\)/);
 assert.match(renderer,/window\.mediaHub\.subtitlesApply\(\{fileId:picked\.fileId,compatibility:compatibilityStarted,selection:selection\(\)\}\)/);
 assert.match(renderer,/if\(applied\.compatibility\)await replaceStream\(applied\);else attachDirectSubtitle\(applied\.vttDataUrl\)/);
});
test('direct-playback subtitles attach via a real HTML5 track element and force it to show, instead of relying on default track selection which browsers do not always honor',()=>{
 assert.match(renderer,/const attachDirectSubtitle=vttDataUrl=>\{\$\$\('#mediaPlayer track'\)\.forEach\(t=>t\.remove\(\)\)/);
 assert.match(renderer,/trackEl\.kind='subtitles'/);
 assert.match(renderer,/trackEl\.track\.mode='showing'/);
});
