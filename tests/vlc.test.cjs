const test=require('node:test'),assert=require('node:assert/strict');
const {buildVlcArguments,isValidCompatibilityToken,parseMediaTracks,needsAudioCompatibility,createVlcTranscoder,captureFrame}=require('../src/vlc.cjs');

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
test('media probe exposes labelled video audio and subtitle choices',()=>{const tracks=parseMediaTracks({streams:[{index:0,codec_type:'video',codec_name:'h264',width:1920,height:1080,tags:{language:'eng',title:'Main'}},{index:1,codec_type:'audio',codec_name:'eac3',channels:6,tags:{language:'eng',title:'Surround'}},{index:2,codec_type:'audio',codec_name:'aac',channels:2,tags:{language:'jpn'}},{index:3,codec_type:'subtitle',codec_name:'subrip',tags:{language:'eng',title:'English'}}]});assert.equal(tracks.video[0].label,'Main • 1920×1080 • H264');assert.equal(tracks.audio[0].label,'Surround • ENG • 6ch • EAC3');assert.equal(tracks.audio[1].ordinal,1);assert.equal(tracks.subtitle[0].label,'English • ENG • SUBRIP')});
test('unsupported direct audio selects VLC compatibility while AAC remains direct',()=>{assert.equal(needsAudioCompatibility({audio:[{codec:'eac3'}]}),true);assert.equal(needsAudioCompatibility({audio:[{codec:'dts'}]}),true);assert.equal(needsAudioCompatibility({audio:[{codec:'aac'}]}),false);assert.equal(needsAudioCompatibility({audio:[]}),false)});
test('VLC compatibility selects audio and subtitles and resumes at the requested time',()=>{const args=buildVlcArguments('https://download.example/video.mkv',18765,'a'.repeat(64),{audio:1,subtitle:0,startTime:125});assert.ok(args.includes('--audio-track=1'));assert.ok(args.includes('--sub-track=0'));assert.ok(args.includes('--start-time=125'));assert.ok(args.some(x=>x.includes('soverlay')))});
test('an external subtitle file takes priority over an embedded subtitle track index, so a fetched OpenSubtitles file gets burned in instead of a stale embedded track',()=>{const args=buildVlcArguments('https://download.example/video.mkv',18765,'a'.repeat(64),{subtitle:2,externalSubtitlePath:'C:/fake/subtitles-cache/abc123.srt'});assert.ok(args.includes('--sub-file=C:/fake/subtitles-cache/abc123.srt'));assert.equal(args.some(x=>x.startsWith('--sub-track=')),false)});
test('a VLC spawn failure rejects immediately instead of waiting for the port-wait timeout',async()=>{
 function fakeSpawn(){const listeners={};const child={once(event,cb){(listeners[event]=listeners[event]||[]).push(cb);return child},unref(){},kill(){},killed:false};setImmediate(()=>(listeners.error||[]).forEach(cb=>cb(new Error('spawn ENOENT'))));return child}
 const transcoder=createVlcTranscoder({spawnImpl:fakeSpawn,randomBytes:size=>Buffer.alloc(size,1)});
 const started=Date.now();
 await assert.rejects(()=>transcoder.start('C:/fake/vlc.exe','https://download.example/video.mkv',{}),/VLC failed to start: spawn ENOENT/);
 assert.ok(Date.now()-started<2000,'spawn errors should fail fast instead of waiting out the 8s port timeout');
});
test('VLC stderr output is captured and forwarded instead of being discarded, so playback failures are diagnosable',async()=>{
 function fakeSpawn(){
  const listeners={};
  const child={stderr:{on(event,cb){(listeners['stderr:'+event]=listeners['stderr:'+event]||[]).push(cb);return child.stderr}},once(event,cb){(listeners[event]=listeners[event]||[]).push(cb);return child},unref(){},kill(){},killed:false};
  setImmediate(()=>{(listeners['stderr:data']||[]).forEach(cb=>cb(Buffer.from('main error: could not open output\n')));(listeners.error||[]).forEach(cb=>cb(new Error('spawn ENOENT')))});
  return child;
 }
 const logs=[];
 const transcoder=createVlcTranscoder({spawnImpl:fakeSpawn,randomBytes:size=>Buffer.alloc(size,1),onLog:line=>logs.push(line)});
 await assert.rejects(()=>transcoder.start('C:/fake/vlc.exe','https://download.example/video.mkv',{}));
 assert.ok(logs.some(line=>line.includes('could not open output')),'stderr output should be forwarded to onLog for diagnosis');
});
test('captureFrame returns a base64 data URL from ffmpeg stdout on success',async()=>{
 let calledArgs=null;
 const fakeExecFile=(ffmpegPath,args,opts,cb)=>{calledArgs=args;cb(null,Buffer.from('fakejpegbytes'))};
 const url=await captureFrame('C:/fake/ffmpeg.exe','https://download.example/video.mkv',42,{execFileImpl:fakeExecFile});
 assert.equal(url,`data:image/jpeg;base64,${Buffer.from('fakejpegbytes').toString('base64')}`);
 assert.ok(calledArgs.includes('-ss'));assert.ok(calledArgs.includes('42'));assert.ok(calledArgs.includes('https://download.example/video.mkv'));
});
test('captureFrame resolves null on ffmpeg error, empty output, or unsafe input',async()=>{
 const failingExecFile=(ffmpegPath,args,opts,cb)=>cb(new Error('ffmpeg failed'));
 assert.equal(await captureFrame('C:/fake/ffmpeg.exe','https://download.example/video.mkv',10,{execFileImpl:failingExecFile}),null);
 const emptyExecFile=(ffmpegPath,args,opts,cb)=>cb(null,Buffer.alloc(0));
 assert.equal(await captureFrame('C:/fake/ffmpeg.exe','https://download.example/video.mkv',10,{execFileImpl:emptyExecFile}),null);
 assert.equal(await captureFrame('','https://download.example/video.mkv',10,{execFileImpl:failingExecFile}),null);
 assert.equal(await captureFrame('C:/fake/ffmpeg.exe','http://unsafe.example/video.mkv',10,{execFileImpl:failingExecFile}),null);
 assert.equal(await captureFrame('C:/fake/ffmpeg.exe','https://download.example/video.mkv',-5,{execFileImpl:failingExecFile}),null);
});
