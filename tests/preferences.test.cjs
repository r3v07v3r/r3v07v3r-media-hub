const test=require('node:test'),assert=require('node:assert/strict');
const {THEMES,normalizeTheme,publicSettings,logoutSettings}=require('../src/preferences.cjs');

test('the app exposes exactly five selectable themes',()=>{
 assert.equal(THEMES.length,5);assert.deepEqual(THEMES.map(x=>x.id),['neon','midnight','ocean','ember','terminal']);
});
test('unknown theme values cannot become DOM theme attributes',()=>{
 assert.equal(normalizeTheme('ocean'),'ocean');assert.equal(normalizeTheme('" onmouseover="alert(1)'),'neon');
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
