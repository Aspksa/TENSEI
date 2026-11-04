import test from 'node:test';
import assert from 'node:assert/strict';
import {localOcrConsensus,missingRowEvidence,classifyFromLayout,photoBatchMetadata,cellCacheKey,validatedCellEntry} from '../lib/local-intelligence.mjs';

test('spatial OCR comparison never claims truth from two matching models',()=>{
  const a={recognizedCells:[{bbox:[.1,.1,.3,.2],text:'18 700',confidence:.94}]};
  const b={recognizedCells:[{bbox:[.1,.1,.3,.2],text:'18700'}]};
  const result=localOcrConsensus(a,b);
  assert.equal(result.length,1);
  assert.equal(result[0].agree,true);
  assert.equal(result[0].verified,false);
  assert.equal(localOcrConsensus(a,{recognizedCells:[{bbox:[.8,.8,.95,.9],text:'18700'}]})[0].readers,1);
});
test('unmatched rows report evidence but cannot insert fake truck records',()=>{
  const layout={rows:[[0,.1,1,.2],[0,.2,1,.3],[0,.3,1,.4]]};
  const rows=[{vehicle:'A123',bbox:[.1,.11,.5,.18]}];
  const report=missingRowEvidence(rows,layout);
  assert.equal(report.detected,3);
  assert.equal(report.unmatched.length,2);
  assert.equal(rows.length,1);
});
test('document template detection uses observable local headers only',()=>{
  const layout={cells:[[.1,.1,.2,.2],[.3,.1,.4,.2],[.5,.1,.6,.2],[.7,.1,.8,.2]]};
  assert.equal(classifyFromLayout(layout,{lines:[{text:'Тара Брутто Нетто'}]},[{id:'weights'}]).suggestedTemplate,'weights');
  const unknown=classifyFromLayout(layout,{lines:[{text:'hello'}]},[]);
  assert.equal(unknown.suggestedTemplate,null);
  assert.equal(unknown.confirmed,false);
});
test('photo grouping ignores upload date as actual trip date',()=>{
  const a=photoBatchMetadata('page.jpg',[{tripDate:'2026-11-03'}],'2026-11-05');
  assert.equal(a.groupKey,'2026-11-03');
  assert.equal(photoBatchMetadata('page.jpg',[{time:'12:00'}],'2026-11-05').groupKey,'undated');
});
test('cell cache changes with source pixels and only confirmed entries are trusted',()=>{
  const box=[.1,.2,.3,.4];
  assert.notEqual(cellCacheKey(Buffer.from('a'),box,'PP-OCRv6'),cellCacheKey(Buffer.from('b'),box,'PP-OCRv6'));
  assert.equal(validatedCellEntry('15000',{box}),null);
  assert.equal(validatedCellEntry('15000',{box,reviewed:true}).verified,true);
});
