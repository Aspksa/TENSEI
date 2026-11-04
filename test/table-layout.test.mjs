import test from 'node:test';
import assert from 'node:assert/strict';
import {alignRowsByGeometry,completeRecoveryBands} from '../lib/table-layout.mjs';
import {normalizePaddle} from '../lib/optional-ocr.mjs';

test('spatial alignment never attaches grid rows by row index alone',()=>{
  const grid=[[0,.1,1,.2],[0,.2,1,.35],[0,.35,1,.5]];
  const without=[{vehicle:'A',bbox:null},{vehicle:'B',bbox:null},{vehicle:'C',bbox:null}];
  assert.deepEqual(alignRowsByGeometry(without,grid),without);
  const valid=[{vehicle:'A',bbox:[.2,.23,.7,.31],reviewed:false}];
  const matched=alignRowsByGeometry(valid,grid);
  assert.deepEqual(matched[0].bbox,grid[1]);
  assert.equal(matched[0].reviewed,false);
  const mismatch=[{vehicle:'Z',bbox:[.2,.8,.7,.9]}];
  assert.deepEqual(alignRowsByGeometry(mismatch,grid),mismatch);
});
test('all grid rows remain included in at most four recovery regions',()=>{
  const rows=Array.from({length:24},(_,i)=>[0,(i+1)/26,1,(i+2)/26]);
  const bands=completeRecoveryBands(rows);
  assert.equal(bands.length,4);
  for(const row of rows){
    const cy=(row[1]+row[3])/2;
    assert.ok(bands.some(b=>cy>=b[1]&&cy<=b[3]),'row was skipped: '+cy);
  }
});
test('normalizePaddle preserves row, column and cell positions',()=>{
  const layout=normalizePaddle({engine:'OpenCV grid',method:'opencv-ruling',
    confidence:.86,cells:[[.1,.1,.4,.3],[.4,.1,.9,.3]],
    row_boxes:[[0,.1,1,.3]],column_boxes:[[.1,0,.4,1],[.4,0,.9,1]]},1200,1600);
  assert.equal(layout.available,true);
  assert.equal(layout.cells.length,2);
  assert.equal(layout.rows.length,1);
  assert.equal(layout.columns.length,2);
  assert.equal(layout.confidence,.86);
  assert.equal(layout.method,'opencv-ruling');
});
test('bad geometry is ignored rather than silently positioned',()=>{
  const layout=normalizePaddle({cells:[[-1,0,1,1],[.2,.2,.2,.8]],row_boxes:[[0,0,0,0]]},1200,1600);
  assert.equal(layout.cells.length,1); // clamped first box remains valid
  assert.equal(layout.rows.length,0);
});
