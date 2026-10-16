import {convertPixels,geometry,palettes,paletteLut,cellColor} from '../src/ascii.js'
import {inkLayout,brighterInk} from '../src/typography.js'
const worker=new Worker(new URL('../src/preview.worker.js',import.meta.url),{type:'module'})
const report=document.querySelector('#report'),messages=[]
let id=0
async function render(job){
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Worker timeout')),15000)
    worker.onmessage=({data})=>{clearTimeout(timeout);data.error?reject(new Error(data.error)):resolve(data)}
    worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message))}
    worker.postMessage({...job,id:++id},job.bitmap?[job.bitmap]:[])
  })
}
try{
  const input=new OffscreenCanvas(4,2),ctx=input.getContext('2d')
  const pixels=new Uint8ClampedArray([12,80,200,255,220,130,20,255,255,255,255,255,0,0,0,255,
    100,40,180,128,180,220,40,255,90,140,230,255,60,30,10,255])
  ctx.putImageData(new ImageData(pixels,4,2),0,0)
  const defaults={columns:4,charset:'custom',custom:' █',brightness:0,contrast:0,saturation:100,gamma:1,invert:false,rotation:0,mirror:false}
  const geo={columns:4,rows:2,width:160,height:160,cellWidth:40,cellHeight:80}
  let first=true
  for(const overrides of [{},{brightness:30},{contrast:40},{gamma:1.8},{saturation:0},{saturation:180},{invert:true}]){
    for(const mode of ['original','palette','mono']){
      const settings={...defaults,...overrides}
      const job={sourceVersion:1,mediaTime:0,geo,settings,colorMode:mode,foreground:'#abcdef',background:'#10140f',colors:palettes[0].colors}
      if(first){job.bitmap=await createImageBitmap(input);first=false}
      const frame=await render(job),out=new OffscreenCanvas(frame.bitmap.width,frame.bitmap.height),o=out.getContext('2d')
      o.drawImage(frame.bitmap,0,0);frame.bitmap.close()
      const data=convertPixels(pixels,4,2,settings),lut=paletteLut(job.colors,settings.saturation)
      for(let n=0;n<8;n++){
        const ch=Array.from(data.lines[Math.floor(n/4)])[n%4]
        const css=ch===' '?job.background:brighterInk(cellColor(data,n,mode,job.foreground,lut))
        const expected=css.startsWith('#')?[1,3,5].map(i=>parseInt(css.slice(i,i+2),16)):css.match(/\d+/g).map(Number)
        const actual=o.getImageData((n%4+.5)*40,(Math.floor(n/4)+.5)*80,1,1).data
        if(expected.some((v,c)=>Math.abs(v-actual[c])>2))throw new Error(`${JSON.stringify(overrides)} ${mode} cell ${n}: ${[...actual]} != ${expected}`)
      }
    }
  }
  messages.push('PASS: 21 font-outline/CPU comparisons — corrections, palette, original color, alpha, inversion and grid orientation.')
  // Large glyphs must match fresh browser font outlines pixel for pixel, both
  // before and after zooming. A blurry enlarged atlas cannot pass this check.
  for(const [width,height] of [[160,160],[480,480]]){
    const settings={...defaults,custom:'M'},fontGeo={...geo,width,height}
    const job={sourceVersion:1,mediaTime:0,geo:fontGeo,settings,colorMode:'mono',foreground:'#ffffff',background:'#000000',colors:palettes[0].colors}
    const frame=await render(job)
    if(frame.renderer!=='font-outlines')throw new Error('Large glyphs used a raster atlas')
    const expected=new OffscreenCanvas(width,height),e=expected.getContext('2d')
    e.fillStyle='#000';e.fillRect(0,0,width,height);e.fillStyle='#fff'
    const layout=inkLayout(e,'M',height/2)
    e.font=layout.font;e.textAlign='center';e.textBaseline='alphabetic'
    for(let y=0;y<2;y++)for(let x=0;x<4;x++)e.fillText('M',(x+.5)*width/4,y*height/2+layout.baseline,width/4)
    const actual=new OffscreenCanvas(width,height),a=actual.getContext('2d');a.drawImage(frame.bitmap,0,0);frame.bitmap.close()
    const aa=a.getImageData(0,0,width,height).data,ee=e.getImageData(0,0,width,height).data
    if(aa.some((v,i)=>v!==ee[i]))throw new Error(`Font outline sharpness changed at ${width}px`)
    for(let y=2;y<height-2;y++){
      let hasInk=false;for(let x=0;x<width;x++)if(aa[(y*width+x)*4]>30){hasInk=true;break}
      if(!hasInk)throw new Error(`Empty gutter at row ${y}`)
    }
  }
  messages.push('PASS: bold font outlines match exactly at normal size and 3× zoom, without empty row gutters.')
  const large=geometry(1000,4,2,4096,2000)
  const frame=await render({sourceVersion:1,mediaTime:0,geo:large,settings:{...defaults,columns:1000},colorMode:'original',foreground:'#fff',background:'#10140f',colors:palettes[0].colors})
  if(frame.geo.columns!==1000||frame.geo.rows!==250)throw new Error('High-detail grid changed')
  frame.bitmap.close();messages.push('PASS: 1000-column grid retained.')
  // A constant field must not grow horizontal bands when glyph strokes are
  // smaller than screen pixels. Exercise fractional grid sizes and resizing.
  const flat=new OffscreenCanvas(16,9),f=flat.getContext('2d');f.fillStyle='#fff';f.fillRect(0,0,16,9)
  for(const columns of [500,750,1000]){
    const dense={...geometry(columns,16,9,4096,1077),displayWidth:1077,displayHeight:606}
    const denseFrame=await render({sourceVersion:columns,bitmap:await createImageBitmap(flat),mediaTime:0,
      geo:dense,settings:{...defaults,columns,custom:'M'},colorMode:'mono',foreground:'#ffffff',background:'#000000',colors:palettes[0].colors})
    const output=new OffscreenCanvas(1077,606),o=output.getContext('2d');o.imageSmoothingQuality='high'
    o.drawImage(denseFrame.bitmap,0,0,1077,606);denseFrame.bitmap.close()
    const rgba=o.getImageData(0,0,1077,606).data,means=[]
    for(let y=8;y<598;y++){
      let sum=0;for(let x=8;x<1069;x++)sum+=rgba[(y*1077+x)*4]
      means.push(sum/1061)
    }
    const range=Math.max(...means)-Math.min(...means)
    if(columns===1000&&range>12)throw new Error(`Horizontal banding: row brightness range ${range.toFixed(2)}`)
    messages.push(`PASS: ${columns} columns, row brightness range ${range.toFixed(2)}`)
    const image=document.createElement('canvas');image.width=1077;image.height=606
    image.getContext('2d').drawImage(output,0,0);image.style.width='520px';document.body.append(image)
  }
  for(const testGeo of [geo,large]){
    let previous=-1
    for(const gain of [0,50,200]){
      const frame=await render({sourceVersion:4000,bitmap:await createImageBitmap(flat),mediaTime:0,geo:testGeo,
        settings:{...defaults,columns:testGeo.columns,custom:'█',inkBrightness:gain},colorMode:'mono',foreground:'#808080',background:'#000000',colors:palettes[0].colors})
      const out=new OffscreenCanvas(frame.bitmap.width,frame.bitmap.height),o=out.getContext('2d');o.drawImage(frame.bitmap,0,0);frame.bitmap.close()
      const value=o.getImageData(Math.floor(out.width/8),Math.floor(out.height/4),1,1).data[0]
      if(value<=previous||gain===0&&value!==0)throw new Error(`Character brightness failed: ${frame.renderer}, ${gain}, ${value}`)
      previous=value
    }
  }
  messages.push('PASS: independent character brightness updates both font outlines and GPU rendering.')
  const svgFrame=await render({sourceVersion:5000,bitmap:await createImageBitmap(flat),vector:true,mediaTime:0,geo,
    settings:{...defaults,custom:'█',inkBrightness:100},colorMode:'mono',foreground:'#80c040',background:'#000000',colors:palettes[0].colors})
  if(svgFrame.renderer!=='svg'||(svgFrame.svg.match(/<text /g)||[]).length!==geo.rows)throw new Error('Vector preview lost SVG text')
  const url=URL.createObjectURL(new Blob([svgFrame.svg],{type:'image/svg+xml'})),image=new Image()
  try{
    image.src=url;await image.decode()
    for(const factor of [1,3]){
      const output=new OffscreenCanvas(geo.width*factor,geo.height*factor),o=output.getContext('2d');o.drawImage(image,0,0,output.width,output.height)
      const rgb=o.getImageData(output.width/8,output.height/4,1,1).data
      if([128,192,64].some((v,i)=>Math.abs(rgb[i]-v)>2))throw new Error(`SVG color mask failed at ${factor}×: ${rgb}`)
    }
  }finally{URL.revokeObjectURL(url)}
  messages.push('PASS: true SVG text preview decodes and preserves colors at 1× and 3× scale.')
  const spaced=new OffscreenCanvas(4,2),sc=spaced.getContext('2d')
  sc.fillStyle='#000';sc.fillRect(0,0,4,2);sc.fillStyle='#fff';sc.fillRect(1,0,1,2);sc.fillRect(3,0,1,2)
  const spacedFrame=await render({sourceVersion:6000,bitmap:await createImageBitmap(spaced),vector:true,mediaTime:0,geo,
    settings:{...defaults,custom:' █',inkBrightness:100},colorMode:'mono',foreground:'#ffffff',background:'#000000',colors:palettes[0].colors})
  const spacedUrl=URL.createObjectURL(new Blob([spacedFrame.svg],{type:'image/svg+xml'})),spacedImage=new Image()
  try{
    spacedImage.src=spacedUrl;await spacedImage.decode()
    const output=new OffscreenCanvas(geo.width,geo.height),o=output.getContext('2d');o.drawImage(spacedImage,0,0)
    for(let x=0;x<4;x++){
      const actual=o.getImageData((x+.5)*40,40,1,1).data[0],expected=x%2?255:0
      if(Math.abs(actual-expected)>2)throw new Error(`SVG whitespace shifted cell ${x}: ${actual} != ${expected}`)
    }
  }finally{URL.revokeObjectURL(spacedUrl)}
  messages.push('PASS: SVG preserves leading spaces and exact character column positions.')
  report.textContent=messages.join('\n')
}catch(e){report.textContent=messages.join('\n')+'\nFAIL: '+e.message}
finally{worker.terminate()}
