import {preferences} from './preferences.js'
import en from './locales/en.json' with {type:'json'}

export const messages={en}
export function translate(locale,source,params={}){
  let text=messages[locale]?.[source]||source
  for(const [key,value] of Object.entries(params))text=text.replaceAll('{'+key+'}',String(value))
  return text
}
export function t(source,params={}){
  if(source&&typeof source==='object'&&typeof source.key==='string'){
    const values={...source.params}
    if(source.localizeName&&typeof values.name==='string')values.name=translate(preferences.locale,values.name)
    return translate(preferences.locale,source.key,values)
  }
  if(typeof source!=='string')return ''
  let key=source,values=params
  const applied=source.match(/^Подключён набор «(.*)»\.$/),saved=source.match(/^Набор «(.*)» сохранён в этом браузере\.$/),invalid=source.match(/^Недопустимый параметр: (.*)\.$/)
  if(applied){key='Подключён набор «{name}».';values={name:applied[1]}}
  if(saved){key='Набор «{name}» сохранён в этом браузере.';values={name:saved[1]}}
  if(invalid){key='Недопустимый параметр: {key}.';values={key:invalid[1]}}
  return translate(preferences.locale,key,values)
}
export function number(value,options={}){return new Intl.NumberFormat(preferences.locale,options).format(value)}
