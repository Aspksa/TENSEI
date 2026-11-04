import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcilePhotoCsv,timeSequenceWarnings} from '../lib/transport-reconcile.mjs';
import {normalize,examine} from '../lib/records.mjs';

const photo={tripDate:'2026-11-05',time:'08:20',vehicle:'A905YO',net:27000,tare:14000,gross:41000,reviewed:true};
const trip={date:'2026-11-05',time:'08:20',plate:'А905УО',netKg:27000,product:'Скала'};
test('match is advisory and does not remove or modify either row',()=>{
  const p=[structuredClone(photo)],csv=[structuredClone(trip)];
  const report=reconcilePhotoCsv(p,csv);
  assert.equal(report.counts.matched,1);
  assert.equal(report.rows[0].status,'candidate-match');
  assert.equal(report.verified,false);
  assert.equal(report.complete,true);
  assert.deepEqual(p[0],photo);
  assert.deepEqual(csv[0],trip);
});
test('weight/time/date mismatch and missing dates are separated rather than guessed',()=>{
  const changed=reconcilePhotoCsv([{...photo,net:27001}],[trip]);
  assert.equal(changed.rows[0].status,'weight-mismatch');
  const time=reconcilePhotoCsv([{...photo,time:'09:20'}],[trip]);
  assert.equal(time.rows[0].status,'time-mismatch');
  const unknown=reconcilePhotoCsv([{...photo,tripDate:''}],[trip]);
  assert.equal(unknown.rows[0].status,'needs-review');
  assert.equal(unknown.counts.matched,0);
});
test('duplicate CSV rows are ambiguous, not auto-merged',()=>{
  const output=reconcilePhotoCsv([photo],[trip,{...trip,id:'other'}]);
  assert.equal(output.rows[0].status,'duplicate');
  assert.equal(output.unmatchedCsv.length,2);
  assert.equal(output.complete,false);
});
test('time order warnings require same date and same vehicle',()=>{
  const warnings=timeSequenceWarnings([
    photo,{...photo,time:'08:15'},{...photo,time:'08:15'},
    {...photo,vehicle:'С301СВ',time:'07:00'}]);
  assert.deepEqual(warnings.map(x=>x.type),['out-of-order','same-minute']);
  assert.equal(timeSequenceWarnings([{...photo,tripDate:''},photo]).length,0);
});
test('photo date survives record normalization and invalid date is not silently accepted',()=>{
  assert.equal(normalize(photo).tripDate,'2026-11-05');
  assert.ok(examine([{...photo,tripDate:'bad'}])[0].issues.includes('Некорректная дата рейса'));
});
