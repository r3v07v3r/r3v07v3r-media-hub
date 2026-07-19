const THEMES=[
 {id:'neon',name:'Neon Noir',description:'Signature magenta command center'},
 {id:'midnight',name:'Midnight Gold',description:'Deep black with warm gold highlights'},
 {id:'ocean',name:'Abyssal Ocean',description:'Navy glass with electric cyan'},
 {id:'ember',name:'Ember Protocol',description:'Carbon black with molten orange'},
 {id:'terminal',name:'Ghost Terminal',description:'Tactical graphite and phosphor green'}
];
const ids=new Set(THEMES.map(theme=>theme.id));
function normalizeTheme(value){return ids.has(value)?value:'neon'}
function normalizeUpdateChannel(value){return value==='preview'?'preview':'stable'}
function publicSettings(settings={}){return{theme:normalizeTheme(settings.theme),simklClientId:String(settings.simklClientId||''),subtitleLanguage:String(settings.subtitleLanguage||'en'),partySyncUrl:String(settings.partySyncUrl||''),updateChannel:normalizeUpdateChannel(settings.updateChannel)}}
function logoutSettings(settings={}){return{theme:normalizeTheme(settings.theme),updateChannel:normalizeUpdateChannel(settings.updateChannel)}}
module.exports={THEMES,normalizeTheme,normalizeUpdateChannel,publicSettings,logoutSettings};
