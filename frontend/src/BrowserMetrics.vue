<script setup>
import {ref,watch,onBeforeUnmount} from 'vue'
import {t,number} from './i18n.js'
const props=defineProps({active:Boolean,renderTime:Number})
const blocked=ref(null),heap=ref(null)
let observer=null,timer=0,tasks=[],started=0
function sample(){
  const now=performance.now(),start=Math.max(started,now-2000)
  tasks=tasks.filter(task=>task.end>start)
  if(observer){
    const busy=tasks.reduce((sum,task)=>sum+Math.max(0,Math.min(now,task.end)-Math.max(start,task.start)),0)
    blocked.value=Math.min(100,100*busy/Math.max(1,now-start))
  }
  const bytes=performance.memory?.usedJSHeapSize
  heap.value=Number.isFinite(bytes)?bytes/1048576:null
}
function stop(){observer?.disconnect();observer=null;clearInterval(timer);tasks=[];blocked.value=null;heap.value=null}
watch(()=>props.active,active=>{
  stop()
  if(!active)return
  started=performance.now()
  if(typeof PerformanceObserver!=='undefined'&&PerformanceObserver.supportedEntryTypes?.includes('longtask')){
    try{observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())tasks.push({start:entry.startTime,end:entry.startTime+entry.duration})});observer.observe({type:'longtask'});blocked.value=0}catch{observer=null}
  }
  sample();timer=setInterval(sample,1000)
},{immediate:true})
onBeforeUnmount(stop)
</script>
<template>
  <div class="browser-statusbar">
    <div v-if="active" class="browser-metrics" :aria-label="t('Метрики браузера')">
      
      <span :title="t('Время последнего рендера предпросмотра, включая ожидание worker. Это не процент CPU.')">{{t('Рендер')}} <b>{{number(renderTime||0)}} {{t('мс')}}</b></span>
      <span :title="t('Доля последних 2 секунд, занятая задачами основного потока длительностью от 50 мс. Не учитывает worker и GPU.')">{{t('Блокировки')}} <b>{{blocked===null?'—':number(blocked,{maximumFractionDigits:0})+'%'}}</b></span>
      <span :title="t('Используемая память JavaScript. Не включает весь браузер и GPU; доступна не во всех браузерах.')">{{t('JS-память')}} <b>{{heap===null?'—':number(heap,{maximumFractionDigits:0})+' '+t('МБ')}}</b></span>
    </div>
    <a class="repository-link" href="https://github.com/listoCheck/AmuzASCII-studio/tree/master" target="_blank" rel="noopener noreferrer" :aria-label="t('Репозиторий проекта на GitHub')" :title="t('Репозиторий проекта на GitHub')"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.58 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg><span class="repository-name">GitHub</span></a>
  </div>
</template>
