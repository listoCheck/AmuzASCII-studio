import {reactive,watch} from 'vue'

export const themes=[
  {id:'paper',name:'Бумага',colors:['#eee9dc','#dce0ce','#333b2c'],accent:'#62734a'},
  {id:'midnight',name:'Полночь',colors:['#121826','#1c2638','#e1e9f5'],accent:'#80a7ff'},
  {id:'ocean',name:'Глубокий океан',colors:['#09252d','#123943','#d1f4f0'],accent:'#51c7b5'},
  {id:'plum',name:'Сливовый бархат',colors:['#251c2f','#35273f','#f2deee'],accent:'#d6a1d0'},
  {id:'graphite',name:'Графит',colors:['#191b1e','#272a2f','#e5e5e6'],accent:'#b5c5a0'},
  {id:'peach',name:'Персиковый свет',colors:['#fff2e7','#f1dfd2','#533e37'],accent:'#b35f48'},
  {id:'blueprint',name:'Чертёж',colors:['#102b50','#183b65','#dceeff'],accent:'#8ddcfc'},
  {id:'acid',name:'Кислотный поп',colors:['#efff81','#d8eb70','#30224d'],accent:'#7547ba'},
  {id:'mars',name:'Марсианская пыль',colors:['#2b1918','#402622','#f3d6b3'],accent:'#efa277'},
  {id:'neon-city',name:'Неоновый город',colors:['#130925','#ff59de','#4deaff'],accent:'#f15bda'},
  {id:'neon-circuit',name:'Неоновый контур',colors:['#061b24','#77ff96','#ff7cdb'],accent:'#45f5c5'},
  {id:'cyberpunk',name:'Cyberpunk',colors:['#11101a','#262034','#fff2b4'],accent:'#f8e51b'},
]
export const preferenceDefaults={locale:'ru',theme:'paper',accent:'#62734a',density:'comfortable',fontScale:100,panelWidth:340,radius:8,grid:false,imageFormat:'png',exportQuality:92,fileName:'AmuzASCII',videoFormat:'mp4'}
const locales=['ru','en'],formats=['png','jpeg','webp','svg','txt','html']
export function sanitizePreferences(input={}){
  if(!input||typeof input!=='object')input={}
  const clean={...preferenceDefaults}
  if(['webm-vp9','webm-vp8'].includes(input.videoFormat))clean.videoFormat='webm'
  for(const [key,allowed] of [['locale',locales],['theme',themes.map(t=>t.id)],['density',['comfortable','compact']],['imageFormat',formats],['videoFormat',['webm','mp4']]])if(allowed.includes(input[key]))clean[key]=input[key]
  for(const [key,min,max] of [['fontScale',90,120],['panelWidth',280,440],['radius',0,18],['exportQuality',10,100]])if(typeof input[key]==='number'&&Number.isFinite(input[key]))clean[key]=Math.max(min,Math.min(max,Math.round(input[key])))
  if(typeof input.accent==='string'&&/^#[0-9a-f]{6}$/i.test(input.accent))clean.accent=input.accent
  if(typeof input.grid==='boolean')clean.grid=input.grid
  if(typeof input.fileName==='string')clean.fileName=input.fileName.slice(0,80)
  return clean
}
let stored={}
try{stored=JSON.parse(localStorage.getItem('AmuzASCII.ui.v1')||'null')||{};if(!stored.locale)stored.locale=navigator.language?.startsWith('ru')?'ru':'en'}catch{}
export const preferences=reactive(sanitizePreferences(stored))
export function resetAppearance(){for(const key of ['theme','accent','density','fontScale','panelWidth','radius','grid'])preferences[key]=preferenceDefaults[key]}
export function chooseTheme(id){const theme=themes.find(t=>t.id===id);if(theme){preferences.theme=theme.id;preferences.accent=theme.accent}}
export function accentText(hex){const rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]>.58?'#152019':'#ffffff'}
watch(preferences,value=>{
  if(typeof document==='undefined')return
  const root=document.documentElement
  root.lang=value.locale;root.dataset.theme=value.theme;root.dataset.density=value.density;root.dataset.grid=String(value.grid)
  document.querySelector('meta[name="description"]')?.setAttribute('content',value.locale==='en'?'AmuzASCII — image and video ASCII art editor':'AmuzASCII — редактор ASCII-арта для изображений и видео')
  for(const [key,val] of Object.entries({'--ui-accent':value.accent,'--ui-accent-text':accentText(value.accent),'--ui-scale':value.fontScale/100,'--panel-width':value.panelWidth+'px','--ui-radius':value.radius+'px'}))root.style.setProperty(key,val)
  try{localStorage.setItem('AmuzASCII.ui.v1',JSON.stringify(value))}catch{}
},{deep:true,immediate:true})
