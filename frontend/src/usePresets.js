import {ref,watch,onMounted,onBeforeUnmount} from 'vue'
import {builtinPresets,validatePreset} from './presets.js'
import {t,translate} from './i18n.js'
import {preferences} from './preferences.js'

export default function usePresets(settings,appearance,error,notice){
  const savedPresets=ref([]),presetName=ref(t('Мой набор')),selectedPreset=ref(''),presetInput=ref(null)
  const storageKey='AmuzASCII.presets.v1',sessionKey='AmuzASCII.session.v1'
  let timer,loaded=false
  watch(()=>preferences.locale,(next,previous)=>{if(presetName.value===translate(previous,'Мой набор'))presetName.value=translate(next,'Мой набор')})
  function snapshot(name=presetName.value){return validatePreset({app:'AmuzASCII',version:1,name,settings:{...settings},appearance:Object.fromEntries(Object.entries(appearance).map(([key,value])=>[key,value.value]))})}
  function persist(){try{localStorage.setItem(storageKey,JSON.stringify(savedPresets.value));return true}catch{notice.value='Хранилище браузера недоступно. Скачайте набор в JSON.';return false}}
  function persistSession(){try{if(loaded)localStorage.setItem(sessionKey,JSON.stringify(snapshot('Последний сеанс')))}catch{/* Exported JSON can be used if storage is unavailable. */}}
  function apply(data,localizeName=false){
    try{const clean=validatePreset(data);Object.assign(settings,clean.settings);for(const [key,value] of Object.entries(clean.appearance))appearance[key].value=value;error.value='';notice.value=localizeName?{key:'Подключён набор «{name}».',params:{name:clean.name},localizeName:true}:`Подключён набор «${clean.name}».`}
    catch(e){error.value=e.message}
  }
  function applySelected(){
    const [kind,id]=selectedPreset.value.split(':')
    const data=kind==='builtin'?builtinPresets[Number(id)]:savedPresets.value.find(p=>p.id===id)?.data
    if(data)apply(data,kind==='builtin')
  }
  function savePreset(){
    try{
      const data=snapshot()
      if(savedPresets.value.length>=100)throw new Error('Можно хранить до 100 наборов. Удалите ненужные или скачайте их.')
      const id=crypto.randomUUID();savedPresets.value.push({id,data});selectedPreset.value='saved:'+id
      if(persist())notice.value=`Набор «${data.name}» сохранён в этом браузере.`
      error.value=''
    }catch(e){error.value=e.message}
  }
  function removePreset(){
    if(!selectedPreset.value.startsWith('saved:'))return
    const id=selectedPreset.value.slice(6);savedPresets.value=savedPresets.value.filter(p=>p.id!==id);persist();selectedPreset.value='';notice.value='Набор удалён из библиотеки.'
  }
  function exportPreset(){
    try{const blob=new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='AmuzASCII-preset.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}catch(e){error.value=e.message}
  }
  async function importPreset(file){
    if(!file)return
    try{
      if(file.size>1_000_000)throw new Error('Файл набора должен быть меньше 1 МБ.')
      const data=validatePreset(JSON.parse(await file.text()))
      if(savedPresets.value.length>=100)throw new Error('В библиотеке уже 100 наборов.')
      const id=crypto.randomUUID();savedPresets.value.push({id,data});persist();selectedPreset.value='saved:'+id;presetName.value=data.name;apply(data)
    }catch(e){error.value=e instanceof SyntaxError?'Повреждённый JSON-файл набора.':e.message}
  }
  watch([settings,...Object.values(appearance)],()=>{
    if(!loaded)return
    clearTimeout(timer);timer=setTimeout(persistSession,250)
  },{deep:true})
  onMounted(()=>{
    try{
      const library=JSON.parse(localStorage.getItem(storageKey)||'[]')
      if(Array.isArray(library))savedPresets.value=library.slice(0,100).flatMap(p=>{try{return [{id:typeof p.id==='string'?p.id:crypto.randomUUID(),data:validatePreset(p.data)}]}catch{return []}})
      const session=localStorage.getItem(sessionKey);if(session)apply(JSON.parse(session),true)
    }catch{notice.value='Сохранённые настройки не прочитаны. Можно импортировать набор JSON.'}
    loaded=true
    window.addEventListener('pagehide',persistSession)
  })
  onBeforeUnmount(()=>{clearTimeout(timer);persistSession();window.removeEventListener('pagehide',persistSession)})
  return {savedPresets,presetName,selectedPreset,presetInput,builtinPresets,applySelected,savePreset,removePreset,exportPreset,importPreset}
}
