import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyDocument,confidenceReport,normalizeMemory,approvedHints,markUnknownVehicles} from '../lib/document-intelligence.mjs';
import {SerialQueue,summarizeUsage} from '../lib/processing-queue.mjs';

test('low confidence cannot silently become reviewed',()=>{
  const rows=[{vehicle:'A123',time:'08:12',tare:10000,gross:40000,net:30000,reviewed:false},
    {vehicle:'',time:'29:90',tare:25000,gross:20000,net:40000,reviewed:false}];
  const report=confidenceReport(rows);
  assert.equal(report[0].requiresReview,false);
  assert.equal(report[1].requiresReview,true);
  assert.ok(report[0].score>report[1].score);
  assert.equal(rows[1].reviewed,false);
  assert.equal(classifyDocument(rows,{columns:['Тара','Брутто']}).type,'weighbridge_journal');
});
test('memory suggestions do not overwrite source records',()=>{
  const mem=normalizeMemory({vehicles:[' а123 ','А123'],drivers:['Иван']});
  const row={vehicle:'А123',driver:'Иван',net:12000};
  assert.equal(approvedHints([row],mem)[0].vehicleKnown,true);
  assert.equal(row.net,12000);
});
test('scheduler continues after failed task and diagnostics avoid fabricated price',async()=>{
  const q=new SerialQueue();const order=[];
  const p1=q.enqueue(async()=>{order.push(1);throw Error('expected')});
  const p2=q.enqueue(async()=>{order.push(2);return 42});
  await assert.rejects(p1,/expected/);
  assert.equal(await p2,42);
  assert.deepEqual(order,[1,2]);
  const s=summarizeUsage([{status:'done',cloudCalls:2,usage:{total_tokens:100}},
    {status:'done',cloudCalls:1},{status:'error',cloudCalls:1}]);
  assert.equal(s.totalReportedTokens,100);
  assert.equal(s.reportedPhotos,1);
  assert.equal(s.estimatedCostRub,null);
});

test('unknown vehicle is flagged only against a nonempty approved registry',()=>{
  const src=[{vehicle:'А123',reviewed:false},{vehicle:'В555',reviewed:false}];
  assert.equal(markUnknownVehicles(src,{vehicles:[]})[1].vehicleUnlisted,false);
  const out=markUnknownVehicles(src,{vehicles:['А123']});
  assert.equal(out[0].vehicleUnlisted,false);
  assert.equal(out[1].vehicleUnlisted,true);
  assert.equal(out[1].reviewed,false);
  assert.equal(src[1].vehicleUnlisted,undefined);
});
