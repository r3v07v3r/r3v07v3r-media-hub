const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8'),preferences=fs.readFileSync(path.join(root,'src/preferences.cjs'),'utf8');
test('OpenSubtitles credentials are stored encrypted, only after a real login call succeeds, mirroring how TMDB verifies before storing',()=>{
 assert.match(main,/async function osLoginWith\(apiKey,username,password\)\{const result=await getJson\(`\$\{OS_API\}\/login`/);
 assert.match(main,/const token=await osLoginWith\(key,user,pass\);const s=readSettings\(\);s\.osApiKey=encrypt\(key\);s\.osUsername=encrypt\(user\);s\.osPassword=encrypt\(pass\);s\.osToken=encrypt\(token\)/);
});
test('OpenSubtitles requests transparently re-login and retry once on a 401, since the API has no refresh-token flow',()=>{
 assert.match(main,/if\(error\.status!==401\)throw error;token=await osLoginWith\(creds\.apiKey,creds\.username,creds\.password\)/);
 assert.match(main,/error\.status=response\.status;throw error/);
});
test('checking OpenSubtitles connection status is a local credential check, never a live network call, since /login is rate-limited',()=>{
 assert.match(main,/function osConnected\(\)\{const c=osCredentials\(\);return Boolean\(c\.apiKey&&c\.username&&c\.password\)\}/);
 assert.doesNotMatch(main,/handle\('os:status'/);
 assert.match(main,/osConnected:osConnected\(\)/);
});
test('disconnecting OpenSubtitles clears every stored credential field including the login token',()=>{
 assert.match(main,/handle\('os:disconnect',\(\)=>\{const s=readSettings\(\);delete s\.osApiKey;delete s\.osUsername;delete s\.osPassword;delete s\.osToken;writeSettings\(s\)/);
});
test('preload exposes the OpenSubtitles connect/disconnect and subtitle-language channels',()=>{
 assert.match(preload,/osConnect:creds=>ipcRenderer\.invoke\('os:connect',creds\)/);
 assert.match(preload,/osDisconnect:\(\)=>ipcRenderer\.invoke\('os:disconnect'\)/);
 assert.match(preload,/setSubtitleLanguage:value=>ipcRenderer\.invoke\('settings:set-subtitle-language',value\)/);
});
test('the subtitle language setting is sanitized to a short language-code pattern before being persisted',()=>{
 assert.match(main,/s\.subtitleLanguage=\(String\(value\|\|'en'\)\.trim\(\)\.toLowerCase\(\)\.match\(\/\^\[a-z-\]\{2,10\}\$\/\)\|\|\['en'\]\)\[0\]/);
});
test('public settings expose the subtitle language preference with an English default',()=>{
 assert.match(preferences,/subtitleLanguage:String\(settings\.subtitleLanguage\|\|'en'\)/);
});
test('Settings shows a Subtitles connection card wired to OpenSubtitles connect/disconnect and a language picker',()=>{
 assert.match(renderer,/<b>Subtitles<\/b>/);
 assert.match(renderer,/async function openSubtitlesSettings\(\)/);
 assert.match(renderer,/manageSubtitles'\)\.onclick=openSubtitlesSettings/);
 assert.match(renderer,/id="subtitleLanguageSelect"/);
 assert.match(renderer,/window\.mediaHub\.setSubtitleLanguage\(\$\('#subtitleLanguageSelect'\)\.value\)/);
});
