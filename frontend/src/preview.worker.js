import {charsets, paletteLut, convertPixels, cellColor} from './ascii.js'
import {inkLayout,brighterInk} from './typography.js'
import {svgPreview,useFontOutlinePreview} from './svgPreview.js'

// The GPU draws the complete grid in one pass. No per-cell canvas calls or
// hundreds of thousands of strings cross the UI thread on every adjustment.
const surface=new OffscreenCanvas(1,1)
const gl=surface.getContext('webgl2',{alpha:false,antialias:false,depth:false,preserveDrawingBuffer:false})
let program,source=null,sourceVersion=-1,sampleKey='',atlasKey=''
const sample=new OffscreenCanvas(1,1),ctx=sample.getContext('2d')
const glyphTile=new OffscreenCanvas(1,1)
const vectorSurface=new OffscreenCanvas(1,1),vectorSample=new OffscreenCanvas(1,1)
const vectorCtx=vectorSurface.getContext('2d'),vectorSampleCtx=vectorSample.getContext('2d',{willReadFrequently:true})
let vectorSampleKey='',vectorConversionKey='',vectorPixels,vectorData

function prepareVectorData(job){
  const {geo,settings:s}=job
  const key=JSON.stringify([sourceVersion,job.mediaTime,geo.columns,geo.rows,s.rotation,s.mirror])
  if(key!==vectorSampleKey){
    vectorSample.width=geo.columns;vectorSample.height=geo.rows
    vectorSampleCtx.save();vectorSampleCtx.translate(geo.columns/2,geo.rows/2)
    vectorSampleCtx.rotate(s.rotation*Math.PI/180);vectorSampleCtx.scale(s.mirror?-1:1,1)
    vectorSampleCtx.imageSmoothingQuality='high'
    const rotated=s.rotation%180,w=rotated?geo.rows:geo.columns,h=rotated?geo.columns:geo.rows
    vectorSampleCtx.drawImage(source,-w/2,-h/2,w,h);vectorSampleCtx.restore()
    vectorPixels=vectorSampleCtx.getImageData(0,0,geo.columns,geo.rows).data
    vectorSampleKey=key;vectorConversionKey=''
  }
  const conversionKey=JSON.stringify([key,s.charset,s.custom,s.brightness,s.contrast,s.saturation,s.gamma,s.invert])
  if(conversionKey!==vectorConversionKey){vectorData=convertPixels(vectorPixels,geo.columns,geo.rows,s);vectorConversionKey=conversionKey}
}
async function renderSvg(job){
  prepareVectorData(job)
  const {geo,settings:s}=job,count=geo.columns*geo.rows
  const plane=new OffscreenCanvas(geo.columns,geo.rows),c=plane.getContext('2d'),pixels=c.createImageData(geo.columns,geo.rows)
  const tones=paletteLut(job.colors,s.saturation).map(css=>css.match(/\d+/g).map(Number))
  const foreground=[1,3,5].map(i=>parseInt(job.foreground.slice(i,i+2),16)),gain=(s.inkBrightness??120)/100
  for(let n=0;n<count;n++){
    const i=n*4,j=n*3,color=job.colorMode==='mono'?foreground:tones[vectorData.light[n]>>3]
    pixels.data[i]=Math.min(255,Math.round((job.colorMode==='original'?vectorData.rgb[j]:color[0])*gain))
    pixels.data[i+1]=Math.min(255,Math.round((job.colorMode==='original'?vectorData.rgb[j+1]:color[1])*gain))
    pixels.data[i+2]=Math.min(255,Math.round((job.colorMode==='original'?vectorData.rgb[j+2]:color[2])*gain));pixels.data[i+3]=255
  }
  c.putImageData(pixels,0,0)
  const png=new Uint8Array(await (await plane.convertToBlob({type:'image/png'})).arrayBuffer())
  let binary='';for(let i=0;i<png.length;i+=32768)binary+=String.fromCharCode(...png.subarray(i,i+32768))
  const chars=s.charset==='custom'?s.custom:charsets.find(item=>item.id===s.charset)?.chars||charsets[0].chars
  return svgPreview({...vectorData,...geo},inkLayout(c,chars,16),'data:image/png;base64,'+btoa(binary),job.background)
}
function renderFontOutlines(job){
  prepareVectorData(job)
  const {geo,settings:s}=job
  if(vectorSurface.width!==geo.width)vectorSurface.width=geo.width
  if(vectorSurface.height!==geo.height)vectorSurface.height=geo.height
  const c=vectorCtx,cw=geo.width/geo.columns,ch=geo.height/geo.rows
  c.fillStyle=job.background;c.fillRect(0,0,geo.width,geo.height)
  // Canvas asks the font rasterizer for fresh outlines at the final pixel size,
  // just like SVG text. No glyph texture, mipmap or enlarged bitmap is involved.
  const chars=s.charset==='custom'?s.custom:charsets.find(item=>item.id===s.charset)?.chars||charsets[0].chars
  const layout=inkLayout(c,chars,ch)
  c.font=layout.font;c.textAlign='center';c.textBaseline='alphabetic'
  const lut=paletteLut(job.colors,s.saturation)
  let n=0,lastColor=''
  vectorData.lines.forEach((line,y)=>{
    Array.from(line).forEach((symbol,x)=>{
      const color=brighterInk(cellColor(vectorData,n++,job.colorMode,job.foreground,lut),s.inkBrightness)
      if(symbol===' ')return
      if(color!==lastColor){c.fillStyle=color;lastColor=color}
      c.fillText(symbol,(x+.5)*cw,y*ch+layout.baseline,cw)
    })
  })
  return vectorSurface.transferToImageBitmap()
}
function shader(type,code){
  const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s)
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s))
  return s
}
function init(){
  if(!gl)throw new Error('WebGL2 unavailable')
  program=gl.createProgram()
  gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
    void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`))
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
    precision highp float;
    uniform highp sampler2D sourcePixels, corrections, palette;
    uniform highp sampler2DArray glyphs;
    uniform vec2 resolution, grid, pixelFootprint, nativeTile;
    uniform int nativeGlyphs;
    uniform float saturation, rampLength, inkGain;
    uniform int invert, mode;
    uniform vec3 foreground, background;
    out vec4 outputColor;
    float corrected(float v){return texelFetch(corrections,ivec2(int(floor(clamp(v,0.,255.)+.5)),0),0).r*255.;}
    vec3 cellInk(ivec2 cell,out float index){
      vec4 pixel=texelFetch(sourcePixels,cell,0);vec3 rgb=pixel.rgb*pixel.a*255.;
      float l=dot(rgb,vec3(.2126,.7152,.0722));rgb=vec3(l)+(rgb-vec3(l))*saturation;
      rgb=vec3(corrected(rgb.r),corrected(rgb.g),corrected(rgb.b));
      float light=dot(rgb,vec3(.2126,.7152,.0722));
      float level=invert==1?255.-light:light;
      index=min(rampLength-1.,floor(level/256.*rampLength));
      vec3 color=mode==0?foreground:mode==1?rgb/255.:
        texelFetch(palette,ivec2(min(31.,floor(floor(light+.5)/8.)),0),0).rgb;
      return min(vec3(1.),color*inkGain);
    }
    void main(){
      vec2 uv=vec2(gl_FragCoord.x/resolution.x,1.-gl_FragCoord.y/resolution.y);
      vec2 position=uv*grid;ivec2 cell=ivec2(min(floor(position),grid-1.));
      if(nativeGlyphs==1){
        vec3 color=background;
        vec2 pixel=vec2(gl_FragCoord.x-.5,resolution.y-gl_FragCoord.y-.5);
        // Font hinting/antialiasing can touch the neighboring cell. Composite
        // in the same row/column order as native fillText instead of clipping.
        for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
          ivec2 neighbor=cell+ivec2(x,y);
          if(any(lessThan(neighbor,ivec2(0)))||any(greaterThanEqual(neighbor,ivec2(grid))))continue;
          vec2 origin=vec2(neighbor)*resolution/grid;
          vec2 phase=floor(fract(origin)*8.+.5);
          vec2 base=floor(origin)+floor(phase/8.);
          phase=mod(phase,8.);
          vec2 local=pixel-base+1.;
          if(any(lessThan(local,vec2(0.)))||any(greaterThanEqual(local,nativeTile)))continue;
          float index;vec3 ink=cellInk(neighbor,index);
          float mask=texelFetch(glyphs,ivec3(ivec2(phase*nativeTile+local),int(index)),0).a;
          color=mix(color,ink,mask);
        }
        outputColor=vec4(color,1.);
      }else{
        float index;vec3 color=cellInk(cell,index);
        // Independent mip chains integrate subpixel strokes on dense grids.
        float mask=textureGrad(glyphs,vec3(fract(position),index),
          vec2(pixelFootprint.x,0.),vec2(0.,-pixelFootprint.y)).a;
        outputColor=vec4(mix(background,color,mask),1.);
      }
    }`))
  gl.linkProgram(program)
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program))
  gl.useProgram(program)
  for(const [unit,name] of ['sourcePixels','glyphs','corrections','palette'].entries()){
    const target=unit===1?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D
    gl.activeTexture(gl.TEXTURE0+unit);const texture=gl.createTexture();gl.bindTexture(target,texture)
    gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,unit===1?gl.LINEAR_MIPMAP_LINEAR:gl.NEAREST)
    gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,unit===1?gl.LINEAR:gl.NEAREST)
    gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE)
    gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(program,name),unit)
  }
}
function upload(unit,width,height,pixels){
  gl.activeTexture(gl.TEXTURE0+unit)
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
}
function uploadCanvas(unit,canvas){
  gl.activeTexture(gl.TEXTURE0+unit)
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,canvas)
}
function color(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255)}
function uniform(name,method,...values){gl[method](gl.getUniformLocation(program,name),...values)}
self.onmessage=async({data:job})=>{
  let bitmap
  try{
    const start=performance.now()
    if(job.bitmap){source?.close();source=job.bitmap;sourceVersion=job.sourceVersion;sampleKey='';vectorSampleKey='';vectorConversionKey=''}
    if(!source||sourceVersion!==job.sourceVersion)throw new Error('Missing source')
    const {settings:s,geo}=job
    const chars=s.charset==='custom'?s.custom:charsets.find(item=>item.id===s.charset)?.chars||charsets[0].chars
    const ramp=Array.from(chars)
    if(!ramp.length||ramp.some(c=>c.codePointAt(0)<32))throw new Error('Введите хотя бы один печатный символ.')
    if(job.vector){
      const svg=await renderSvg(job)
      self.postMessage({id:job.id,geo,svg,renderer:'svg',elapsed:performance.now()-start})
      return
    }
    if(useFontOutlinePreview(geo,job.playing)){
      bitmap=renderFontOutlines(job)
      self.postMessage({id:job.id,geo,bitmap,renderer:'font-outlines',elapsed:performance.now()-start},[bitmap]);bitmap=null
      return
    }
    if(!program)init()
    const key=[geo.columns,geo.rows,s.rotation,s.mirror,job.mediaTime].join(':')
    if(key!==sampleKey){
      sample.width=geo.columns;sample.height=geo.rows
      ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high'
      ctx.save();ctx.translate(geo.columns/2,geo.rows/2);ctx.rotate(s.rotation*Math.PI/180);ctx.scale(s.mirror?-1:1,1)
      const rotated=s.rotation%180,w=rotated?geo.rows:geo.columns,h=rotated?geo.columns:geo.rows
      ctx.drawImage(source,-w/2,-h/2,w,h);ctx.restore()
      uploadCanvas(0,sample);sampleKey=key
    }
    // Supersample dense grids before downscaling, retaining every selected cell.
    const nativeGlyphs=useFontOutlinePreview(geo,false)
    const scale=nativeGlyphs?1:Math.min(4096/geo.width,4096/geo.height,Math.sqrt(8e6/(geo.width*geo.height)),Math.max(1,geo.columns*2/geo.width))
    const width=Math.max(1,Math.round(geo.width*scale)),height=Math.max(1,Math.round(geo.height*scale))
    if(surface.width!==width)surface.width=width
    if(surface.height!==height)surface.height=height
    // Power-of-two tiles give every layer a complete, independent mip pyramid.
    const tileWidth=Math.ceil(geo.width/geo.columns)+2,tileHeight=Math.ceil(geo.height/geo.rows)+2
    const tw=nativeGlyphs?tileWidth*8:2**Math.ceil(Math.log2(Math.max(32,surface.width/geo.columns)))
    const th=nativeGlyphs?tileHeight*8:2**Math.ceil(Math.log2(Math.max(64,surface.height/geo.rows)))
    const nextAtlas=JSON.stringify([chars,tw,th,nativeGlyphs, nativeGlyphs?geo.width/geo.columns:0,nativeGlyphs?geo.height/geo.rows:0])
    if(nextAtlas!==atlasKey){
      if(ramp.length>gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))throw new Error('Glyph layer limit exceeded')
      glyphTile.width=tw;glyphTile.height=th
      const a=glyphTile.getContext('2d'),layout=inkLayout(a,chars,nativeGlyphs?geo.height/geo.rows:th)
      a.font=layout.font;a.textAlign='center';a.textBaseline='alphabetic';a.fillStyle='#fff'
      gl.activeTexture(gl.TEXTURE1)
      gl.texImage3D(gl.TEXTURE_2D_ARRAY,0,gl.RGBA8,tw,th,ramp.length,0,gl.RGBA,gl.UNSIGNED_BYTE,null)
      ramp.forEach((ch,i)=>{
        a.clearRect(0,0,tw,th)
        if(nativeGlyphs){
          for(let py=0;py<8;py++)for(let px=0;px<8;px++){
            a.save();a.beginPath();a.rect(px*tileWidth,py*tileHeight,tileWidth,tileHeight);a.clip()
            a.fillText(ch,px*tileWidth+1+px/8+geo.width/geo.columns/2,py*tileHeight+1+py/8+layout.baseline,geo.width/geo.columns)
            a.restore()
          }
        }else a.fillText(ch,tw/2,layout.baseline,tw)
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,i,tw,th,1,gl.RGBA,gl.UNSIGNED_BYTE,glyphTile)
      })
      if(!nativeGlyphs)gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
      gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,nativeGlyphs?gl.NEAREST:gl.LINEAR_MIPMAP_LINEAR)
      atlasKey=nextAtlas
    }
    const lut=new Uint8Array(256*4),contrast=s.contrast*2.55,factor=259*(contrast+255)/(255*(259-contrast))
    for(let i=0;i<256;i++){const v=Math.round(255*(Math.max(0,Math.min(255,factor*(i-128)+128+s.brightness*2.55))/255)**(1/s.gamma));lut.set([v,v,v,255],i*4)}
    upload(2,256,1,lut)
    const tones=new Uint8Array(32*4)
    paletteLut(job.colors,s.saturation).forEach((c,i)=>tones.set([...c.match(/\d+/g).map(Number),255],i*4))
    upload(3,32,1,tones)
    gl.viewport(0,0,surface.width,surface.height)
    uniform('nativeGlyphs','uniform1i',nativeGlyphs?1:0);uniform('nativeTile','uniform2f',tileWidth,tileHeight)
    uniform('resolution','uniform2f',surface.width,surface.height);uniform('grid','uniform2f',geo.columns,geo.rows)
    const visibleWidth=Math.min(geo.width,geo.displayWidth||geo.width),visibleHeight=Math.min(geo.height,geo.displayHeight||geo.height)
    // Below two pixels per character, blend toward integrated glyph coverage.
    // Unfiltered vertical stroke patterns cannot be resolved at that density.
    const coverage=Math.max(1,2*geo.columns/visibleWidth)
    uniform('pixelFootprint','uniform2f',coverage*geo.columns/visibleWidth,coverage*geo.rows/visibleHeight)
    uniform('saturation','uniform1f',s.saturation/100);uniform('rampLength','uniform1f',ramp.length)
    uniform('inkGain','uniform1f',(s.inkBrightness??120)/100)
    uniform('invert','uniform1i',s.invert?1:0);uniform('mode','uniform1i',job.colorMode==='mono'?0:job.colorMode==='original'?1:2)
    uniform('foreground','uniform3fv',color(job.foreground));uniform('background','uniform3fv',color(job.background))
    gl.drawArrays(gl.TRIANGLES,0,3)
    if(gl.isContextLost())throw new Error('WebGL context lost')
    bitmap=surface.transferToImageBitmap()
    self.postMessage({id:job.id,geo,bitmap,renderer:'gpu',elapsed:performance.now()-start},[bitmap]);bitmap=null
  }catch(e){if(job.bitmap&&job.bitmap!==source)job.bitmap.close();bitmap?.close();self.postMessage({id:job.id,vector:job.vector,error:e.message})}
}
