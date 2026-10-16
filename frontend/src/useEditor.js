import { ref, shallowRef, reactive, toRef, watch, onMounted, onBeforeUnmount } from 'vue'
import { charsets, palettes, geometry, previewGeometry, convertPixels, paletteLut, cellColor } from './ascii.js'
import {defaultSettings,normalizeColumns} from './presets.js'
import usePresets from './usePresets.js'
import {preferences} from './preferences.js'
import {safeFilename,htmlExport,videoFormats} from './export.js'
import {inkLayout,brighterInk} from './typography.js'
import {clipboardImage} from './clipboard.js'
import {canUseVectorPreview} from './svgPreview.js'

export default function useEditor() {
  const defaults=defaultSettings
  const settings=reactive({...defaults})
  const art=ref(null),fileInput=ref(null),file=shallowRef(null),result=shallowRef(null),stage=ref(null)
  const busy=ref(false),error=ref(''),notice=ref(''),showOriginal=ref(false),zoom=ref(1),format=toRef(preferences,'imageFormat')
  const exportQuality=toRef(preferences,'exportQuality'),fileName=toRef(preferences,'fileName'),videoFormat=toRef(preferences,'videoFormat')
  const colorMode=ref('palette'),foreground=ref('#d1e8a0'),background=ref('#10140f'),paletteIndex=ref(0)
  const canvasStyle=ref({}),frameTime=ref(0),vectorSrc=ref('')
  const detailDraft=ref(String(settings.columns)),isVideo=ref(false),duration=ref(0)
  const playing=ref(false),currentTime=ref(0),volume=ref(1),playbackRate=ref(1),loop=ref(false),videoFPS=ref(30),previewError=ref('')
  const videoDownloading=ref(false),downloadProgress=ref(0),downloadBytes=ref(0),downloadTotal=ref(0)
  let video=null,videoFrame=0,videoFrameNative=false,lastVideoFrame=-Infinity,downloadRequest=null
  const videoSource=shallowRef(null),videoJob=shallowRef(null),videoProcessing=ref(false)
  if(!videoFormats.some(item=>item.value===videoFormat.value))videoFormat.value='mp4'
  let renderFailed=false,videoPollTimer=0,videoController=null
  const controls=[{key:'brightness',name:'Яркость',min:-100,max:100,step:1},{key:'contrast',name:'Контраст',min:-100,max:100,step:1},{key:'saturation',name:'Насыщенность',min:0,max:200,step:1},{key:'gamma',name:'Гамма',min:.3,max:2.5,step:.1}]
  const sample=document.createElement('canvas'),sampleCtx=sample.getContext('2d',{willReadFrequently:true})
  const colorPlane=document.createElement('canvas'),colorCtx=colorPlane.getContext('2d')
  const glyphAtlas=document.createElement('canvas');let atlasKey='',glyphIndex=new Map()
  let image=null,objectUrl='',frame=0,sampleKey='',pixels=null,convertedKey='',resizeObserver,loadId=0
  let loadController
  let vectorTimer=0,vectorPendingUrl=''
  function clearVector(){
    if(vectorSrc.value)URL.revokeObjectURL(vectorSrc.value)
    if(vectorPendingUrl)URL.revokeObjectURL(vectorPendingUrl)
    vectorSrc.value='';vectorPendingUrl=''
  }
  function showVector(data){
    if(playing.value||data.id!==previewId||showOriginal.value||!canUseVectorPreview(previewGeometryNow()))return
    if(vectorPendingUrl)URL.revokeObjectURL(vectorPendingUrl)
    const url=URL.createObjectURL(new Blob([data.svg],{type:'image/svg+xml'})),ready=new Image()
    vectorPendingUrl=url
    ready.onload=()=>{
      if(!disposed&&data.id===previewId&&vectorPendingUrl===url&&canUseVectorPreview(previewGeometryNow())){
        if(vectorSrc.value)URL.revokeObjectURL(vectorSrc.value)
        vectorSrc.value=url;vectorPendingUrl='';fit()
      }else URL.revokeObjectURL(url)
    }
    ready.onerror=()=>{URL.revokeObjectURL(url);if(vectorPendingUrl===url)vectorPendingUrl=''}
    ready.src=url
  }
  let previewWorker=null,workerDisabled=false,workerRunning=false,pendingPreview=null,previewId=0,previewFloor=0,workerSource=-1,workerStarted=0,disposed=false
  function cancelPreview(){previewFloor=++previewId;pendingPreview=null;clearTimeout(vectorTimer);clearVector()}
  function previewGeometryNow(){
    const rotated=settings.rotation%180
    let geo=previewGeometry(settings.columns,rotated?image.height:image.width,rotated?image.width:image.height,
      stage.value.clientWidth,stage.value.clientHeight,zoom.value,window.devicePixelRatio||1)
    return geo
  }
  async function sendPreview(){
    if(workerRunning||!pendingPreview||disposed)return
    const job=pendingPreview;pendingPreview=null;workerRunning=true;workerStarted=performance.now()
    try{
      const transfers=[]
      if(workerSource!==job.sourceVersion){
        job.bitmap=await createImageBitmap(image)
        if(job.id<previewFloor||disposed){job.bitmap.close();workerRunning=false;sendPreview();return}
        transfers.push(job.bitmap);workerSource=job.sourceVersion
      }
      previewWorker.postMessage(job,transfers)
    }catch{workerRunning=false;disableWorker()}
  }
  function disableWorker(){
    previewWorker?.terminate();previewWorker=null;workerDisabled=true;workerRunning=false;pendingPreview=null
    if(!disposed)schedule()
  }
  function drawPreview(vector=false){
    if(!image||!art.value)return
    if(vector&&(showOriginal.value||workerDisabled))return
    if(vector&&!canUseVectorPreview(previewGeometryNow()))return
    if(settings.charset==='custom'&&(!settings.custom||Array.from(settings.custom).some(c=>c.codePointAt(0)<32))){
      cancelPreview();renderFailed=true;error.value='Введите хотя бы один печатный символ.';return
    }
    if(workerDisabled||showOriginal.value){cancelPreview();draw();return}
    if(!previewWorker){
      try{
        previewWorker=new Worker(new URL('./preview.worker.js',import.meta.url),{type:'module'})
        previewWorker.onerror=disableWorker
        previewWorker.onmessage=({data})=>{
          workerRunning=false
          if(data.error){if(data.vector){sendPreview();return}disableWorker();return}
          try{
            if(data.id>=previewFloor&&!disposed&&(!data.svg||data.id===previewId)){
              const canvas=art.value,geo=data.geo,ctx=canvas.getContext('2d')
              if(data.svg)showVector(data)
              else{
                if(canvas.width!==geo.width)canvas.width=geo.width
                if(canvas.height!==geo.height)canvas.height=geo.height
                ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
                ctx.drawImage(data.bitmap,0,0,geo.width,geo.height)
              }
              result.value=geo;convertedKey='';frameTime.value=Math.round(performance.now()-workerStarted);fit()
              if(renderFailed)error.value='';renderFailed=false
            }
          }finally{data.bitmap?.close();sendPreview()}
        }
      }catch{disableWorker();return}
    }
    pendingPreview={id:previewId,vector,sourceVersion:video?`${loadId}:${video.currentTime}`:loadId,mediaTime:video?.currentTime||0,
      settings:{...settings},geo:previewGeometryNow(),colorMode:colorMode.value,foreground:foreground.value,
      background:background.value,colors:[...palettes[paletteIndex.value].colors]}
    sendPreview()
  }
  function updateDetail(value){detailDraft.value=value;const n=Number(value);if(value!==''&&Number.isFinite(n)&&n>=40&&n<=1000)settings.columns=Math.round(n)}
  function commitDetail(){settings.columns=normalizeColumns(detailDraft.value,settings.columns);detailDraft.value=String(settings.columns)}
  watch(()=>settings.columns,value=>{detailDraft.value=String(value)})
  function releaseMedia(){
    stopVideoFrames();if(video){video.onpause=null;video.pause();video.removeAttribute('src');video.load();video=null}playing.value=false;currentTime.value=0;previewError.value=''
    downloadRequest?.abort();downloadRequest=null;videoDownloading.value=false
    cancelPreview();workerSource=-1
    clearTimeout(videoPollTimer);videoController?.abort();videoSource.value=null;videoJob.value=null;videoProcessing.value=false
    image?.close?.()
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=''}
  }
  function stopVideoFrames(){
    if(videoFrame){if(videoFrameNative)video?.cancelVideoFrameCallback?.(videoFrame);else cancelAnimationFrame(videoFrame);videoFrame=0}
  }
  function queueVideoFrame(){
    if(!video||video.paused||disposed)return
    const next=(now)=>{
      videoFrame=0
      if(!video||video.paused||disposed)return
      currentTime.value=video.currentTime
      if(now-lastVideoFrame>=1000/Number(videoFPS.value)-2){lastVideoFrame=now;schedule()}
      queueVideoFrame()
    }
    videoFrameNative=typeof video.requestVideoFrameCallback==='function'
    videoFrame=videoFrameNative?video.requestVideoFrameCallback(next):requestAnimationFrame(next)
  }
  async function attachVideo(url){
    const version=loadId,v=document.createElement('video')
    v.preload='auto';v.playsInline=true;v.volume=volume.value;v.playbackRate=playbackRate.value;v.loop=loop.value
    try{
      await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=reject;v.src=url;v.load()})
      if(disposed||version!==loadId){v.removeAttribute('src');v.load();return}
      image?.close?.();video=v;image=v;v.width=v.videoWidth;v.height=v.videoHeight
      if(Number.isFinite(v.duration)&&v.duration>0)duration.value=v.duration
      sampleKey='';convertedKey='';workerSource=-1;currentTime.value=0;previewError.value=''
      v.onloadeddata=null
      v.onplay=()=>{if(video===v){playing.value=true;lastVideoFrame=-Infinity;schedule();stopVideoFrames();queueVideoFrame()}}
      v.onpause=()=>{if(video===v){playing.value=false;stopVideoFrames();currentTime.value=v.currentTime;schedule()}}
      v.onseeked=()=>{if(video===v){sampleKey='';convertedKey='';currentTime.value=v.currentTime;schedule()}}
      v.ontimeupdate=()=>{if(video===v)currentTime.value=v.currentTime}
      v.onended=()=>{if(video===v){playing.value=false;stopVideoFrames();schedule()}}
      v.onerror=()=>{if(video===v){playing.value=false;stopVideoFrames();previewError.value='Браузер не поддерживает предпросмотр этого видео. Экспорт на сервере доступен.'}}
      schedule()
    }catch{
      v.removeAttribute('src');v.load()
      if(!disposed&&version===loadId)previewError.value='Браузер не поддерживает предпросмотр этого видео. Экспорт на сервере доступен.'
    }
  }
  async function togglePlay(){
    if(!video)return
    try{if(video.paused){if(video.ended)video.currentTime=0;await video.play()}else video.pause()}
    catch{previewError.value='Браузер не смог запустить видео. Попробуйте другой формат.'}
  }
  function seek(value){if(video&&Number.isFinite(Number(value))){video.currentTime=Math.max(0,Math.min(duration.value,Number(value)));currentTime.value=video.currentTime}}
  watch(volume,value=>{if(video)video.volume=Number(value)})
  watch(playbackRate,value=>{if(video)video.playbackRate=Number(value)})
  watch(loop,value=>{if(video)video.loop=value})
  function fullscreen(){stage.value?.parentElement?.requestFullscreen?.().catch(()=>{notice.value='Полноэкранный режим недоступен.'})}
  function timeLabel(value){const n=Number.isFinite(value)?Math.floor(value):0;return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`}
  function selectPalette(i){paletteIndex.value=i;foreground.value=palettes[i].colors[3];background.value=palettes[i].bg;colorMode.value='palette'}
  function fit(){
    if(!stage.value||!result.value)return
    const rotated=settings.rotation%180
    const geo=previewGeometry(settings.columns,rotated?image.height:image.width,rotated?image.width:image.height,
      stage.value.clientWidth,stage.value.clientHeight,zoom.value,window.devicePixelRatio||1)
    canvasStyle.value={width:`${geo.displayWidth}px`,height:`${geo.displayHeight}px`}
  }
  function draw(fullResolution=false){
    if(!image||!art.value)return
    const start=performance.now()
    try{
      const rotated=settings.rotation%180,sw=rotated?image.height:image.width,sh=rotated?image.width:image.height
      let geo=fullResolution
        ?geometry(settings.columns,sw,sh,8192,Math.max(1600,settings.columns*8))
        :previewGeometry(settings.columns,sw,sh,stage.value.clientWidth,stage.value.clientHeight,zoom.value,window.devicePixelRatio||1)
        const key=[settings.columns,geo.rows,settings.rotation,settings.mirror,video?.currentTime??'image'].join(':')
      if(key!==sampleKey){
        sample.width=geo.columns;sample.height=geo.rows
        sampleCtx.imageSmoothingEnabled=true;sampleCtx.imageSmoothingQuality='high'
        sampleCtx.save();sampleCtx.translate(geo.columns/2,geo.rows/2)
        sampleCtx.rotate(settings.rotation*Math.PI/180);sampleCtx.scale(settings.mirror?-1:1,1)
        const w=rotated?geo.rows:geo.columns,h=rotated?geo.columns:geo.rows
        sampleCtx.drawImage(image,-w/2,-h/2,w,h);sampleCtx.restore()
        pixels=sampleCtx.getImageData(0,0,geo.columns,geo.rows).data;sampleKey=key;convertedKey=''
      }
      const conversionKey=[key,settings.charset,settings.custom,settings.brightness,settings.contrast,settings.saturation,settings.gamma,settings.invert].join('|')
      if(conversionKey!==convertedKey){
        result.value={...convertPixels(pixels,geo.columns,geo.rows,settings),...geo}
        convertedKey=conversionKey
      }
      if(result.value.width!==geo.width||result.value.height!==geo.height)result.value={...result.value,...geo}
      const canvas=art.value,data=result.value,ctx=canvas.getContext('2d')
      if(canvas.width!==geo.width)canvas.width=geo.width
      if(canvas.height!==geo.height)canvas.height=geo.height
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
      ctx.clearRect(0,0,canvas.width,canvas.height)
      if(showOriginal.value){
        ctx.save();ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(settings.rotation*Math.PI/180);ctx.scale(settings.mirror?-1:1,1)
        const w=rotated?canvas.height:canvas.width,h=rotated?canvas.width:canvas.height
        ctx.drawImage(image,-w/2,-h/2,w,h);ctx.restore()
      }else{
        // Render a white text mask, then color the whole mask in one composite.
        // This avoids one expensive fillText/style change for every colored cell.
        ctx.save();ctx.scale(geo.cellWidth/8,geo.cellHeight/16)
        ctx.textBaseline='alphabetic';ctx.textAlign='center'
        ctx.fillStyle='#ffffff'
        const lut=paletteLut(palettes[paletteIndex.value].colors,settings.saturation)
        const chars=settings.charset==='custom'?settings.custom:charsets.find(s=>s.id===settings.charset).chars
        const layout=inkLayout(ctx,chars,16);ctx.font=layout.font
        if(/^[\x20-\x7e]+$/.test(chars)){
          ctx.textAlign='left'
          const spacing=ctx.measureText('M').width
          ctx.scale(8/spacing,1)
          data.lines.forEach((line,y)=>ctx.fillText(line,0,y*16+layout.baseline))
        }else if(data.columns*data.rows<=12000){
          // Sparse grids are cheap to draw as vector glyphs at native density.
          data.lines.forEach((line,y)=>Array.from(line).forEach((ch,x)=>{
            if(ch!==' ')ctx.fillText(ch,x*8+4,y*16+layout.baseline,8)
          }))
        }else{
          // Rasterize the Unicode atlas at the actual on-screen cell density.
          // Enlarging an old 8 × 16 tile makes low-detail previews blurry.
          const tileWidth=Math.max(8,Math.ceil(geo.cellWidth)),tileHeight=Math.max(16,Math.ceil(geo.cellHeight))
          const newAtlasKey=[chars,geo.columns,tileWidth,tileHeight].join(':')
          if(atlasKey!==newAtlasKey){
            const symbols=[...new Set(Array.from(chars))];glyphIndex=new Map(symbols.map((ch,i)=>[ch,i]))
            glyphAtlas.width=geo.columns*tileWidth;glyphAtlas.height=symbols.length*tileHeight
            const glyphCtx=glyphAtlas.getContext('2d'),tileLayout=inkLayout(glyphCtx,chars,tileHeight)
            glyphCtx.font=tileLayout.font;glyphCtx.textBaseline='alphabetic';glyphCtx.textAlign='left';glyphCtx.fillStyle='#ffffff'
            symbols.forEach((ch,i)=>{
              const advance=glyphCtx.measureText(ch).width||8
              glyphCtx.save();glyphCtx.scale(tileWidth/advance,1);glyphCtx.fillText(ch.repeat(geo.columns),0,i*tileHeight+tileLayout.baseline);glyphCtx.restore()
            });atlasKey=newAtlasKey
          }
          data.lines.forEach((line,y)=>{
            const symbols=Array.from(line)
            for(let x=0;x<symbols.length;){
              const ch=symbols[x];let end=x+1
              while(end<symbols.length&&symbols[end]===ch)end++
              const width=(end-x)*8
              if(ch!==' ')ctx.drawImage(glyphAtlas,0,glyphIndex.get(ch)*tileHeight,(end-x)*tileWidth,tileHeight,x*8,y*16,width,16)
              x=end
            }
          })
        }
        ctx.restore()
        ctx.globalCompositeOperation='source-in'
        if(colorMode.value==='mono'){
          ctx.fillStyle=brighterInk(foreground.value,settings.inkBrightness);ctx.fillRect(0,0,canvas.width,canvas.height)
        }else{
          colorPlane.width=data.columns;colorPlane.height=data.rows
          const plane=colorCtx.createImageData(data.columns,data.rows),tones=lut.map(c=>c.match(/\d+/g).map(Number))
          for(let n=0;n<data.columns*data.rows;n++){
            const i=n*4,j=n*3,color=colorMode.value==='original'?data.rgb.subarray(j,j+3):tones[Math.min(31,data.light[n]>>3)]
            plane.data[i]=Math.min(255,Math.round(color[0]*settings.inkBrightness/100));plane.data[i+1]=Math.min(255,Math.round(color[1]*settings.inkBrightness/100));plane.data[i+2]=Math.min(255,Math.round(color[2]*settings.inkBrightness/100));plane.data[i+3]=255
          }
          colorCtx.putImageData(plane,0,0);ctx.imageSmoothingEnabled=false
          ctx.drawImage(colorPlane,0,0,canvas.width,canvas.height)
        }
        ctx.globalCompositeOperation='source-over'
      }
      ctx.globalCompositeOperation='destination-over';ctx.fillStyle=background.value;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.globalCompositeOperation='source-over'
      if(renderFailed)error.value='';renderFailed=false;fit();frameTime.value=Math.round(performance.now()-start)
    }catch(e){renderFailed=true;error.value=e.message}
  }
  function schedule(force=true){
    if(force){
      previewId++;clearVector();clearTimeout(vectorTimer)
      if(image&&!playing.value&&!showOriginal.value&&!workerDisabled)vectorTimer=setTimeout(()=>drawPreview(true),160)
    }
    if(!frame)frame=requestAnimationFrame(()=>{frame=0;drawPreview()})
  }

  function flush(){cancelPreview();if(frame){cancelAnimationFrame(frame);frame=0}draw()}
  // One render per animation frame. No debounce, HTTP round-trip or Vue pixel proxies.
  watch(settings,schedule,{flush:'sync'})
  watch([foreground,background,colorMode,showOriginal,paletteIndex],schedule,{flush:'sync'})
  function resizePreview(){
    if(vectorSrc.value&&!showOriginal.value&&canUseVectorPreview(previewGeometryNow()))fit()
    else schedule()
  }
  watch(zoom,resizePreview)
  async function openBlob(blob,name=''){
    const id=++loadId;busy.value=true;error.value=''
    let bitmap
    try{
      bitmap=await createImageBitmap(blob)
      if(id!==loadId){bitmap.close();return}
      if(bitmap.width*bitmap.height>25_000_000)throw new Error('Максимальное разрешение — 25 мегапикселей.')
      if(Math.max(bitmap.width/bitmap.height,bitmap.height/bitmap.width)>100)throw new Error('Поддерживаются пропорции изображения от 1:100 до 100:1.')
      releaseMedia();image=bitmap;bitmap=null;isVideo.value=false;duration.value=0
      objectUrl=URL.createObjectURL(blob);file.value=name?{name}:null
      sampleKey='';convertedKey='';settings.rotation=0;settings.mirror=false;showOriginal.value=false
      schedule();return true
    }catch(e){bitmap?.close();if(id===loadId)error.value=e.message||'Не удалось открыть изображение.'}
    finally{if(id===loadId)busy.value=false}
  }
  async function videoResponse(response){
    if(response.ok)return response.json()
    let data;try{data=await response.json()}catch{}
    const failure=new Error(typeof data?.detail==='string'?data.detail:'Сервер не смог обработать запрос видео.')
    failure.status=response.status;throw failure
  }
  async function openVideo(selected){
    const id=++loadId;busy.value=true;error.value=''
    videoController?.abort();videoController=new AbortController()
    const signal=videoController.signal,form=new FormData();form.append('file',selected)
    try{
      const source=await videoResponse(await fetch('/api/videos',{method:'POST',body:form,signal}))
      if(id!==loadId||disposed)return
      const poster=await fetch(source.poster_url,{signal});if(!poster.ok)throw new Error('Не удалось загрузить первый кадр видео.')
      const blob=await poster.blob();if(id!==loadId||disposed)return
      if(!await openBlob(blob,selected.name))return
      isVideo.value=true;videoSource.value=source;duration.value=source.duration;videoJob.value=null
      objectUrl&&URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(selected)
      notice.value='Видео загружено. Предпросмотр доступен в проигрывателе, экспорт — через сервер.';schedule();await attachVideo(objectUrl)
    }catch(e){if(e.name!=='AbortError'&&!disposed&&id===loadId)error.value=e.message}
    finally{if(!disposed&&id===loadId)busy.value=false}
  }
  async function downloadVideo(){
    if(videoJob.value?.status!=='completed'||videoDownloading.value)return
    videoDownloading.value=true;downloadProgress.value=0;downloadBytes.value=0;downloadTotal.value=0;error.value=''
    const job=videoJob.value
    try{
      const blob=await new Promise((resolve,reject)=>{
        const request=new XMLHttpRequest();downloadRequest=request
        request.open('GET',`/api/video-jobs/${job.id}/download`);request.responseType='blob'
        request.onprogress=event=>{downloadBytes.value=event.loaded;downloadTotal.value=event.lengthComputable?event.total:0;downloadProgress.value=event.lengthComputable?Math.round(event.loaded/event.total*100):0}
        request.onload=()=>request.status===200?resolve(request.response):reject(new Error('Не удалось скачать видео. Повторите скачивание.'))
        request.onerror=()=>reject(new Error('Не удалось скачать видео. Повторите скачивание.'))
        request.onabort=()=>reject(new DOMException('Aborted','AbortError'))
        request.send()
      })
      if(disposed||videoJob.value?.id!==job.id)return
      downloadProgress.value=100;downloadBytes.value=blob.size;downloadTotal.value=blob.size
      downloadBlob(blob,job.format);notice.value='Полное ASCII-видео скачано.'
    }catch(e){if(e.name!=='AbortError'&&!disposed)error.value=e.message}
    finally{downloadRequest=null;videoDownloading.value=false}
  }
  async function pollVideo(id,signal){
    try{
      const response=await fetch(`/api/video-jobs/${id}`,{signal}),job=await videoResponse(response)
      if(disposed||signal.aborted||videoJob.value?.id!==id)return
      videoJob.value=job
      if(job.status==='completed'){
        if(!duration.value)duration.value=job.result?.duration||0
        forgetVideoJob();videoProcessing.value=false;notice.value='Полное ASCII-видео готово. Его можно скачать.';downloadVideo();return
      }
      if(job.status==='failed'){forgetVideoJob();videoProcessing.value=false;error.value=job.error;return}
      videoPollTimer=setTimeout(()=>pollVideo(id,signal),800)
    }catch(e){
      if(e.name==='AbortError'||disposed)return
      if(e.status===404){forgetVideoJob();videoProcessing.value=false;error.value=e.message;return}
      notice.value='Не удалось проверить статус видео. Повторная попытка…'
      videoPollTimer=setTimeout(()=>pollVideo(id,signal),3000)
    }
  }
  async function startVideoProcessing(){
    if(!videoSource.value||videoProcessing.value||videoDownloading.value)return
    videoProcessing.value=true;error.value='';notice.value='Обрабатывается весь ролик на сервере.'
    videoController?.abort();videoController=new AbortController();const signal=videoController.signal
    const options={...settings,colorMode:colorMode.value,foreground:foreground.value,background:background.value,
      colors:[...palettes[paletteIndex.value].colors],format:videoFormat.value,fileName:safeFilename(fileName.value)}
    try{
      const job=await videoResponse(await fetch(`/api/videos/${videoSource.value.id}/jobs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options),signal}))
      if(disposed||signal.aborted)return
      videoJob.value=job
      try{localStorage.setItem('AmuzASCII.videoJob.v1',JSON.stringify({source:videoSource.value,jobId:job.id}))}catch{}
      videoPollTimer=setTimeout(()=>pollVideo(job.id,signal),300)
    }catch(e){if(e.name!=='AbortError'&&!disposed){videoProcessing.value=false;error.value=e.message}}
  }
  function forgetVideoJob(){try{localStorage.removeItem('AmuzASCII.videoJob.v1')}catch{}}
  async function restoreVideoJob(){
    let saved
    try{saved=JSON.parse(localStorage.getItem('AmuzASCII.videoJob.v1')||'null')}catch{forgetVideoJob();return false}
    if(!saved)return false
    if(!/^[a-f0-9]{32}$/.test(saved.jobId)||!/^[a-f0-9]{32}$/.test(saved.source?.id)){forgetVideoJob();return false}
    try{
      busy.value=true
      const response=await fetch(`/api/videos/${saved.source.id}/poster`,{signal:loadController.signal})
      if(!response.ok){forgetVideoJob();return false}
      const blob=await response.blob()
      if(!await openBlob(blob,String(saved.source.name||'video')))return false
      isVideo.value=true;videoSource.value=saved.source;duration.value=Number(saved.source.duration)||0
      videoJob.value={id:saved.jobId,status:'queued',progress:0,frames:0};videoProcessing.value=true
      videoController=new AbortController();videoPollTimer=setTimeout(()=>pollVideo(saved.jobId,videoController.signal),100)
      notice.value='Восстановлена обработка полного видео.';schedule();attachVideo(`/api/videos/${saved.source.id}/source`);return true
    }catch(e){if(e.name!=='AbortError')forgetVideoJob();return false}
    finally{busy.value=false}
  }
  function upload(selected){
    if(!selected)return
    if(videoProcessing.value||videoDownloading.value){notice.value='Дождитесь завершения обработки видео.';return}
    if(selected.type.startsWith('video/')||/\.(mp4|webm|mov|m4v|ogv|avi|mkv|mpeg|mpg|wmv|flv)$/i.test(selected.name)){
      if(selected.size>250*1024*1024){error.value='Максимальный размер видео — 250 МБ.';return}
      loadController?.abort();openVideo(selected);return
    }
    if(!selected.type.startsWith('image/')){error.value='Выберите изображение или видео MP4/WebM.';return}
    if(selected.size>20*1024*1024){error.value='Максимальный размер файла — 20 МБ.';return}
    loadController?.abort();openBlob(selected,selected.name)
  }
  function drop(event){upload(event.dataTransfer.files[0])}
  function pasteImage(event){
    // Keep ordinary text pasting intact in settings and modal dialogs.
    if(event.defaultPrevented||document.querySelector('dialog[open]')||event.target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"])'))return
    const selected=clipboardImage(event.clipboardData)
    if(!selected)return
    event.preventDefault()
    upload(selected.name?selected:new File([selected],'clipboard.png',{type:selected.type}))
  }
  function reset(){Object.assign(settings,defaults);colorMode.value='palette';showOriginal.value=false;zoom.value=1;selectPalette(0);schedule()}
  function setZoom(delta){zoom.value=Math.max(.25,Math.min(4,zoom.value+delta))}
  function downloadBlob(blob,ext){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${safeFilename(fileName.value)}.${ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}
  const xml=s=>s.replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))
  function download(){
    if(!image||busy.value)return
    if(isVideo.value){downloadVideo();return}
    showOriginal.value=false;cancelPreview();if(frame){cancelAnimationFrame(frame);frame=0}draw(true)
    if(error.value)return
    const data=result.value
    if(['png','jpeg','webp'].includes(format.value)){
      const type='image/'+format.value,extension=format.value==='jpeg'?'jpg':format.value
      art.value.toBlob(blob=>{
        if(!blob){error.value='Не удалось создать файл изображения.';return}
        if(blob.type!==type){error.value='Браузер не поддерживает выбранный формат изображения.';return}
        downloadBlob(blob,extension)
      },type,exportQuality.value/100)
    }
    else if(format.value==='txt')downloadBlob(new Blob([data.text],{type:'text/plain;charset=utf-8'}),'txt')
    else if(format.value==='html'){
      const lut=paletteLut(palettes[paletteIndex.value].colors,settings.saturation)
      const html=htmlExport(data,n=>brighterInk(cellColor(data,n,colorMode.value,foreground.value,lut),settings.inkBrightness),background.value,safeFilename(fileName.value),preferences.locale)
      downloadBlob(new Blob([html],{type:'text/html;charset=utf-8'}),'html')
    }
    else{
      const lut=paletteLut(palettes[paletteIndex.value].colors,settings.saturation)
      const chars=settings.charset==='custom'?settings.custom:charsets.find(s=>s.id===settings.charset).chars,layout=inkLayout(sampleCtx,chars,16)
      const text=data.lines.map((line,y)=>Array.from(line).map((ch,x)=>ch===' '?'':`<text x="${x*8+4}" y="${y*16+layout.baseline}" textLength="8" lengthAdjust="spacingAndGlyphs" fill="${brighterInk(cellColor(data,y*data.columns+x,colorMode.value,foreground.value,lut),settings.inkBrightness)}">${xml(ch)}</text>`).join('')).join('')
      downloadBlob(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}"><rect width="100%" height="100%" fill="${background.value}"/><g transform="scale(${data.cellWidth/8} ${data.cellHeight/16})" font-family="monospace" font-size="${layout.size}" font-weight="bold" text-anchor="middle" dominant-baseline="alphabetic" xml:space="preserve">${text}</g></svg>`],{type:'image/svg+xml'}),'svg')
    }
    schedule()
  }
  async function copy(){flush();if(error.value||!result.value)return;try{await navigator.clipboard.writeText(result.value.text);notice.value='ASCII-текст скопирован.'}catch{notice.value='Копирование недоступно. Скачайте файл TXT.'}finally{schedule()}}
  onMounted(async()=>{
    resizeObserver=new ResizeObserver(resizePreview);resizeObserver.observe(stage.value)
    window.addEventListener('resize',resizePreview)
    window.addEventListener('paste',pasteImage)
    loadController=new AbortController()
    if(await restoreVideoJob())return
    try{const response=await fetch('/api/demo',{signal:loadController.signal});if(!response.ok)throw new Error();const blob=await response.blob();if(!file.value)await openBlob(blob)}
    catch(e){if(e.name!=='AbortError')error.value='Не удалось загрузить демо. Загрузите своё изображение.'}
  })
  const presetControls=usePresets(settings,{colorMode,foreground,background,paletteIndex},error,notice)
  onBeforeUnmount(()=>{disposed=true;previewWorker?.terminate();loadId++;loadController?.abort();cancelAnimationFrame(frame);resizeObserver?.disconnect();window.removeEventListener('resize',resizePreview);window.removeEventListener('paste',pasteImage);releaseMedia()})
  return {...presetControls,settings,art,fileInput,file,result,stage,busy,error,notice,showOriginal,zoom,format,colorMode,foreground,background,paletteIndex,palettes,charsets,controls,canvasStyle,frameTime,vectorSrc,selectPalette,upload,drop,reset,setZoom,download,copy,detailDraft,updateDetail,commitDetail,isVideo,duration,playing,currentTime,volume,playbackRate,loop,videoFPS,previewError,togglePlay,seek,fullscreen,videoDownloading,downloadProgress,downloadBytes,downloadTotal,videoSource,videoJob,videoProcessing,startVideoProcessing,downloadVideo,timeLabel,exportQuality,fileName,videoFormat,videoFormats}
}
