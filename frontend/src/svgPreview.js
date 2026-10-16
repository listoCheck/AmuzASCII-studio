const escape=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))

// SVG text is sharp when letters are resolvable, but its unfiltered subpixel
// strokes alias on dense grids. Keep the area-filtered LIVE frame in that case.
export function canUseVectorPreview(geo){
  const width=geo.displayWidth??geo.width
  const height=geo.displayHeight??geo.height
  return width/geo.columns>=4&&height/geo.rows>=6
}

// Native per-character outlines are excellent for stills and large letters.
// For playing video, thousands of individual text/color calls exceed a frame
// budget; the GPU caches native-size font coverage, including subpixel phases.
export function useFontOutlinePreview(geo,playing=false){
  const count=geo.columns*geo.rows
  return count<=(playing?2000:40000)&&geo.width/geo.columns>=3
}

// One text element per row, rather than one DOM node per colored character.
// Only the colors are a raster image; every glyph edge remains SVG text.
export function svgPreview(data,layout,colorImage,background){
  const width=data.columns*8,height=data.rows*16
  const lines=data.lines.map((line,y)=>`<text x="0" y="${y*16+layout.baseline}" textLength="${width}" lengthAdjust="spacingAndGlyphs" xml:space="preserve" style="white-space:pre">${escape(line)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><mask id="ink" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:alpha"><g fill="white" font-family="monospace" font-weight="bold" font-size="${layout.size}" xml:space="preserve">${lines}</g></mask></defs><rect width="100%" height="100%" fill="${escape(background)}"/><image width="${width}" height="${height}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${colorImage}" mask="url(#ink)"/></svg>`
}
