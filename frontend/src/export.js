export const imageFormats=[
  {value:'png',label:'PNG — без потери качества'},
  {value:'jpeg',label:'JPEG — компактное изображение'},
  {value:'webp',label:'WebP — современное изображение'},
  {value:'svg',label:'SVG — вектор'},
  {value:'txt',label:'TXT — текст без цвета'},
  {value:'html',label:'HTML — цветной ASCII'},
]
export function safeFilename(value){
  const base=String(value||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/\.(png|jpe?g|webp|svg|txt|html|webm|mp4)$/i,'').replace(/[.\s]+$/g,'').slice(0,80)
  return !base.trim()||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)?'AmuzASCII':base
}
export function supportedVideoFormats(support){
  const definitions=[{value:'webm-vp9',label:'WebM / VP9',mime:'video/webm;codecs=vp9',extension:'webm'},
    {value:'webm-vp8',label:'WebM / VP8',mime:'video/webm;codecs=vp8',extension:'webm'},
    {value:'webm',label:'WebM',mime:'video/webm',extension:'webm'},
    {value:'mp4',label:'MP4',mime:'video/mp4',extension:'mp4'}]
  return definitions.filter(format=>support(format.mime))
}
export const escapeHtml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))
export function htmlExport(data,colorAt,background,title,language){
  const body=data.lines.map((line,y)=>Array.from(line).map((ch,x)=>`<span style="color:${colorAt(y*data.columns+x)}">${escapeHtml(ch)}</span>`).join('')).join('\n')
  return `<!doctype html><html lang="${language==='en'?'en':'ru'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;padding:24px;background:${background};display:grid;place-items:center;min-height:100vh;box-sizing:border-box}pre{margin:0;font:bold 14px/1 monospace;white-space:pre;tab-size:1}</style></head><body><pre>${body}</pre></body></html>`
}
