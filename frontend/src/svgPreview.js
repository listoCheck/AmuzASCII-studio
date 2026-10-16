const escape=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]))

// One text element per row, rather than one DOM node per colored character.
// Only the colors are a raster image; every glyph edge remains SVG text.
export function svgPreview(data,layout,colorImage,background){
  const width=data.columns*8,height=data.rows*16
  const lines=data.lines.map((line,y)=>`<text x="0" y="${y*16+layout.baseline}" textLength="${width}" lengthAdjust="spacingAndGlyphs" xml:space="preserve" style="white-space:pre">${escape(line)}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><defs><mask id="ink" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:alpha"><g fill="white" font-family="monospace" font-weight="bold" font-size="${layout.size}" xml:space="preserve">${lines}</g></mask></defs><rect width="100%" height="100%" fill="${escape(background)}"/><image width="${width}" height="${height}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${colorImage}" mask="url(#ink)"/></svg>`
}
