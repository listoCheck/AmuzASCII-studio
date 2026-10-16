import { charsets, palettes } from './ascii.js'

export const defaultSettings={columns:160,charset:'classic',custom:' .:-=+*#%@',brightness:0,inkBrightness:120,contrast:20,saturation:100,gamma:1,rotation:0,mirror:false,invert:false}
export const defaultAppearance={colorMode:'palette',foreground:'#d1e8a0',background:'#10140f',paletteIndex:0}

export function normalizeColumns(value,fallback=160){
  if(String(value).trim()===''||!Number.isFinite(Number(value)))return fallback
  return Math.max(40,Math.min(1000,Math.round(Number(value))))
}

export function validatePreset(input){
  if(!input||input.app!=='AmuzASCII'||input.version!==1||!input.settings||typeof input.settings!=='object')throw new Error('Это не набор AmuzASCII версии 1.')
  const s=input.settings,settings={...defaultSettings},appearance={...defaultAppearance}
  if(s.inkBrightness!==undefined){
    if(typeof s.inkBrightness!=='number'||!Number.isFinite(s.inkBrightness)||s.inkBrightness<0||s.inkBrightness>300)throw new Error('Недопустимый параметр: inkBrightness.')
    settings.inkBrightness=s.inkBrightness
  }
  for(const [key,min,max] of [['columns',40,1000],['brightness',-100,100],['contrast',-100,100],['saturation',0,200],['gamma',.3,2.5]]){
    if(typeof s[key]!=='number'||!Number.isFinite(s[key])||s[key]<min||s[key]>max)throw new Error(`Недопустимый параметр: ${key}.`)
    settings[key]=key==='columns'?Math.round(s[key]):s[key]
  }
  if(![...charsets.map(c=>c.id),'custom'].includes(s.charset))throw new Error('Неизвестный набор символов.')
  if(typeof s.custom!=='string'||!Array.from(s.custom).length||Array.from(s.custom).length>256||/[\x00-\x1f\x7f]/.test(s.custom))throw new Error('Проверьте собственный набор символов.')
  if(![0,90,180,270].includes(s.rotation)||typeof s.mirror!=='boolean'||typeof s.invert!=='boolean')throw new Error('Некорректные параметры поворота или инверсии.')
  Object.assign(settings,{charset:s.charset,custom:s.custom,rotation:s.rotation,mirror:s.mirror,invert:s.invert})
  const a=input.appearance
  if(!a||!['palette','mono','original'].includes(a.colorMode)||!Number.isInteger(a.paletteIndex)||a.paletteIndex<0||a.paletteIndex>=palettes.length)throw new Error('Некорректная цветовая палитра.')
  for(const key of ['foreground','background'])if(typeof a[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(a[key]))throw new Error('Некорректный цвет.')
  Object.assign(appearance,{colorMode:a.colorMode,paletteIndex:a.paletteIndex,foreground:a.foreground,background:a.background})
  return {app:'AmuzASCII',version:1,name:typeof input.name==='string'?input.name.trim().slice(0,60)||'Без названия':'Без названия',settings,appearance}
}

function builtIn(name,settings,appearance={}){
  return validatePreset({app:'AmuzASCII',version:1,name,settings:{...defaultSettings,...settings},appearance:{...defaultAppearance,...appearance}})
}
export const builtinPresets=[
  builtIn('Сбалансированный',{}),
  builtIn('Матрица',{charset:'matrix',contrast:35,gamma:1.2},{paletteIndex:1,background:'#06110b',foreground:'#b6ffb0'}),
  builtIn('Кино / чёрно-белый',{contrast:40,saturation:0,gamma:1.1},{paletteIndex:12,background:'#101010',foreground:'#ffffff'}),
  builtIn('Мягкая бумага',{brightness:8,contrast:5,gamma:1.2},{paletteIndex:4,background:'#eee9dc',foreground:'#222e24'}),
  builtIn('Неоновый закат',{charset:'blocks',contrast:30,saturation:135},{paletteIndex:7,background:'#201025',foreground:'#ffe4a3'}),
  builtIn('Видео / быстрый',{columns:100,contrast:25,gamma:1.2},{colorMode:'original'}),
]
