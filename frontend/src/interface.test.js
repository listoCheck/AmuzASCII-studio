import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {t,translate,messages} from './i18n.js'
import {preferences,sanitizePreferences,accentText,themes} from './preferences.js'
import {imageFormats,safeFilename,videoFormats,htmlExport} from './export.js'
import {charsets,palettes} from './ascii.js'
import {builtinPresets} from './presets.js'

test('all interface translations and built-in names have English entries',()=>{
  for(const file of ['App.vue','AppearancePanel.vue']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8')
    for(const match of source.matchAll(/\bt\('([^']+)'/g))assert.ok(messages.en[match[1]],`${file}: ${match[1]}`)
  }
  for(const item of [...charsets,...palettes,...themes,...builtinPresets])assert.ok(messages.en[item.name],item.name)
  for(const format of imageFormats)assert.ok(messages.en[format.label],format.label)
  for(const file of ['useEditor.js','usePresets.js','ascii.js','presets.js']){
    const source=readFileSync(new URL(file,import.meta.url),'utf8')
    for(const match of source.matchAll(/(?:new Error\(|error.value=|notice.value=)'([^']+)'/g)){
      if(/[А-Яа-яЁё]/.test(match[1]))assert.ok(messages.en[match[1]],`${file}: ${match[1]}`)
    }
  }
})
test('translation interpolation preserves user-supplied names and Russian fallback',()=>{
  assert.equal(translate('en','Подключён набор «{name}».',{name:'Мой style'}),'Preset “Мой style” applied.')
  assert.equal(translate('ru','Детализация'),'Детализация')
  assert.equal(translate('en','Детализация'),'Detail')
  const message={key:'Подключён набор «{name}».',params:{name:'Последний сеанс'},localizeName:true}
  preferences.locale='en';assert.equal(t(message),'Preset “Last session” applied.')
  preferences.locale='ru';assert.equal(t(message),'Подключён набор «Последний сеанс».')
})
test('personalization rejects invalid theme, color, locale and out-of-range sizes',()=>{
  const p=sanitizePreferences({locale:'x',theme:'script',accent:'red',panelWidth:999,fontScale:NaN,radius:-1,exportQuality:999})
  assert.equal(p.locale,'ru');assert.equal(p.theme,'paper');assert.equal(p.accent,'#62734a')
  assert.equal(p.panelWidth,440);assert.equal(p.fontScale,100);assert.equal(p.radius,0);assert.equal(p.exportQuality,100)
  assert.equal(sanitizePreferences(null).theme,'paper')
  assert.equal(accentText('#ffffff'),'#152019');assert.equal(accentText('#000000'),'#ffffff')
})
test('file names cannot escape directories or use reserved Windows names',()=>{
  assert.equal(safeFilename('../my:art.png'),'.._my_art')
  assert.equal(safeFilename('CON.txt'),'AmuzASCII')
  assert.equal(safeFilename('  '),'AmuzASCII')
  assert.equal(safeFilename('Картинка.webp'),'Картинка')
})
test('backend video formats work without browser recorders and migrate saved choices',()=>{
  assert.deepEqual(videoFormats.map(format=>format.value),['mp4','webm'])
  assert.equal(sanitizePreferences({videoFormat:'webm-vp9'}).videoFormat,'webm')
  assert.equal(sanitizePreferences({videoFormat:'webm-vp8'}).videoFormat,'webm')
  assert.equal(sanitizePreferences({videoFormat:'invalid'}).videoFormat,'mp4')
})
test('colored HTML export escapes characters and title and declares its language',()=>{
  const html=htmlExport({columns:3,lines:['<&>']},()=>'#aabbcc','#001122','<script>','en')
  assert.ok(html.includes('lang="en"'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&amp;'));assert.ok(html.includes('color:#aabbcc'));assert.ok(html.includes('background:#001122'))
})
import {svgPreview,canUseVectorPreview} from './svgPreview.js'

test('dense LIVE previews are not replaced by aliased SVG text after slider release',()=>{
  const dense={columns:1000,rows:500,width:1077,height:1077,displayWidth:1077,displayHeight:1077}
  assert.equal(canUseVectorPreview(dense),false)
  assert.equal(canUseVectorPreview({...dense,width:4308,height:4308,displayWidth:4308,displayHeight:4308}),true)
  assert.equal(canUseVectorPreview({...dense,width:4308,height:4308}),false)
  assert.equal(canUseVectorPreview({...dense,width:2200,height:2200,displayWidth:4308,displayHeight:4308}),true)
  assert.equal(canUseVectorPreview({columns:40,rows:24,width:400,height:480,displayWidth:400,displayHeight:480}),true)
})
import {clipboardImage} from './clipboard.js'

test('clipboard extracts image files, ignores text/HTML and supports file-only clipboard data',()=>{
  const image={name:'capture.png',type:'image/png'}
  assert.equal(clipboardImage({items:[{kind:'string',type:'text/html'},{kind:'file',type:'image/png',getAsFile:()=>image}]}),image)
  assert.equal(clipboardImage({items:[{kind:'file',type:'image/png',getAsFile:()=>null}],files:[image]}),image)
  assert.equal(clipboardImage({files:[{type:'text/plain'},image]}),image)
  assert.equal(clipboardImage({items:[{kind:'string',type:'text/plain'}]}),null)
  assert.equal(clipboardImage(null),null)
})

test('SVG preview keeps text contours, escapes custom symbols and uses one element per row',()=>{
  const svg=svgPreview({columns:3,rows:2,width:300,height:400,lines:['<& ','M@#']},{size:18,baseline:13},'data:image/png;base64,AA==','#123456')
  assert.equal((svg.match(/<text /g)||[]).length,2)
  assert.ok(svg.includes('&lt;&amp; '))
  assert.ok(svg.includes('textLength="24"'))
  assert.ok(svg.includes('viewBox="0 0 24 32"'))
  assert.ok(svg.includes('font-weight="bold"'))
  assert.ok(svg.includes('mask="url(#ink)"'))
})
