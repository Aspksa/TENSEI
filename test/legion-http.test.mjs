import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir,stat,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sampleBase64='uTvE4PLgIO707vDs6+Xt6P870tE70u7i4PA7zeXy8u470uDw4DvB8PPy8u4KMTswMS4xMS4yMDI2IDEyOjAwO+A5MDXz7jvR6uDr4DsyNzI0MDsxMjAwMDszOTI0MAoyOzAxLjExLjIwMjYgMTI6MzA74DkwNfPuO9Hq4OvgOzI4MDAwOzEyMDAwOzQwMDAwCjM7MDEuMTEuMjAyNiAxMzowMDvxMzAx8eI70crAy8AgKzszMDAwMDsxMjAwMDs0MjAwMAo=';
const post=async(base,route,data)=>{
  const r=await fetch(base+'/api/legion/'+route,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  return {status:r.status,body:await r.json()};
};
async function serverStart(){
  const dir=await mkdtemp(path.join(tmpdir(),'tensei-legion-'));
  const out=path.join(dir,'output');
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,
    env:{...process.env,TENSEI_DATA_DIR:path.join(dir,'data'),TENSEI_REPORTS_DIR:out,
      TENSEI_NO_BROWSER:'1',PORT:'0'},stdio:['ignore','pipe','pipe']});
  let buffer='',error='';
  child.stderr.on('data',x=>error+=x.toString());
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Server timeout '+error))},18000);
    child.once('exit',c=>{clearTimeout(timer);reject(Error('Server quit '+c+' '+error))});
    child.stdout.on('data',x=>{
      buffer+=x.toString();
      const m=buffer.match(/TENSEI_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if(m){clearTimeout(timer);resolve(m[1])}
    });
  });
  return {url,out,child,dir};
}
test('end-to-end Legion: upload XLSX master, CP1251 CSV, auto group, Excel reports and ZIP',async()=>{
  const svc=await serverStart();
  try{
    let r=await fetch(svc.url+'/legion.js');assert.equal(r.status,200);
    r=await fetch(svc.url+'/legion.css');assert.equal(r.status,200);
    r=await fetch(svc.url+'/');assert.match(await r.text(),/id="navLegion"/);
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('База ТС');
    sheet.addRow(['Госномер','Марка/модель','Водитель']);
    sheet.addRow(['А 905 УО 125','Самосвал FAW','Оператор А']);
    const xlsx=Buffer.from(await book.xlsx.writeBuffer());
    let resp=await post(svc.url,'import-master',{file:'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,'+xlsx.toString('base64')});
    assert.equal(resp.status,200,JSON.stringify(resp.body));assert.equal(resp.body.count,1);
    resp=await post(svc.url,'import-csv',{name:'Карьер 01.11.csv',
      file:'data:text/csv;base64,'+sampleBase64});
    assert.equal(resp.status,200,JSON.stringify(resp.body));
    const preview=resp.body;assert.equal(preview.count,3);
    assert.equal(preview.groups.length,2);
    assert.equal(preview.summary.tonnes,85.24);
    assert.equal(preview.summary.unknownVehicles.length,1);
    assert.ok(preview.unknown['С301СВ']);
    assert.equal(preview.groups[0].product,'Скала');
    assert.equal(preview.groups[1].product,'СКАЛА +');
    assert.equal(preview.sample.filter(x=>x.plate==='А905УО').length,2);
    const id=preview.importId;
    resp=await post(svc.url,'generate',{importId:id,coefficient:1.55});
    assert.equal(resp.status,400,'unknown vehicles must block final reports');
    resp=await post(svc.url,'vehicle',{plate:'С301СВ',model:'КамАЗ',driver:'Оператор Б'});
    assert.equal(resp.status,200);
    resp=await post(svc.url,'generate',{importId:id,coefficient:1.55});
    assert.equal(resp.status,200,JSON.stringify(resp.body));
    assert.ok(resp.body.reconciliation.matches);
    assert.match(resp.body.overview,/сводный/);
    assert.equal(resp.body.files.length,2);
    assert.equal(resp.body.files[0].count,2);
    assert.equal(resp.body.files[0].tonnes,55.24);
    assert.equal(resp.body.files[1].count,1);
    assert.equal(resp.body.files[1].tonnes,30);
    const output=await readdir(svc.out);
    assert.equal(output.filter(x=>x.endsWith('.xlsx')).length,3);
    assert.equal(output.filter(x=>x.endsWith('.zip')).length,1);
    const zipResponse=await fetch(svc.url+'/api/legion/download/'+resp.body.reportId);
    assert.equal(zipResponse.status,200);
    const zipper=await JSZip.loadAsync(Buffer.from(await zipResponse.arrayBuffer()));
    const files=Object.values(zipper.files).filter(x=>x.name.endsWith('.xlsx'));
    assert.equal(files.length,3);
    const overviewFile=files.find(x=>x.name.includes('сводный'));
    const overview=new ExcelJS.Workbook();await overview.xlsx.load(await overviewFile.async('nodebuffer'));
    assert.ok(overview.getWorksheet('По дням'));
    assert.ok(overview.getWorksheet('По месяцам'));
    assert.ok(overview.getWorksheet('По автомобилям'));
    assert.ok(overview.getWorksheet('По товарам'));
    assert.ok(overview.getWorksheet('Контроль ошибок'));
    assert.equal(overview.getWorksheet('Параметры').getCell('B2').value,1.55);
    const individual=files.filter(x=>x!==overviewFile);
    const report=new ExcelJS.Workbook();await report.xlsx.load(await individual[0].async('nodebuffer'));
    const sht=report.getWorksheet('Отчёт');
    assert.equal(sht.getCell('D5').value,'Самосвал FAW');
    assert.equal(sht.getCell('J5').value.formula,'H5/I5');
    assert.ok(Math.abs(sht.getCell('J5').value.result-27.24/1.55)<1e-7);
    const second=new ExcelJS.Workbook();await second.xlsx.load(await individual[1].async('nodebuffer'));
    assert.equal(second.getWorksheet('Отчёт').getCell('D5').value,'КамАЗ');
    assert.equal(second.getWorksheet('Отчёт').getCell('F5').value,'Оператор Б');
    const masterRes=await fetch(svc.url+'/api/legion/master');
    assert.equal(masterRes.status,200);
    const master=new ExcelJS.Workbook();await master.xlsx.load(Buffer.from(await masterRes.arrayBuffer()));
    assert.equal(master.getWorksheet('База ТС').getCell('A2').value,'А 905 УО 125');
    assert.ok((await stat(path.join(svc.out,resp.body.zip))).size>1000);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});
test('reject malformed CSV, unsafe vehicle codes and foreign origins',async()=>{
  const svc=await serverStart();
  try{
    let resp=await post(svc.url,'import-csv',{name:'bad.csv',file:'data:text/csv;base64,'+Buffer.from('a;b\nx;y').toString('base64')});
    assert.equal(resp.status,400);
    resp=await post(svc.url,'vehicle',{plate:'A5?!',model:'FAW',driver:'Test'});
    assert.equal(resp.status,400);
    const origin=await fetch(svc.url+'/api/legion/base',{headers:{Origin:'https://evil.example'}});
    assert.equal(origin.status,403);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('batch CSV detects repeated trips and blocks final Excel until errors resolved',async()=>{
  const svc=await serverStart();
  try{
    const plain='ТС;Товар;Дата оформления;Нетто;№\nА905УО;Скала;01.11.2026 12:00;20000;100\n';
    let resp=await post(svc.url,'import-batch',{files:[
      {name:'one.csv',file:'data:text/csv;base64,'+Buffer.from(plain).toString('base64')},
      {name:'two.csv',file:'data:text/csv;base64,'+Buffer.from(plain).toString('base64')}
    ]});
    assert.equal(resp.status,200,JSON.stringify(resp.body));
    assert.equal(resp.body.count,2);
    assert.equal(resp.body.audit.duplicates.length,1);
    assert.equal(resp.body.batchDuplicates.length,1);
    assert.equal(resp.body.audit.ready,false);
    const id=resp.body.importId;
    resp=await post(svc.url,'vehicle',{plate:'А905УО',model:'FAW',driver:'Оператор'});
    assert.equal(resp.status,200);
    resp=await post(svc.url,'generate',{importId:id,coefficient:'1,55'});
    assert.equal(resp.status,400);
    assert.match(resp.body.error,/повторные рейсы/);
    const again=await fetch(svc.url+'/api/legion/import/'+id);
    const restored=await again.json();
    assert.equal(restored.audit.duplicates.length,1);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('photo draft and Legion CSV produce a read-only reconciled ledger',async()=>{
  const svc=await serverStart();
  try{
    const csv='ТС;Товар;Дата оформления;Нетто\nА905УО;Скала;01.11.2026 12:00;27000\n';
    let response=await post(svc.url,'import-csv',{name:'trip.csv',
      file:'data:text/csv;base64,'+Buffer.from(csv,'utf8').toString('base64')});
    assert.equal(response.status,200,JSON.stringify(response.body));
    const importId=response.body.importId;
    const photo={tripDate:'2026-11-01',time:'12:00',vehicle:'А905УО',
      net:27000,source:'Журнал 1.jpg',reviewed:true};
    let r=await fetch(svc.url+'/api/draft',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:[photo]})});
    assert.equal(r.status,200);
    r=await fetch(svc.url+'/api/transport/reconcile?importId='+importId);
    assert.equal(r.status,200);
    let data=await r.json();
    assert.equal(data.reconciliation.counts.matched,1);
    assert.equal(data.combined.length,2);
    assert.equal(data.reconciliation.verified,false);
    assert.equal(data.combined[0].source,'photo');
    assert.equal(data.combined[1].source,'csv');
    // A photo without date must never receive an invented match.
    r=await fetch(svc.url+'/api/draft',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rows:[{...photo,tripDate:''}]})});
    assert.equal(r.status,200);
    r=await fetch(svc.url+'/api/transport/reconcile?importId='+importId);
    data=await r.json();
    assert.equal(data.reconciliation.counts.matched,0);
    assert.equal(data.reconciliation.rows[0].status,'needs-review');
    r=await fetch(svc.url+'/api/transport/reconcile');
    assert.equal(r.status,400);
    r=await fetch(svc.url+'/api/ocr-health');
    assert.equal(r.status,200);
    assert.equal((await r.json()).cloudCalls,0);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('unified fleet API combines repeated Legion imports and photo evidence without double counting',async()=>{
  const svc=await serverStart();
  try{
    const csv='ТС;Товар;Дата оформления;Нетто;№\nА905УО;Скала;05.11.2026 12:30;27000;1001\n';
    const payload={name:'sample.csv',file:'data:text/csv;base64,'+Buffer.from(csv).toString('base64')};
    let res=await post(svc.url,'import-csv',payload);
    assert.equal(res.status,200,JSON.stringify(res.body));
    res=await post(svc.url,'import-csv',payload);
    assert.equal(res.status,200,JSON.stringify(res.body));
    let r=await fetch(svc.url+'/api/draft',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rows:[{tripDate:'2026-11-05',time:'12:30',vehicle:'А905УО',
        net:27000,reviewed:true}]})});
    assert.equal(r.status,200);
    r=await fetch(svc.url+'/api/fleet/stats');
    assert.equal(r.status,200);
    let stats=await r.json();
    assert.equal(stats.totals.trips,1);
    assert.equal(stats.totals.netKg,27000);
    assert.equal(stats.audit.copyDuplicates,1);
    assert.equal(stats.audit.matchedPhotos,1);
    assert.equal(stats.catalog.vehicles[0],'А905УО');
    assert.equal(stats.sourcePolicy,'csv-authoritative');
    r=await fetch(svc.url+'/api/fleet/stats?vehicle=С301СВ');
    stats=await r.json();
    assert.equal(stats.totals.trips,0);
    r=await fetch(svc.url+'/api/fleet/export');
    assert.equal(r.status,200);
    const excel=new ExcelJS.Workbook();
    await excel.xlsx.load(Buffer.from(await r.arrayBuffer()));
    assert.equal(excel.getWorksheet('Автомобили').getCell('E2').value,27000);
    assert.ok(excel.getWorksheet('На проверку'));
    r=await fetch(svc.url+'/analytics');
    assert.equal(r.status,200);
    const markup=await r.text();
    assert.match(markup,/id="fleetTable"/);
    assert.match(markup,/id="exportFleet"/);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('broken saved CSV and draft do not blank fleet statistics or hide missing data',async()=>{
  const svc=await serverStart();
  try{
    const saved=await post(svc.url,'import-csv',{name:'lost.csv',
      file:'data:text/csv;base64,'+sampleBase64});
    assert.equal(saved.status,200,JSON.stringify(saved.body));
    await rm(path.join(svc.dir,'data','legion','imports',saved.body.importId+'.json'));
    await writeFile(path.join(svc.dir,'data','draft.json'),'{broken JSON','utf8');
    const r=await fetch(svc.url+'/api/fleet/stats');
    assert.equal(r.status,200,'must recover a usable error-reporting dashboard');
    const result=await r.json();
    assert.equal(result.partial,true,'unavailable sources must never produce unqualified totals');
    assert.equal(result.totals.trips,0);
    assert.ok(result.warnings.some(x=>x.includes('импорт')));
    assert.ok(result.warnings.some(x=>x.includes('Черновик')));
    const exportResponse=await fetch(svc.url+'/api/fleet/export');
    assert.equal(exportResponse.status,200);
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await exportResponse.arrayBuffer()));
    assert.equal(book.getWorksheet('Контроль').getCell('B16').value.includes('НЕПОЛНАЯ'),true);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('Legion retains more than 50 imports without losing CSV deduplication history',async()=>{
  const svc=await serverStart();
  try{
    const payload={name:'repeat.csv',file:'data:text/csv;base64,'+sampleBase64};
    for(let i=0;i<52;i++){
      const result=await post(svc.url,'import-csv',payload);
      assert.equal(result.status,200,'import '+i+': '+JSON.stringify(result.body));
    }
    const index=JSON.parse(await readFile(path.join(svc.dir,'data','legion','imports-index.json'),'utf8'));
    assert.equal(index.length,52,'index must not silently discard previous 50 imports');
    const res=await fetch(svc.url+'/api/fleet/stats');
    assert.equal(res.status,200);
    const report=await res.json();
    assert.equal(report.partial,false);
    assert.equal(report.audit.copyDuplicates,51*3,'repeat copies should not add tonnage');
    assert.equal(report.totals.trips,3);
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});

test('historic CSV saved outside index makes dashboard and Excel explicitly incomplete',async()=>{
  const svc=await serverStart();
  try{
    const p={name:'history.csv',file:'data:text/csv;base64,'+sampleBase64};
    const first=await post(svc.url,'import-csv',p);
    const second=await post(svc.url,'import-csv',p);
    assert.equal(first.status,200);
    assert.equal(second.status,200);
    const location=path.join(svc.dir,'data','legion','imports-index.json');
    const index=JSON.parse(await readFile(location,'utf8'));
    await writeFile(location,JSON.stringify(index.filter(x=>x.id===second.body.importId)));
    const res=await fetch(svc.url+'/api/fleet/stats');
    assert.equal(res.status,200);
    const data=await res.json();
    assert.equal(data.partial,true);
    assert.equal(data.totals.trips,3,'visible trips still available');
    assert.ok(data.warnings.some(x=>x.includes('вне индекса')));
    const report=await fetch(svc.url+'/api/diagnostics');
    assert.equal(report.status,200);
    const checks=await report.json();
    assert.equal(checks.checks.storage.orphanImports,1);
    const exportResponse=await fetch(svc.url+'/api/fleet/export');
    const book=new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await exportResponse.arrayBuffer()));
    assert.ok(String(book.getWorksheet('Контроль').getCell('B16').value).includes('НЕПОЛНАЯ'));
  }finally{svc.child.kill();await rm(svc.dir,{recursive:true,force:true})}
});
