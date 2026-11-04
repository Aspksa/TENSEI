import test from 'node:test';
import assert from 'node:assert/strict';
import {exportReadiness,statusLabel} from '../lib/review-policy.mjs';

const row=(overrides={})=>({vehicle:'А123ВС',time:'08:20',tare:15000,gross:42000,net:27000,reviewed:true,...overrides});

test('automatic Excel rejects unreviewed entries and inconsistent weights',()=>{
  const missingReview=exportReadiness([row({reviewed:false})]);
  assert.equal(missingReview.ready,false);
  assert.deepEqual(missingReview.reviewPending,[1]);
  const inconsistent=exportReadiness([row(),row({vehicle:'Б555ВВ',net:36000})]);
  assert.equal(inconsistent.ready,false);
  assert.equal(inconsistent.invalid[0].row,2);
  assert.match(inconsistent.invalid[0].issues.join(' '),/нетто/);
  assert.equal(exportReadiness([row()]).ready,true);
  assert.equal(exportReadiness([]).ready,false);
});

test('photo task labels show real phases and never claim OCR accuracy',()=>{
  assert.match(statusLabel({status:'processing',phase:'OpenCV: локальная сегментация',progress:43}),/43%/);
  assert.match(statusLabel({status:'done',rowCount:18}),/18 строк/);
  assert.match(statusLabel({status:'error',error:'Bad model response'}),/Ошибка/);
  assert.equal(statusLabel({status:'queued'}),'В очереди');
});
