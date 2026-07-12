const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {isAllowedRemoteMediaUrl,createPlaybackProxy}=require('../src/playback.cjs');

function request(url,headers={}){return new Promise((resolve,reject)=>{http.get(url,{headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString()}))}).on('error',reject)})}

test('remote playback only accepts HTTPS URLs without embedded credentials',()=>{
 assert.equal(isAllowedRemoteMediaUrl('https://download.example/video.mkv'),true);
 assert.equal(isAllowedRemoteMediaUrl('http://download.example/video.mkv'),false);
 assert.equal(isAllowedRemoteMediaUrl('file:///etc/passwd'),false);
 assert.equal(isAllowedRemoteMediaUrl('https://user:pass@example/video.mkv'),false);
 assert.equal(isAllowedRemoteMediaUrl('not a URL'),false);
 assert.equal(isAllowedRemoteMediaUrl('https://127.0.0.1/private'),false);
 assert.equal(isAllowedRemoteMediaUrl('https://localhost/private'),false);
 assert.equal(isAllowedRemoteMediaUrl('https://192.168.1.10/private'),false);
});

test('playback proxy keeps the remote URL private and forwards byte ranges',async()=>{
 let received;
 const proxy=createPlaybackProxy({resolveHost:async()=>['93.184.216.34'],fetchImpl:async(url,options)=>{received={url,headers:options.headers};return new Response('video-bytes',{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-10/11','content-length':'11','accept-ranges':'bytes'}})}});
 const local=await proxy.register('https://download.example/private?token=SECRET');
 assert.match(local,/^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{64}$/);
 assert.doesNotMatch(local,/SECRET|download\.example/);
 const response=await request(local,{Range:'bytes=0-10'});
 assert.equal(response.status,206);assert.equal(response.body,'video-bytes');assert.equal(received.url,'https://download.example/private?token=SECRET');assert.equal(received.headers.Range,'bytes=0-10');
 const denied=await request(local.replace(/[a-f0-9]{64}$/,'0'.repeat(64)));
 assert.equal(denied.status,404);
 await proxy.close();
});

test('playback proxy rejects non-HTTPS upstream media',async()=>{
 const proxy=createPlaybackProxy();
 await assert.rejects(()=>proxy.register('http://unsafe.example/video.mkv'),/HTTPS/);
 await proxy.close();
});
