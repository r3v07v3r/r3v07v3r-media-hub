const test=require('node:test'),assert=require('node:assert/strict');
const {buildVlcArguments,isValidCompatibilityToken}=require('../src/vlc.cjs');

test('VLC compatibility arguments transcode to browser-supported WebM on loopback only',()=>{
 const token='a'.repeat(64),args=buildVlcArguments('https://download.example/video.mkv?token=private',18765,token);
 assert.ok(args.includes('-I'));assert.ok(args.includes('dummy'));assert.ok(args.includes('--no-one-instance'));assert.ok(args.some(x=>x.includes('vcodec=VP80')&&x.includes('acodec=vorb')));assert.ok(args.some(x=>x.includes(`dst=127.0.0.1:18765/${token}.webm`)));assert.equal(args.at(-1),'https://download.example/video.mkv?token=private');
 assert.equal(args.some(x=>/0\.0\.0\.0/.test(x)),false);
});
test('VLC compatibility rejects unsafe sources, ports, and stream tokens',()=>{
 assert.throws(()=>buildVlcArguments('http://unsafe.example/video.mkv',18765,'a'.repeat(64)),/HTTPS/);
 assert.throws(()=>buildVlcArguments('https://safe.example/video.mkv',70000,'a'.repeat(64)),/port/);
 assert.equal(isValidCompatibilityToken('../escape'),false);assert.equal(isValidCompatibilityToken('a'.repeat(64)),true);
});
