const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..'),css=fs.readFileSync(path.join(root,'src/styles.css'),'utf8'),renderer=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');
function lastRule(selector){const matches=[...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]+)\\}','g'))];return matches.at(-1)?.[1]||''}
test('hero keeps a stable height and reserves room for actions',()=>{assert.match(lastRule('.hero'),/height:390px/);assert.doesNotMatch(css,/height:56vh;min-height:480px;max-height:700px/);assert.match(lastRule('.hero .actions'),/margin-top:18px/)});
test('hero copy is wider and long descriptions are clamped',()=>{assert.match(lastRule('.hero-copy'),/width:min\(560px,55%\)/);const title=lastRule('.hero h1');assert.match(title,/-webkit-line-clamp:2/);assert.match(title,/overflow:hidden/);const description=lastRule('.hero p');assert.match(description,/width:100%/);assert.match(description,/-webkit-line-clamp:4/);assert.match(description,/overflow:hidden/)});
test('the discovery ring replaced the old hero banner: a coverflow stage of posters with a docked info panel whose primary action is a compact play orb',()=>{
 assert.doesNotMatch(renderer,/renderHero|startHeroRotation|hero-live/);
 assert.match(renderer,/function renderDiscovery\(source\)/);
 assert.match(renderer,/rotateY\(\$\{offset\*-16\}deg\)/);
 assert.match(renderer,/class="disc-play" id="discPlay" title="Play \/ Info"/);
 assert.match(renderer,/STATUS: WATCHED/);
});
