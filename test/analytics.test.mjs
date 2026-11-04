import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeTrips,loadLegionStats} from '../lib/analytics.mjs';
import {classifyTrips} from '../lib/legion.mjs';

const rows=[
 {date:'2026-11-01',time:'09:15',plate:'А905УО',product:'Скала',netKg:27240,id:'1',issues:[]},
 {date:'2026-11-01',time:'12:20',plate:'А905УО',product:'Скала',netKg:28000,id:'2',issues:[]},
 {date:'2026-11-02',time:'16:50',plate:'С301СВ',product:'СКАЛА +',netKg:30000,id:'3',issues:[]},
 {date:'2026-10-29',time:'',plate:'С301СВ',product:'Скала',netKg:18000,id:'4',issues:[]}
];
const base=[{plate:'А905УО',model:'FAW',driver:'Иванов'}];
test('analytics reflects exactly four trips and separates Скала vs СКАЛА +',()=>{
  const records=classifyTrips(rows,base);
  const data=analyzeTrips(records);
  assert.equal(data.kpi.trips,4);
  assert.equal(data.kpi.tonnes,103.24);
  assert.equal(data.kpi.vehicles,2);
  assert.equal(data.kpi.products,2);
  assert.equal(data.topVehicles[0].plate,'А905УО');
  assert.equal(data.topVehicles[0].trips,2);
  assert.equal(data.products.find(x=>x.key==='СКАЛА +').tonnes,30);
  assert.equal(data.products.find(x=>x.key==='Скала').tonnes,73.24);
  assert.equal(data.kpi.modelMissing,2);
  assert.equal(data.kpi.timeKnown,3);
  assert.equal(data.anomalies.categories.length>0,true);
  assert.equal(data.vehicleDetails.length,4);
});
test('date filters, grouped month/week, comparison and cached trip display are grounded',()=>{
  const records=classifyTrips(rows,base);
  const data=analyzeTrips(records,{from:'2026-11-01',to:'2026-11-02',
    period:'month',compareFrom:'2026-10-01',compareTo:'2026-10-31'});
  assert.equal(data.kpi.trips,3);
  assert.equal(data.kpi.tonnes,85.24);
  assert.equal(data.trend.length,1);
  assert.equal(data.trend[0].date,'2026-11');
  assert.equal(data.comparison.trips,1);
  assert.equal(data.comparison.tonnes,18);
  const filtered=analyzeTrips(records,{product:'СКАЛА +',period:'week'});
  assert.equal(filtered.kpi.trips,1);
  assert.equal(filtered.kpi.tonnes,30);
  assert.equal(filtered.trend[0].date,'2026-11-02');
  assert.equal(filtered.calendar.length,1);
});
test('empty analytics gives honest zero data without fictitious trends',()=>{
  const data=analyzeTrips([]);
  assert.equal(data.kpi.trips,0);
  assert.deepEqual(data.trend,[]);
  assert.deepEqual(data.products,[]);
  assert.deepEqual(data.topVehicles,[]);
  assert.equal(data.kpi.avgTonnes,0);
});
test('local statistics loader excludes repeated identical CSV imports, preserves repeated real trips',async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'tensei-stat-'));
  try{
    const loc=path.join(root,'legion','imports');
    await fs.mkdir(loc,{recursive:true});
    const id1='11111111-1111-4111-8111-111111111111';
    const id2='22222222-2222-4222-8222-222222222222';
    const entry={rows:rows.slice(0,3),errors:[],contentHash:'same-content-hash'};
    await fs.writeFile(path.join(loc,id1+'.json'),JSON.stringify({...entry,id:id1}));
    await fs.writeFile(path.join(loc,id2+'.json'),JSON.stringify({...entry,id:id2}));
    await fs.writeFile(path.join(root,'legion','imports-index.json'),JSON.stringify([{id:id1},{id:id2}]));
    await fs.writeFile(path.join(root,'legion','vehicles.json'),JSON.stringify(base));
    await fs.mkdir(path.join(root,'scans'),{recursive:true});
    await fs.writeFile(path.join(root,'scans','index.json'),JSON.stringify([
      {id:'a',status:'done'},{id:'b',status:'error'},{id:'c',status:'processing'}
    ]));
    const result=await loadLegionStats(root);
    assert.equal(result.context.files,1);
    assert.equal(result.context.dedupedFiles,1);
    assert.equal(result.context.scannedPhotos,3);
    assert.equal(result.context.photoOk,1);
    assert.equal(result.context.photoErrors,1);
    assert.equal(result.trips.length,3);
    assert.equal(result.trips[0].plate,result.trips[1].plate);
    assert.equal(analyzeTrips(result.trips).kpi.tonnes,85.24);
  }finally{await fs.rm(root,{recursive:true,force:true})}
});
