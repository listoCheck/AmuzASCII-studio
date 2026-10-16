import { ref, shallowRef, reactive, toRef, watch, onMounted, onBeforeUnmount } from 'vue'
import { charsets, palettes, geometry, previewGeometry, convertPixels, paletteLut, cellColor } from './ascii.js'
import {defaultSettings,normalizeColumns} from './presets.js'
import usePresets from './usePresets.js'
import {readDuration} from './video.js'
import {preferences} from './preferences.js'
import {safeFilename,supportedVideoFormats,htmlExport} from './export.js'
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
  const detailDraft=ref(String(settings.columns)),isVideo=ref(false),playing=ref(false),currentTime=ref(0),duration=ref(0)
  const volume=ref(1),playbackRate=ref(1),loop=ref(false),videoFPS=ref(24),recording=ref(false)
  const videoFormats=supportedVideoFormats(mime=>typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported(mime))
  if(!videoFormats.some(item=>item.value===videoFormat.value))videoFormat.value=videoFormats[0]?.value||'webm'
  const canRecord=typeof MediaRecorder!=='undefined'&&typeof HTMLCanvasElement.prototype.captureStream==='function'&&videoFormats.length>0
  let video=null,lastVideoRender=0,forceFrame=false,recorder=null,recordStream=null,recordSave=true,recordSize=null,renderFailed=false
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
    if(data.id!==previewId||showOriginal.value||isVideo.value||!canUseVectorPreview(previewGeometryNow()))return
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
    if(recording.value&&recordSize)geo={...geo,...recordSize,cellWidth:recordSize.width/geo.columns,cellHeight:recordSize.height/geo.rows}
    return geo
  }
  async function sendPreview(){
    if(workerRunning||!pendingPreview||disposed)return
    const job=pendingPreview;pendingPreview=null;workerRunning=true;workerStarted=performance.now()
    try{
      const transfers=[]
      if(workerSource!==job.sourceVersion||isVideo.value){
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
    if(!image||!art.value||video?.seeking)return
    if(vector&&(isVideo.value||showOriginal.value||workerDisabled))return
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
    pendingPreview={id:previewId,vector,sourceVersion:loadId,mediaTime:isVideo.value?video.currentTime:0,
      settings:{...settings},geo:previewGeometryNow(),colorMode:colorMode.value,foreground:foreground.value,
      background:background.value,colors:[...palettes[paletteIndex.value].colors]}
    sendPreview()
  }
  function updateDetail(value){detailDraft.value=value;const n=Number(value);if(value!==''&&Number.isFinite(n)&&n>=40&&n<=1000)settings.columns=Math.round(n)}
  function commitDetail(){settings.columns=normalizeColumns(detailDraft.value,settings.columns);detailDraft.value=String(settings.columns)}
  watch(()=>settings.columns,value=>{detailDraft.value=String(value)})
  function releaseMedia(){
    cancelPreview();workerSource=-1
    stopRecording(false)
    if(video){video.pause();video.removeAttribute('src');video.load();video=null}
    image?.close?.();playing.value=false
    if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=''}
  }
  function timeLabel(value){const n=Number.isFinite(value)?Math.floor(value):0;return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`}
  async function togglePlay(){if(!video)return;try{if(video.paused){if(video.ended)video.currentTime=0;await video.play()}else video.pause()}catch{error.value='Браузер не смог запустить видео. Попробуйте другой формат.'}}
  function seek(value){if(video&&Number.isFinite(Number(value))){video.currentTime=Math.max(0,Math.min(duration.value,Number(value)));currentTime.value=video.currentTime;schedule()}}
  watch(volume,value=>{if(video)video.volume=Number(value)})
  watch(playbackRate,value=>{if(video)video.playbackRate=Number(value)})
  watch(loop,value=>{if(video&&!recording.value)video.loop=value})
  function fullscreen(){stage.value?.parentElement?.requestFullscreen?.().catch(()=>{notice.value='Полноэкранный режим недоступен.'})}
  function stopRecording(save=true){recordSave=save;if(recorder&&recorder.state!=='inactive')recorder.stop()}
  async function startRecording(){
    if(!video||!canRecord||recording.value)return
    try{
      showOriginal.value=false;flush()
      const selected=videoFormats.find(item=>item.value===videoFormat.value),mime=selected?.mime
      if(!mime)throw new Error('Браузер не поддерживает выбранный формат видео.')
      recordSize={width:art.value.width,height:art.value.height};recordSave=true
      recordStream=art.value.captureStream(Number(videoFPS.value));const chunks=[];let bytes=0
      const active=new MediaRecorder(recordStream,{mimeType:mime,videoBitsPerSecond:8_000_000});recorder=active
      active.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>200*1024*1024){notice.value='Достигнут предел записи 200 МБ. Фрагмент сохранён.';stopRecording()}}}
      active.onstop=()=>{
        if(recordSave&&chunks.length){downloadBlob(new Blob(chunks,{type:mime}),selected.extension);notice.value='Видео сохранено без звука.'}
        recordStream?.getTracks().forEach(track=>track.stop());recordStream=null;recorder=null;recording.value=false;recordSize=null
        if(video)video.loop=loop.value;schedule()
      }
      active.onerror=()=>{error.value='Ошибка записи видео. Попробуйте снизить детализацию.';stopRecording(false)}
      video.loop=false;await video.play();active.start(1000);recording.value=true;notice.value='Записывается ASCII-видео с текущей позиции, без звука. Остановите запись для сохранения.'
    }catch(e){recordStream?.getTracks().forEach(t=>t.stop());recordStream=null;recorder=null;recordSize=null;recording.value=false;error.value=e.message}
  }
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
    if(isVideo.value&&video?.seeking)return
    const start=performance.now()
    try{
      const rotated=settings.rotation%180,sw=rotated?image.height:image.width,sh=rotated?image.width:image.height
      let geo=fullResolution
        ?geometry(settings.columns,sw,sh,8192,Math.max(1600,settings.columns*8))
        :previewGeometry(settings.columns,sw,sh,stage.value.clientWidth,stage.value.clientHeight,zoom.value,window.devicePixelRatio||1)
      if(recording.value&&recordSize)geo={...geo,...recordSize,cellWidth:recordSize.width/geo.columns,cellHeight:recordSize.height/geo.rows}
      const key=[settings.columns,geo.rows,settings.rotation,settings.mirror,isVideo.value?video?.currentTime:'image'].join(':')
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
      if(image&&!isVideo.value&&!showOriginal.value&&!workerDisabled)vectorTimer=setTimeout(()=>drawPreview(true),160)
    }
    forceFrame=forceFrame||Boolean(force)
    if(!frame)frame=requestAnimationFrame(now=>{
      frame=0
      if(forceFrame||!isVideo.value||now-lastVideoRender>=1000/Number(videoFPS.value)){
        forceFrame=false;drawPreview();lastVideoRender=now;if(video)currentTime.value=video.currentTime
      }
      if(isVideo.value&&video&&!video.paused&&!video.ended)schedule(false)
    })
  }
  function flush(){cancelPreview();if(frame){cancelAnimationFrame(frame);frame=0}draw()}
  // One render per animation frame. No debounce, HTTP round-trip or Vue pixel proxies.
  watch(settings,schedule,{flush:'sync'})
  watch([foreground,background,colorMode,showOriginal,paletteIndex],schedule,{flush:'sync'})
  function resizePreview(){
    if(vectorSrc.value&&!isVideo.value&&!showOriginal.value&&canUseVectorPreview(previewGeometryNow()))fit()
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
      releaseMedia();image=bitmap;bitmap=null;isVideo.value=false;currentTime.value=0;duration.value=0
      objectUrl=URL.createObjectURL(blob);file.value=name?{name}:null
      sampleKey='';convertedKey='';settings.rotation=0;settings.mirror=false;showOriginal.value=false
      schedule()
    }catch(e){bitmap?.close();if(id===loadId)error.value=e.message||'Не удалось открыть изображение.'}
    finally{if(id===loadId)busy.value=false}
  }
  async function openVideo(selected){
    const id=++loadId;busy.value=true;error.value=''
    const v=document.createElement('video'),url=URL.createObjectURL(selected)
    v.preload='auto';v.playsInline=true;v.volume=volume.value;v.playbackRate=Number(playbackRate.value);v.loop=loop.value
    try{
      await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(new Error('Не удалось прочитать видео. Попробуйте MP4 (H.264) или WebM.'));v.src=url;v.load()})
      const videoDuration=await readDuration(v)
      if(id!==loadId){v.removeAttribute('src');v.load();URL.revokeObjectURL(url);return}
      if(!v.videoWidth||!v.videoHeight||v.videoWidth*v.videoHeight>25_000_000||!Number.isFinite(v.duration)||v.duration<=0)throw new Error('Видео имеет неподдерживаемое разрешение или длительность.')
      if(Math.max(v.videoWidth/v.videoHeight,v.videoHeight/v.videoWidth)>100)throw new Error('Поддерживаются пропорции от 1:100 до 100:1.')
      releaseMedia();video=v;image=v;v.width=v.videoWidth;v.height=v.videoHeight;objectUrl=url
      isVideo.value=true;playing.value=false;duration.value=videoDuration;currentTime.value=0;file.value={name:selected.name}
      sampleKey='';convertedKey='';settings.rotation=0;settings.mirror=false;showOriginal.value=false
      v.onplay=()=>{if(video===v){playing.value=true;schedule()}}
      v.onpause=()=>{if(video===v){playing.value=false;currentTime.value=v.currentTime;schedule()}}
      v.onseeked=()=>{if(video===v){sampleKey='';convertedKey='';currentTime.value=v.currentTime;schedule()}}
      v.ontimeupdate=()=>{if(video===v)currentTime.value=v.currentTime}
      v.onended=()=>{if(video===v){playing.value=false;stopRecording();schedule()}}
      v.onerror=()=>{if(video===v)error.value='Ошибка декодирования видео. Попробуйте другой файл.'}
      notice.value='Видео готово. Нажмите ▶ для ASCII-воспроизведения.';schedule()
    }catch(e){v.removeAttribute('src');v.load();URL.revokeObjectURL(url);if(id===loadId)error.value=e.message}
    finally{if(id===loadId)busy.value=false}
  }
  function upload(selected){
    if(!selected)return
    if(recording.value){notice.value='Сначала остановите запись видео.';return}
    if(selected.type.startsWith('video/')||/\.(mp4|webm|mov|m4v|ogv)$/i.test(selected.name)){
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
    if(recording.value){notice.value='Сначала остановите запись, затем сохраните кадр.';return}
    if(video)video.pause()
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
    try{const response=await fetch('/api/demo',{signal:loadController.signal});if(!response.ok)throw new Error();const blob=await response.blob();if(!file.value)await openBlob(blob)}
    catch(e){if(e.name!=='AbortError')error.value='Не удалось загрузить демо. Загрузите своё изображение.'}
  })
  const presetControls=usePresets(settings,{colorMode,foreground,background,paletteIndex},error,notice)
  onBeforeUnmount(()=>{disposed=true;previewWorker?.terminate();loadId++;loadController?.abort();cancelAnimationFrame(frame);resizeObserver?.disconnect();window.removeEventListener('resize',resizePreview);window.removeEventListener('paste',pasteImage);releaseMedia()})
  return {...presetControls,settings,art,fileInput,file,result,stage,busy,error,notice,showOriginal,zoom,format,colorMode,foreground,background,paletteIndex,palettes,charsets,controls,canvasStyle,frameTime,vectorSrc,selectPalette,upload,drop,reset,setZoom,download,copy,detailDraft,updateDetail,commitDetail,isVideo,playing,currentTime,duration,volume,playbackRate,loop,videoFPS,recording,canRecord,togglePlay,seek,timeLabel,fullscreen,startRecording,stopRecording,exportQuality,fileName,videoFormat,videoFormats}
}
