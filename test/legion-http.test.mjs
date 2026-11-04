import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readdir,stat} from 'node:fs/promises';
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
    assert.equal(resp.status,200,JSON.stringify(resp.body));
    assert.equal(resp.body.files.length,2);
    assert.equal(resp.body.files[0].count,2);
    assert.equal(resp.body.files[0].tonnes,55.24);
    assert.equal(resp.body.files[1].count,1);
    assert.equal(resp.body.files[1].tonnes,30);
    const output=await readdir(svc.out);
    assert.equal(output.filter(x=>x.endsWith('.xlsx')).length,2);
    assert.equal(output.filter(x=>x.endsWith('.zip')).length,1);
    const zipResponse=await fetch(svc.url+'/api/legion/download/'+resp.body.reportId);
    assert.equal(zipResponse.status,200);
    const zipper=await JSZip.loadAsync(Buffer.from(await zipResponse.arrayBuffer()));
    const files=Object.values(zipper.files).filter(x=>x.name.endsWith('.xlsx'));
    assert.equal(files.length,2);
    const report=new ExcelJS.Workbook();await report.xlsx.load(await files[0].async('nodebuffer'));
    const sht=report.getWorksheet('Отчёт');
    assert.equal(sht.getCell('D5').value,'Самосвал FAW');
    assert.equal(sht.getCell('J5').value.formula,'H5/I5');
    assert.ok(Math.abs(sht.getCell('J5').value.result-27.24/1.55)<1e-7);
    const second=new ExcelJS.Workbook();await second.xlsx.load(await files[1].async('nodebuffer'));
    assert.equal(second.getWorksheet('Отчёт').getCell('D5').value,'НЕТ В БАЗЕ');
    assert.equal(second.getWorksheet('Отчёт').getCell('F5').value,'НЕТ В БАЗЕ');
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
