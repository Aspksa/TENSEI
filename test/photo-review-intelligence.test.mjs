import test from 'node:test';
import assert from 'node:assert/strict';
import {handwritingCandidates,plateCandidates,findCrossSourceDuplicates,
  detectUnruledColumns,detectEditMarks,reconcileRows,reviewPriority,tentativeCellsFromInk} from '../lib/photo-review-intelligence.mjs';

test('local handwritten numbers are candidates and never verified weights',()=>{
  const c=handwritingCandidates([{bbox:[.1,.2,.3,.4],text:'12345',score:.89},
    {bbox:[.2,.4,.3,.5],text:'12B45'},{bbox:[.9,.9,.1,.1],text:'50000'}]);
  assert.equal(c.length,2);
  assert.equal(c[0].integer,12345);
  assert.equal(c[0].verified,false);
  assert.equal(c[1].integer,null);
});
test('license plates normalize only; no unapproved invented substitutions',()=>{
  const ok=plateCandidates('A 905 YO 125',['А905УО']);
  assert.equal(ok.normalized,'А905УО');
  assert.equal(ok.known,true);
  assert.equal(ok.verified,false);
  const other=plateCandidates('H508KO',['А905УО']);
  assert.equal(other.known,false);
  assert.deepEqual(other.suggestions,[]);
});
test('observed columns need repeated positioned text evidence',()=>{
  const lines=Array.from({length:4},(_,i)=>[
    {text:'Тара',bbox:[.1,.1+i*.15,.2,.2+i*.15]},
    {text:'32000',bbox:[.7,.1+i*.15,.85,.2+i*.15]}
  ]).flat();
  const found=detectUnruledColumns(lines);
  assert.equal(found.columns.length,2);
  assert.equal(found.verified,false);
  assert.equal(detectUnruledColumns([{text:'x'}]).columns.length,0);
});
test('correction text hints and row gaps remain advisory',()=>{
  const corrections=detectEditMarks([{text:'исправлено',bbox:[0,.1,.2,.2]}]);
  assert.equal(corrections.length,1);
  assert.equal(corrections[0].verified,false);
  const coverage=reconcileRows([{bbox:[0,.1,1,.2]}],[[0,.1,1,.2],[0,.3,1,.4]]);
  assert.equal(coverage.unmatchedBands.length,1);
});
test('review priorities highlight arithmetic and possible duplicates without auto edits',()=>{
  const row={vehicle:'А123ВС',tare:20000,gross:50000,net:32000,uncertain:false};
  const review=reviewPriority(row,{vehicleKnown:false,duplicate:true});
  assert.equal(review.needsReview,true);
  assert.ok(review.issues.some(x=>x.includes('≠')));
  assert.equal(row.net,32000);
});
test('cross-source suspected duplicate must include matching date and values',()=>{
  const prior=[{tripDate:'2026-11-05',time:'10:20',vehicle:'А123ВС',net:25000,reviewed:true}];
  const same=[{...prior[0],source:'other'}],different=[{...prior[0],net:25001}];
  assert.equal(findCrossSourceDuplicates(same,prior).length,1);
  assert.equal(findCrossSourceDuplicates(different,prior).length,0);
  assert.equal(findCrossSourceDuplicates([{...prior[0],tripDate:''}],prior).length,0);
});

test('tentative unruled cells require observed axes and are never verified',()=>{
  const columns={columns:[{center:.2,observations:5},{center:.7,observations:5}]};
  const result=tentativeCellsFromInk([[0,.1,1,.2],[0,.3,1,.4]],columns);
  assert.equal(result.boxes.length,4);
  assert.equal(result.verified,false);
  assert.equal(tentativeCellsFromInk([[0,.1,1,.2]],columns).boxes.length,0);
});
