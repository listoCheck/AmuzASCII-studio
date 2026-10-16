// Pure conversion functions, shared by the live preview and Node tests.
export const charsets = [
  { id:'classic', name:'Классический ASCII', chars:' .,:;irsXA253hMHGS#9B&@' },
  { id:'blocks', name:'Блоки / ░▒▓█', chars:' ░▒▓█' },
  { id:'matrix', name:'Матрица / 01', chars:' 01' },
  { id:'minimal', name:'Минимал / .:+#', chars:' .:+#' },
  { id:'letters', name:'Типографика / abc', chars:' .itfrnuvczxYUJCLQOZmwqpdbkhao*#MW&8%B@$' },
  { id:'binary', name:'Бинарный / 01#', chars:' .01#' },
  { id:'dots', name:'Точки / ·•●', chars:' ·∙•●' },
  { id:'braille', name:'Брайль / ⠁⠃⣿', chars:' ⠁⠃⠇⠏⠟⠿⡿⣿' },
  { id:'lines', name:'Линии / ─╋', chars:' .─═┼╬╋' },
  { id:'geometry', name:'Геометрия / ◇◆', chars:' ·◦◇○△□◆■●' },
  { id:'digits', name:'Цифры / 0123456789', chars:' .1730254689' },
  { id:'code', name:'Код / {}<>', chars:' .,:;!|/<>+={}#@' },
  { id:'stars', name:'Звёзды / ✧✦★', chars:' .·+✧✦★' },
  { id:'dense', name:'Плотный / MW@', chars:' .`^",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$' },
]

export const palettes = [
  { name:'Фосфор', bg:'#10140f', colors:['#273923','#657943','#a4bd79','#d1e8a0'] },
  { name:'Терминал', bg:'#06110b', colors:['#104e2a','#248e44','#56d16a','#b6ffb0'] },
  { name:'Янтарь', bg:'#170f08', colors:['#643b1e','#b5773d','#e7b967','#ffe0a0'] },
  { name:'Лаванда', bg:'#141120', colors:['#4e3e77','#8170ac','#b1a2d6','#e4d7ff'] },
  { name:'Бумага', bg:'#eee9dc', colors:['#a5a18f','#7c7b69','#515747','#222e24'] },
  { name:'Киберпанк', bg:'#100b21', colors:['#44256c','#a334bd','#f060bf','#62f5ff'] },
  { name:'Океан', bg:'#061420', colors:['#12456d','#148ba5','#52d5ca','#c5fff2'] },
  { name:'Закат', bg:'#201025', colors:['#643365','#b85c79','#f19b75','#ffe4a3'] },
  { name:'Лёд', bg:'#0b1522', colors:['#294869','#638aac','#a9d2eb','#f0fcff'] },
  { name:'Роза', bg:'#200e16', colors:['#603047','#a95273','#eb8eaa','#ffdbde'] },
  { name:'Лава', bg:'#180a07', colors:['#682318','#c3431c','#ff8b25','#ffe68c'] },
  { name:'Сепия', bg:'#211b15', colors:['#554536','#907759','#c3aa7b','#eee1bd'] },
  { name:'Монохром', bg:'#101010', colors:['#444444','#888888','#bbbbbb','#ffffff'] },
  { name:'Индиго', bg:'#0c1026', colors:['#323f87','#636ed0','#a3aaff','#eeedff'] },
  { name:'Мята', bg:'#0a1d19', colors:['#205f50','#419782','#86c9a7','#deffd8'] },
]

export function geometry(columns, width, height, maxDimension=8192, targetWidth=columns*8) {
  const rows=Math.max(1,Math.min(2000,Math.round(columns*height/width*.5)))
  // Use the source aspect ratio, even when rounding the character grid.
  const scale=Math.min(1,maxDimension/targetWidth,maxDimension/(targetWidth*height/width))
  const canvasWidth=Math.max(1,Math.round(targetWidth*scale))
  const canvasHeight=Math.max(1,Math.round(targetWidth*height/width*scale))
  return { columns, rows, width:canvasWidth, height:canvasHeight,
    cellWidth:canvasWidth/columns, cellHeight:canvasHeight/rows }
}

