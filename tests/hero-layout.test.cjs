const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
function lastRule(selector){const matches=[...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]+)\\}','g'))];return matches.at(-1)?.[1]||''}
test('hero keeps a stable height and reserves room for actions',()=>{assert.match(lastRule('.hero'),/height:390px/);assert.doesNotMatch(css,/height:56vh;min-height:480px;max-height:700px/);assert.match(lastRule('.hero .actions'),/margin-top:18px/)});
test('hero copy is wider and long descriptions are clamped',()=>{assert.match(lastRule('.hero-copy'),/width:min\(560px,55%\)/);const title=lastRule('.hero h1');assert.match(title,/-webkit-line-clamp:2/);assert.match(title,/overflow:hidden/);const description=lastRule('.hero p');assert.match(description,/width:100%/);assert.match(description,/-webkit-line-clamp:4/);assert.match(description,/overflow:hidden/)});
test('the hero banner shows a real, docked Continue Watching rail (title, next episode, real per-series progress) instead of a coverflow or any fabricated match/AI data',()=>{
 assert.doesNotMatch(renderer,/renderDiscovery|disc-item|disc-play|rotateY/);
 assert.match(renderer,/function renderHero\(source\)/);
 assert.match(renderer,/function showHero\(index\)/);
 assert.match(renderer,/class="hero-side"/);
 assert.match(renderer,/CONTINUE WATCHING/);
 assert.match(renderer,/x\.totalCount\?Math\.round\(x\.watchedCount\/x\.totalCount\*100\):0/);
});
test('the hero primary action is a real Watch Now / Track pair, not a fake voice-assistant orb, and rotates through multiple real recommended/continue-watching titles with dot pagination',()=>{
 assert.match(renderer,/id="featuredOpen">▶ Watch Now<\/button>/);
 assert.match(renderer,/id="featuredTrack">\$\{watched\?'✓ Watched':'\+ Track'\}<\/button>/);
 assert.match(renderer,/class="hero-dots"/);
 assert.match(css,/\.hero-dots button\.active/);
});
