import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {qualityReport,improvePhoto,cropBox,rowBands,validBox,fixBox,fallbackBands} from '../lib/vision.mjs';
import {normalizePaddle,compareRowsWithChandra} from '../lib/optional-ocr.mjs';
import {BUILTIN_TEMPLATES,templateFields,createTemplate,templatePrompt} from '../lib/templates.mjs';

test('quality check reports photo resolution and warns on tiny images',async()=>{
  const img=await sharp({create:{width:600,height:400,channels:3,background:'#eeeeee'}}).png().toBuffer();
  const q=await qualityReport(img);
  assert.equal(q.width,600);
  assert.ok(q.warnings.some(x=>x.includes('разрешение')));
  const processed=await improvePhoto('data:image/png;base64,'+img.toString('base64'));
  assert.match(processed.image,/^data:image\/jpeg;base64,/);
  assert.ok(processed.report.warnings.length);
});
test('normalized crop and fixed bands produce real JPEG',async()=>{
  const buffer=await sharp({create:{width:300,height:500,channels:3,background:'#dddddd'}}).jpeg().toBuffer();
  const image='data:image/jpeg;base64,'+buffer.toString('base64');
  const cropped=await cropBox(image,[0,.25,1,.65]);
  const meta=await sharp(Buffer.from(cropped.split(',')[1],'base64')).metadata();
  assert.ok(meta.height>0);
  assert.equal(meta.format,'jpeg');
  assert.equal(fallbackBands().length,2);
  assert.ok(validBox(fixBox([0,0,1,1])));
  assert.equal(fixBox([2,1,3,4]),null);
});
test('PaddleOCR table cell boxes convert to relative coordinates',()=>{
  const result=normalizePaddle({table_res_list:[{cell_box_list:[
    [0,0,200,100],[200,0,400,100],[0,100,200,200],[200,100,400,200]
  ]}]},400,200);
  assert.equal(result.cells.length,4);
  assert.deepEqual(result.cells[0],[0,0,.5,.5]);
  assert.ok(result.rows.length>=2);
  const sidecar=normalizePaddle({cells:[[0,0,.4,.5],[.4,0,.8,.5]],row_boxes:[[0,0,1,.5]]},400,200);
  assert.equal(sidecar.cells.length,2);
  assert.equal(sidecar.rows.length,1);
});
test('Chandra disagreements are advisory and do not silently replace values',()=>{
  const res=compareRowsWithChandra([{tare:10000,gross:45000,net:35000}],'10000 45000 33000');
  assert.equal(res.checked,true);
  assert.equal(res.differences[0].field,'net');
  assert.equal(res.differences[0].value,'35000');
});
test('template validation and prompts are safe',()=>{
  assert.ok(BUILTIN_TEMPLATES.length>=2);
  assert.equal(templateFields('Тара, Брутто, Нетто').length,3);
  assert.throws(()=>templateFields('Тара,Тара'),/разные/);
  assert.throws(()=>createTemplate({name:'a',columns:'x,y'}),/Название/);
  const t=createTemplate({name:'Весовая 1',columns:'Время, Тара, Брутто, Нетто'});
  assert.ok(t.id.startsWith('user-'));
  assert.match(templatePrompt(t),/Тара/);
});
