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
test('MAL client_secret is optional but included in both the initial and refresh token exchanges when the user provides one, since some MAL app registrations require it even with PKCE',()=>{
 assert.match(main,/clientSecret:decrypt\(s\.malClientSecret\|\|''\)/);
 assert.match(main,/if\(creds\.clientSecret\)params\.client_secret=creds\.clientSecret;const result=await malTokenRequest\(params\)/);
 assert.match(main,/if\(clientSecret\)params\.client_secret=clientSecret;const result=await malTokenRequest\(params\)/);
 assert.match(main,/if\(clientSecret\)s\.malClientSecret=encrypt\(clientSecret\);else delete s\.malClientSecret/);
 assert.match(main,/delete s\.malClientSecret;writeSettings\(s\);stopMalServer\(\)/);
 assert.match(renderer,/id="malClientSecret" type="password"/);
 assert.match(renderer,/window\.mediaHub\.malStart\(\{clientId:\$\('#malClientId'\)\.value,clientSecret:\$\('#malClientSecret'\)\.value\}\)/);
});
test('MAL IPC channels are exposed to the renderer through the preload bridge',()=>{
 assert.match(preload,/malStatus:\(\)=>ipcRenderer\.invoke\('mal:status'\)/);
 assert.match(preload,/malStart:creds=>ipcRenderer\.invoke\('mal:start',creds\)/);
 assert.match(preload,/malDisconnect:\(\)=>ipcRenderer\.invoke\('mal:disconnect'\)/);
});
test('Settings shows a MyAnimeList connection card next to Simkl, with a redirect URI the user pastes into their MAL app registration',()=>{
 assert.match(renderer,/<b>MyAnimeList<\/b>/);
 assert.match(renderer,/async function openMalSettings\(\)/);
 assert.match(renderer,/value="http:\/\/127\.0\.0\.1:48765\/mal\/callback" readonly/);
 assert.match(renderer,/manageMal'\)\.onclick=openMalSettings/);
});
test('reconciliation is preview-then-confirm, never applying a diff the user has not reviewed',()=>{
 assert.match(main,/handle\('mal:reconcile-preview'/);
 assert.match(main,/handle\('mal:reconcile-apply',async\(_e,diff\)=>/);
 assert.match(renderer,/malSyncNow'\)\.onclick=openMalReconcile/);
 assert.match(renderer,/async function openMalReconcile\(\)/);
 assert.match(renderer,/malConfirmSync'\)\.onclick=async\(\)=>\{/);
 assert.match(renderer,/window\.mediaHub\.malReconcileApply\(diff\)/);
});
test('reconciliation resolves Kitsu-MAL id mappings through Kitsu\'s own mapping filter and caches them long-term to avoid repeat lookups',()=>{
 assert.match(main,/filter\[mappingExternalId\]=\$\{encodeURIComponent\(malId\)\}&filter\[mappingExternalSite\]=myanimelist\/anime/);
 assert.match(main,/mediaDb\.putCache\(key,kitsuId,30\*24\*60\*60\*1000\)/);
});
test('pushing MAL-ahead progress into local history also best-effort syncs Simkl in one bulk call, matching the existing mark-season-watched pattern',()=>{
 assert.match(main,/for\(const episode of episodeNumbers\)mediaDb\.markWatched\(media,\{season:1,episode\}\)/);
 assert.match(main,/seasonHistoryPayload\(media,1,episodeNumbers\)/);
});
test('preload exposes the reconciliation preview and apply channels',()=>{
 assert.match(preload,/malReconcilePreview:\(\)=>ipcRenderer\.invoke\('mal:reconcile-preview'\)/);
 assert.match(preload,/malReconcileApply:diff=>ipcRenderer\.invoke\('mal:reconcile-apply',diff\)/);
});
test('marking watched, unmarking, and marking a season watched all best-effort push the resulting progress to MyAnimeList, mirroring the Simkl error-tolerance pattern',()=>{
 for(const channel of["'tracking:mark-watched'","'tracking:unmark-watched'","'tracking:mark-season-watched'"])assert.match(main,new RegExp(`handle\\(${channel},async\\(_e,\\{[^}]*\\}\\)=>\\{[\\s\\S]{0,700}await pushMalProgress\\(item\\)`));
});
test('MAL progress push only applies to anime with a kitsu id and a live MAL connection, and never throws on failure',()=>{
 assert.match(main,/async function pushMalProgress\(item\)\{if\(item\.type!=='anime'\|\|!String\(item\.id\)\.startsWith\('kitsu:'\)\)return\{malSynced:false\}/);
 assert.match(main,/if\(!malCredentials\(\)\.accessToken\)return\{malSynced:false\}/);
 assert.match(main,/catch\(error\)\{logError\('mal:push-progress',error\);return\{malSynced:false,malError:error\.message\}\}/);
});
test('the kitsu-to-MAL id lookup filters Kitsu\'s per-anime mappings for the MyAnimeList entry and caches the result',()=>{
 assert.match(main,/m\.attributes\?\.externalSite==='myanimelist\/anime'/);
 assert.match(main,/mal:mapping:mal-for-kitsu:/);
});
test('status messages mention MyAnimeList sync alongside the existing Simkl status text',()=>{
 assert.match(renderer,/\+\(result\.malSynced\?' Synced to MyAnimeList\.':''\)\}/);
});
