import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_MODEL,MODELS,weight,normalize,parseModel,examine,safeRows} from '../lib/records.mjs';

test('основная модель назначена заранее',()=>{
  assert.equal(DEFAULT_MODEL,'qwen/qwen3-vl-235b-a22b-instruct');
  assert.equal(MODELS.length,5);
});
test('обработка пустых и числовых значений',()=>{
  assert.equal(weight(null),null);
  assert.equal(weight(''),null);
  assert.equal(weight('33 400'),33400);
  assert.equal(weight('33,400'),33400);
  assert.equal(weight('33400'),33400);
  assert.equal(weight('abc'),null);
});
test('нетто рассчитывается при наличии тары и брутто',()=>{
  const r=normalize({gross:48250,tare:17650,vehicle:' м046хт '});
  assert.equal(r.net,30600);
  assert.equal(r.vehicle,'М046ХТ');
});
test('повторяющиеся рейсы не удаляются',()=>{
  const rows=parseModel(JSON.stringify({rows:[{vehicle:'A',time:'08:01',net:28000},{vehicle:'A',time:'09:01',net:29000}]}));
  assert.equal(rows.length,2);
  assert.equal(examine(rows).filter(x=>x.issues.some(i=>i.includes('дубль'))).length,0);
});
test('точно идентичные строки лишь помечаются, но сохраняются',()=>{
  const rows=examine([{vehicle:'A',time:'08:01',net:28000},{vehicle:'A',time:'08:01',net:28000}]);
  assert.equal(rows.length,2);
  assert.match(rows[1].issues.join(' '),/дубль/i);
});
test('арифметическая аномалия распознаётся',()=>{
  const rows=examine([{vehicle:'A',time:'08:01',tare:10000,gross:44000,net:33000}]);
  assert.match(rows[0].issues.join(' '),/не совпадает/i);
});
test('подозрительно большой и нулевой вес отмечается',()=>{
  assert.match(examine([{vehicle:'A',net:46000}])[0].issues.join(' '),/45 тонн/);
  assert.match(examine([{vehicle:'A',net:0}])[0].issues.join(' '),/Нулевой вес/);
});
test('неправильное время и отсутствующее ТС',()=>{
  const issues=examine([{time:'25:90',net:1000}])[0].issues.join('; ');
  assert.match(issues,/время/i);
  assert.match(issues,/ТС/i);
});
test('разбор ответа в кодовом блоке',()=>{
  const rows=parseModel(''+'\x60\x60\x60json\n{"rows":[{"vehicle":"M123"}]}\n\x60\x60\x60');
  assert.equal(rows[0].vehicle,'M123');
});
test('поломанные или чрезмерные ответы отвергаются',()=>{
  assert.throws(()=>parseModel('not a table'));
  assert.throws(()=>parseModel(JSON.stringify({rows:new Array(401).fill({})})),/много/);
  assert.throws(()=>safeRows({rows:[]}),/количество/);
  assert.throws(()=>safeRows(new Array(2501).fill({})),/количество/);
});

test('модель не может сама подтвердить сверку с фото',()=>{
  const row=parseModel('{"rows":[{"vehicle":"A123","reviewed":true,"net":24000}]}')[0];
  assert.equal(row.reviewed,false);
  const manuallyReviewed=examine([{vehicle:'A123',net:24000,uncertain:true,reviewed:true}])[0];
  assert.equal(manuallyReviewed.issues.length,0);
});

test('manual product is retained when photo records are saved or read from Cloud response',()=>{
  const result=safeRows([{tripDate:'2026-11-05',time:'09:30',
    vehicle:'A123BC',net:27000,product:'СКАЛА +',reviewed:true}]);
  assert.equal(result[0].product,'СКАЛА +');
  assert.equal(normalize(result[0]).product,'СКАЛА +');
  const parsed=parseModel('{"rows":[{"vehicle":"A123BC","net":27000,"product":"Скала","reviewed":true}]}');
  assert.equal(parsed[0].product,'Скала');
  assert.equal(parsed[0].reviewed,false);
});
test('same vehicle/time/weight on distinct calendar days is not a duplicate',()=>{
  const rows=examine([
    {tripDate:'2026-11-04',time:'09:30',vehicle:'А123ВС',net:27000},
    {tripDate:'2026-11-05',time:'09:30',vehicle:'А123ВС',net:27000}
  ]);
  assert.ok(rows.every(x=>!x.issues.some(i=>i.includes('дубль'))));
});
