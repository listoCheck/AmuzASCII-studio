// Use visible ink bounds rather than the font's em box: the latter includes
// leading above/below the letters and creates dark horizontal gutters.
const metrics=new Map()
export function inkLayout(ctx,chars,height){
  let bounds=metrics.get(chars)
  if(!bounds){
    ctx.font='bold 100px monospace'
    ctx.textBaseline='alphabetic'
    let ascent=0,descent=0
    for(const ch of Array.from(chars)){
      if(ch===' ')continue
      const m=ctx.measureText(ch)
      ascent=Math.max(ascent,m.actualBoundingBoxAscent||0)
      descent=Math.max(descent,m.actualBoundingBoxDescent||0)
    }
    bounds={ascent:ascent||75,descent};metrics.set(chars,bounds)
  }
  const scale=height/(bounds.ascent+bounds.descent)
  return {font:`bold ${100*scale}px monospace`,baseline:bounds.ascent*scale,size:100*scale}
}
export function brighterInk(color,brightness=120){
  const rgb=color.startsWith('#')?[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)):color.match(/[\d.]+/g).slice(0,3).map(Number)
  const gain=Math.max(0,Math.min(300,Number.isFinite(brightness)?brightness:120))/100
  return `rgb(${rgb.map(v=>Math.min(255,Math.round(v*gain))).join(',')})`
}
