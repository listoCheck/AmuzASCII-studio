import test from 'node:test'
import assert from 'node:assert/strict'
import {geometry,previewGeometry,convertPixels,paletteLut,charsets,palettes,cellColor} from './ascii.js'

const defaults={charset:'custom',custom:' .#',brightness:0,contrast:0,saturation:100,gamma:1,invert:false}
test('canvas preserves portrait, landscape and extreme source aspect ratios',()=>{
  for(const [w,h] of [[100,200],[200,100],[1920,1080],[999,1500],[40,4000]]){
    const g=geometry(160,w,h)
    // Integer canvas dimensions introduce at most sub-percent rounding at 1:100.
    assert.ok(Math.abs((g.height/g.width)/(h/w)-1)<.01)
    assert.equal(g.width/g.columns,g.cellWidth)
    assert.equal(g.height/g.rows,g.cellHeight)
    assert.ok(g.width<=8192&&g.height<=8192)
  }
})
test('brightness, contrast, gamma, saturation and inversion affect pixels or symbols',()=>{
  const pixels=new Uint8ClampedArray([90,30,180,255,220,210,230,255])
  const base=convertPixels(pixels,2,1,defaults)
  for(const override of [{brightness:50},{contrast:80},{gamma:2},{saturation:0}]){
    assert.notDeepEqual(convertPixels(pixels,2,1,{...defaults,...override}).rgb,base.rgb)
  }
  assert.notEqual(convertPixels(pixels,2,1,{...defaults,invert:true}).text,base.text)
})
test('preview and export retain the same character grid and source proportions',()=>{
  const preview=geometry(300,400,1200,2048), exported=geometry(300,400,1200,8192)
  assert.equal(preview.columns,exported.columns)
  assert.equal(preview.rows,exported.rows)
  assert.ok(preview.height<=2048)
  assert.equal(exported.width,2400)
  assert.equal(exported.height,7200)
  assert.ok(Math.abs(preview.width/preview.height-1/3)<.001)
})
test('all character presets produce valid dimensions and an allowed symbol',()=>{
  for(const charset of charsets){
    const result=convertPixels(new Uint8ClampedArray([255,255,255,255]),1,1,{...defaults,charset:charset.id})
    assert.equal(Array.from(result.text).length,1)
    assert.ok(Array.from(charset.chars).includes(result.text))
  }
})
test('transparent source pixels composite against black without becoming white',()=>{
  const result=convertPixels(new Uint8ClampedArray([255,255,255,0]),1,1,defaults)
  assert.equal(result.text,' ')
  assert.deepEqual([...result.rgb],[0,0,0])
})
test('color modes and gradients select their actual visible colors',()=>{
  const data={rgb:new Uint8Array([12,34,56]),light:new Uint8Array([255])}
  for(const palette of palettes){
    const lut=paletteLut(palette.colors)
    assert.equal(lut.length,32)
    assert.equal(cellColor(data,0,'palette','#123456',lut),lut[31])
  }
  assert.equal(cellColor(data,0,'mono','#123456',[]),'#123456')
  assert.equal(cellColor(data,0,'original','#123456',[]),'rgb(12,34,56)')
})
test('invalid custom ramps fail without generating stale output',()=>{
  for(const custom of ['', '\n'])assert.throws(()=>convertPixels(new Uint8ClampedArray(4),1,1,{...defaults,custom}))
})

test('40 columns render at native display density rather than a 320px bitmap',()=>{
  const low=previewGeometry(40,1600,900,1400,900,1,2)
  const high=previewGeometry(500,1600,900,1400,900,1,2)
  assert.equal(low.width,high.width)
  assert.equal(low.height,high.height)
  assert.ok(Math.abs(low.width/low.displayWidth-2)<.01)
  assert.ok(low.width>2000)
  assert.ok(low.cellWidth>high.cellWidth)
})

test('preview fits laptop through desktop workspaces and preserves portrait/landscape ratios',()=>{
  for(const [stageWidth,stageHeight] of [[700,580],[980,680],[1380,880],[2080,1210],[3000,1800]]){
    for(const [w,h] of [[1600,900],[900,1600],[1000,1000]]){
      for(const dpr of [1,1.25,1.5,2]){
        const p=previewGeometry(40,w,h,stageWidth,stageHeight,1,dpr)
        assert.ok(p.displayWidth<=stageWidth-24+.001)
        assert.ok(p.displayHeight<=stageHeight-24+.001)
        assert.ok(Math.abs(p.displayWidth/p.displayHeight-w/h)<.001)
        assert.ok(p.width*p.height<=8_010_000)
        assert.ok(p.width<=4096&&p.height<=4096)
      }
    }
  }
})

test('zoom redraws a sharper backing raster and 1000 columns retain 1000 characters',()=>{
  const normal=previewGeometry(40,1600,900,800,600,1,1)
  const zoomed=previewGeometry(40,1600,900,800,600,2,1)
  assert.ok(zoomed.width>normal.width)
  const p=previewGeometry(1000,1600,900,800,600)
  const pixels=new Uint8ClampedArray(p.columns*p.rows*4).fill(255)
  const result=convertPixels(pixels,p.columns,p.rows,defaults)
  assert.equal(result.columns,1000)
  assert.ok(result.lines.every(line=>line.length===1000))
  const exported=geometry(40,1600,900,8192,1600)
  assert.equal(exported.width,1600)
  assert.equal(exported.height,900)
})

test('high-detail portraits retain vertical detail beyond the old 500-row limit',()=>{
  assert.equal(geometry(1000,900,1600).rows,889)
  assert.equal(geometry(1000,400,1200).rows,1500)
  assert.equal(geometry(1000,100,10000).rows,2000)
})
