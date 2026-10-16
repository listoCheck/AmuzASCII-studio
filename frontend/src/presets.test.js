import test from 'node:test'
import assert from 'node:assert/strict'
import {builtinPresets,validatePreset,normalizeColumns} from './presets.js'
import {brighterInk} from './typography.js'

test('character brightness survives presets and older presets keep their previous brightness',()=>{
  const preset=structuredClone(builtinPresets[0]);preset.settings.inkBrightness=230
  assert.equal(validatePreset(JSON.parse(JSON.stringify(preset))).settings.inkBrightness,230)
  delete preset.settings.inkBrightness
  assert.equal(validatePreset(preset).settings.inkBrightness,120)
  for(const value of [-1,301,'120',NaN])assert.throws(()=>validatePreset({...preset,settings:{...preset.settings,inkBrightness:value}}))
  assert.equal(brighterInk('#804020',0),'rgb(0,0,0)')
  assert.equal(brighterInk('#804020',100),'rgb(128,64,32)')
  assert.equal(brighterInk('#804020',200),'rgb(255,128,64)')
})

test('keyboard detail rounds, bounds and tolerates incomplete input',()=>{
  assert.equal(normalizeColumns('512'),512)
  assert.equal(normalizeColumns('1001'),1000)
  assert.equal(normalizeColumns('1'),40)
  assert.equal(normalizeColumns(''),80)
  assert.equal(normalizeColumns('wrong',240),240)
  assert.equal(normalizeColumns('512.6'),513)
})
test('all bundled corrections survive JSON save/load without losing colors or symbols',()=>{
  for(const preset of builtinPresets)assert.deepEqual(validatePreset(JSON.parse(JSON.stringify(preset))),preset)
})
test('import rejects unsupported versions, invalid numeric fields, colors and symbols',()=>{
  for(const mutate of [p=>p.version=99,p=>p.settings.columns=1001,p=>p.settings.gamma=0,
    p=>p.settings.custom='\n',p=>p.settings.rotation=5,p=>p.appearance.paletteIndex=999,
    p=>p.appearance.foreground='url(https://example.com)',p=>p.settings.brightness='50']){
    const copy=structuredClone(builtinPresets[0]);mutate(copy)
    assert.throws(()=>validatePreset(copy))
  }
})
test('import keeps only supported fields and does not execute arbitrary data',()=>{
  const preset=structuredClone(builtinPresets[0]);preset.script='alert(1)';preset.settings.other='anything'
  const clean=validatePreset(preset)
  assert.equal(clean.script,undefined)
  assert.equal(clean.settings.other,undefined)
})
