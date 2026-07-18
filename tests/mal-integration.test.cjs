const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),main=fs.readFileSync(path.join(root,'src/main.cjs'),'utf8'),preload=fs.readFileSync(path.join(root,'src/preload.cjs'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
test('the MyAnimeList redirect server only binds to loopback on a fixed port, matching what the user registers with their MAL app',()=>{
 assert.match(main,/MAL_REDIRECT_PORT=48765/);
 assert.match(main,/server\.listen\(MAL_REDIRECT_PORT,'127\.0\.0\.1'\)/);
 assert.doesNotMatch(main,/server\.listen\(MAL_REDIRECT_PORT,'0\.0\.0\.0'\)/);
});
test('the MAL authorization URL is validated through the same external-URL allowlist used for renderer-initiated links before opening the system browser',()=>{
 assert.match(main,/if\(!isAllowedExternalUrl\(authorizeUrl\)\)throw new Error/);
 assert.match(main,/await shell\.openExternal\(authorizeUrl\)/);
});
test('the callback handler validates the CSRF state before accepting an authorization code',()=>{
 assert.match(main,/if\(!state\|\|state!==expectedState\)return reject\(new Error\('MyAnimeList authorization state mismatch\.'\)\)/);
});
test('MAL tokens are refreshed proactively before expiry and stored encrypted, never in plaintext',()=>{
 assert.match(main,/creds\.expiresAt-Date\.now\(\)>5\*60\*1000/);
 assert.match(main,/s\.malAccessToken=encrypt\(result\.access_token\)/);
 assert.match(main,/settings\.malAccessToken=encrypt\(result\.access_token\)/);
 assert.doesNotMatch(main,/malAccessToken=result\.access_token/);
});
test('MAL IPC channels are exposed to the renderer through the preload bridge',()=>{
 assert.match(preload,/malStatus:\(\)=>ipcRenderer\.invoke\('mal:status'\)/);
 assert.match(preload,/malStart:clientId=>ipcRenderer\.invoke\('mal:start',clientId\)/);
 assert.match(preload,/malDisconnect:\(\)=>ipcRenderer\.invoke\('mal:disconnect'\)/);
});
test('Settings shows a MyAnimeList connection card next to Simkl, with a redirect URI the user pastes into their MAL app registration',()=>{
 assert.match(renderer,/<b>MyAnimeList<\/b>/);
 assert.match(renderer,/async function openMalSettings\(\)/);
 assert.match(renderer,/value="http:\/\/127\.0\.0\.1:48765\/mal\/callback" readonly/);
 assert.match(renderer,/manageMal'\)\.onclick=openMalSettings/);
});
