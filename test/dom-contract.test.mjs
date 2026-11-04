import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('all required static DOM ids in photo and Legion JS exist in home page',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  const refs=[];
  for(const filename of ['app.js','legion.js']){
    const js=readFileSync(new URL('../'+filename,import.meta.url),'utf8');
    for(const match of js.matchAll(/\$\(['"]([^'"]+)['"]\)/g))refs.push([filename,match[1]]);
  }
  const missing=refs.filter(([,id])=>!ids.has(id));
  assert.deepEqual(missing,[],'A JS reference to missing HTML id silently breaks the UI');
  assert.ok(ids.has('batchStatus'),'batch photo processing indicator is required');
  assert.ok(ids.has('uploadFeedback'),'upload needs visible acknowledgement');
});
test('all static analytics JS ids exist in analytics page',()=>{
  const html=readFileSync(new URL('../analytics.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('../analytics.js',import.meta.url),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  const missing=[...script.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(m=>m[1]).filter(x=>!ids.has(x));
  assert.deepEqual(missing,[]);
});