export function previewGeometry(columns, width, height, stageWidth, stageHeight, zoom=1, dpr=1) {
  const availableWidth=Math.max(1,stageWidth-24),availableHeight=Math.max(1,stageHeight-24)
  const fit=Math.min(availableWidth/width,availableHeight/height)*zoom
  const displayWidth=width*fit,displayHeight=height*fit
  const density=Math.max(1,Math.min(3,dpr))
  // Raster density follows the displayed size, never the number of characters.
  // Bound huge zooms without allocating an unbounded high-DPI canvas.
  const pixelScale=Math.min(density,4096/displayWidth,4096/displayHeight,
    Math.sqrt(8_000_000/(displayWidth*displayHeight)))
  const geo=geometry(columns,width,height,4096,displayWidth*pixelScale)
  return {...geo,displayWidth,displayHeight}
}

export function convertPixels(pixels, columns, rows, settings) {
  const ramp=Array.from(settings.charset==='custom'?settings.custom:
    charsets.find(s=>s.id===settings.charset)?.chars || charsets[0].chars)
  if(!ramp.length || ramp.some(c=>c.codePointAt(0)<32))throw new Error('Введите хотя бы один печатный символ.')
  const contrast=settings.contrast*2.55, factor=259*(contrast+255)/(255*(259-contrast))
  const lut=new Uint8Array(256), gamma=1/settings.gamma
  for(let i=0;i<256;i++)lut[i]=Math.round(255*(Math.max(0,Math.min(255,factor*(i-128)+128+settings.brightness*2.55))/255)**gamma)
  const rgb=new Uint8Array(columns*rows*3), light=new Uint8Array(columns*rows), lines=[]
  for(let y=0;y<rows;y++){
    let line=''
    for(let x=0;x<columns;x++){
      const n=y*columns+x,i=n*4,j=n*3,alpha=pixels[i+3]/255
      const r=pixels[i]*alpha,g=pixels[i+1]*alpha,b=pixels[i+2]*alpha
      const l=.2126*r+.7152*g+.0722*b,s=settings.saturation/100
      rgb[j]=lut[Math.round(Math.max(0,Math.min(255,l+(r-l)*s)))];
      rgb[j+1]=lut[Math.round(Math.max(0,Math.min(255,l+(g-l)*s)))];
      rgb[j+2]=lut[Math.round(Math.max(0,Math.min(255,l+(b-l)*s)))];
      const v=.2126*rgb[j]+.7152*rgb[j+1]+.0722*rgb[j+2]
      light[n]=Math.round(v)
      const level=settings.invert?255-v:v
      line+=ramp[Math.min(ramp.length-1,Math.floor(level/256*ramp.length))]
    }
    lines.push(line)
  }
  return {columns,rows,lines,text:lines.join('\n'),rgb,light}
}

export function paletteLut(colors, saturation=100) {
  const channels=colors.map(c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)))
  return Array.from({length:32},(_,i)=>{
    const t=i/31*(channels.length-1),a=Math.floor(t),b=Math.min(channels.length-1,a+1)
    const rgb=channels[a].map((v,j)=>v+(channels[b][j]-v)*(t-a))
    const l=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]
    return `rgb(${rgb.map(v=>Math.round(Math.max(0,Math.min(255,l+(v-l)*saturation/100)))).join(',')})`
  })
}

export function cellColor(data,n,mode,foreground,lut) {
  if(mode==='original')return `rgb(${data.rgb[n*3]},${data.rgb[n*3+1]},${data.rgb[n*3+2]})`
  if(mode==='mono')return foreground
  return lut[Math.min(31,data.light[n]>>3)]
}
