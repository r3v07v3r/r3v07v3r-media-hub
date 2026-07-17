const test=require('node:test'),assert=require('node:assert/strict');
const {isAllowedExternalUrl,isValidCatalogKind,isTrustedIpcSender,sanitizeTrackers}=require('../src/security.cjs');
test('external browser links are restricted to trusted account and project hosts',()=>{
 assert.equal(isAllowedExternalUrl('https://torbox.app/settings'),true);
 assert.equal(isAllowedExternalUrl('https://simkl.com/pin'),true);
 assert.equal(isAllowedExternalUrl('https://github.com/r3v07v3r/r3v07v3r-media-hub/releases'),true);
 assert.equal(isAllowedExternalUrl('https://www.themoviedb.org/settings/api'),true);
 assert.equal(isAllowedExternalUrl('https://torbox.app.evil.example/phish'),false);
 assert.equal(isAllowedExternalUrl('http://torbox.app/settings'),false);
 assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe'),false);
});
test('catalog IPC accepts only the supported catalog identifiers',()=>{for(const kind of['movie','series','anime'])assert.equal(isValidCatalogKind(kind),true);for(const kind of['home','library','../settings',null])assert.equal(isValidCatalogKind(kind),false)});
test('privileged IPC is restricted to the exact app document',()=>{const app='file:///C:/Program%20Files/R3/app.asar/src/index.html';assert.equal(isTrustedIpcSender(app,app),true);assert.equal(isTrustedIpcSender('https://example.com/',app),false);assert.equal(isTrustedIpcSender('file:///C:/tmp/index.html',app),false)});
test('torrent trackers are bounded and reject local or credential-bearing endpoints',()=>{const values=sanitizeTrackers(['tracker:udp://tracker.example:80/announce','tracker:http://127.0.0.1/x','tracker:https://user:pass@example.com/x','tracker:file:///tmp/x',...Array(30).fill('tracker:https://tracker2.example/announce')]);assert.deepEqual(values,['udp://tracker.example:80/announce','https://tracker2.example/announce']);assert.ok(values.length<=20)});
