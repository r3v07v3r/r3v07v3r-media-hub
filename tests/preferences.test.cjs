const test=require('node:test'),assert=require('node:assert/strict');
const {THEMES,normalizeTheme,publicSettings,logoutSettings}=require('../src/preferences.cjs');

test('the app exposes exactly six selectable themes with Aethera as the flagship default',()=>{
 assert.equal(THEMES.length,6);assert.deepEqual(THEMES.map(x=>x.id),['aethera','neon','midnight','ocean','ember','terminal']);
});
test('unknown theme values cannot become DOM theme attributes and fall back to the Aethera default',()=>{
 assert.equal(normalizeTheme('ocean'),'ocean');assert.equal(normalizeTheme('neon'),'neon');assert.equal(normalizeTheme('" onmouseover="alert(1)'),'aethera');
});
test('public settings never expose encrypted tokens',()=>{
 const value=publicSettings({theme:'ember',torboxToken:'cipher',simklAccessToken:'cipher2',simklClientId:'public-id',osApiKey:'cipher3',osPassword:'cipher4',subtitleLanguage:'fr',partySyncInviteKey:'cipher5'});assert.deepEqual(value,{theme:'ember',simklClientId:'public-id',subtitleLanguage:'fr',partySyncUrl:''});
});
test('public settings default subtitle language to English when unset',()=>{
 assert.equal(publicSettings({theme:'neon'}).subtitleLanguage,'en');
});
test('logout clears account credentials while retaining appearance',()=>{
 const value=logoutSettings({theme:'terminal',torboxToken:'a',simklAccessToken:'b',simklClientId:'c',onboardingVersion:2});assert.deepEqual(value,{theme:'terminal'});
});
