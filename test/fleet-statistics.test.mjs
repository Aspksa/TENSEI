import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {unifyFleet,fleetFiltered} from '../lib/fleet-statistics.mjs';
import {fleetStatisticsXlsx} from '../lib/fleet-excel.mjs';

const trip=(overrides={})=>({date:'2026-11-05',time:'12:30',plate:'А905УО',
  product:'Скала',netKg:27000,id:'1001',...overrides});
const photo=(overrides={})=>({tripDate:'2026-11-05',time:'12:30',
  vehicle:'A905YO',net:27000,reviewed:true,...overrides});
const upload=(id,rows)=>({id,importedAt:'2026-11-05',rows});
const id1='11111111-1111-1111-1111-111111111111';
const id2='22222222-2222-2222-2222-222222222222';
test('same CSV trip across imports counts once and matching photo never adds tonnage',()=>{
  const raw=[trip()];
  const result=unifyFleet({imports:[upload(id1,raw),upload(id2,raw)],
    photoRows:[photo()],vehicles:[{plate:'А905УО',model:'FAW',driver:'Оператор'}]});
  assert.equal(result.ledger.length,1);
  assert.equal(result.totals.trips,1);
  assert.equal(result.totals.netKg,27000);
  assert.equal(result.totals.matchedPhotos,1);
  assert.equal(result.totals.copyDuplicates,1);
  assert.equal(result.vehicles[0].model,'FAW');
  assert.equal(result.ledger[0].photoEvidence,1);
  assert.deepEqual(raw,[trip()]);
});
test('conflicting CSV at same vehicle/time quarantined, does not inflate totals',()=>{
  const result=unifyFleet({imports:[upload(id1,[trip(),trip({id:'1002',netKg:28000,product:'СКАЛА +'})])]});
  assert.equal(result.totals.trips,0);
  assert.equal(result.totals.excluded,2);
  assert.ok(result.review.every(x=>x.status==='conflict'));
});
test('unknown time CSV stays countable, identical snapshots de-duplicate',()=>{
  const inputs=[trip({time:''})];
  const result=unifyFleet({imports:[upload(id1,inputs),upload(id2,inputs)]});
  assert.equal(result.totals.trips,1);
  assert.equal(result.totals.copyDuplicates,1);
});
test('photos never counted when CSV exists but match is missing or uncertain',()=>{
  const result=unifyFleet({imports:[upload(id1,[trip()])],
    photoRows:[photo({time:'12:31'}),photo({reviewed:false}),photo({tripDate:''})]});
  assert.equal(result.totals.trips,1);
  assert.equal(result.totals.excluded,3);
});
test('without CSV only verified dated photos are counted; repeat excluded',()=>{
  const result=unifyFleet({photoRows:[photo(),photo({net:29000,time:'13:00'}),photo({reviewed:false})]});
  assert.equal(result.totals.trips,2);
  assert.equal(result.totals.tonnes,56);
  const double=unifyFleet({photoRows:[photo(),photo()]});
  assert.equal(double.totals.trips,0);
  assert.equal(double.totals.excluded,2);
});
test('vehicle/product/date filtering preserves totals and trip counts',()=>{
  const fleet=unifyFleet({imports:[upload(id1,[trip(),
    trip({date:'2026-11-06',time:'13:20',plate:'С301СВ',id:'1002',product:'СКАЛА +',netKg:30000})])]});
  const filtered=fleetFiltered(fleet,{product:'СКАЛА +',from:'2026-11-06'});
  assert.equal(filtered.totals.trips,1);
  assert.equal(filtered.totals.netKg,30000);
  assert.deepEqual(filtered.products.map(x=>x.name),['СКАЛА +']);
  assert.equal(filtered.daily[0].trips,1);
  assert.equal(filtered.hours[0].trips,1);
  assert.equal(fleetFiltered(fleet,{vehicle:'А905УО'}).totals.netKg,27000);
});
test('fleet workbook contains vehicle/trips/product/date/audit sheets and right totals',async()=>{
  const fleet=unifyFleet({imports:[upload(id1,[trip()])],photoRows:[photo({reviewed:false})]});
  const bytes=await fleetStatisticsXlsx(fleet,{vehicle:'А905УО'});
  const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);
  for(const sheet of ['Автомобили','Рейсы','Товары','По дням','На проверку','Контроль'])
    assert.ok(book.getWorksheet(sheet),sheet);
  assert.equal(book.getWorksheet('Автомобили').getCell('E2').value,27000);
  assert.equal(book.getWorksheet('Контроль').getCell('B6').value,27000);
  assert.ok(book.getWorksheet('На проверку').rowCount>=2);
});
