import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sampleBase64='uTvE4PLgIO707vDs6+Xt6P870tE70u7i4PA7zeXy8u470uDw4DvB8PPy8u4KMTswMS4xMS4yMDI2IDEyOjAwO+A5MDXz7jvR6uDr4DsyNzI0MDsxMjAwMDszOTI0MAoyOzAxLjExLjIwMjYgMTI6MzA74DkwNfPuO9Hq4OvgOzI4MDAwOzEyMDAwOzQwMDAwCjM7MDEuMTEuMjAyNiAxMzowMDvxMzAx8eI70crAy8AgKzszMDAwMDsxMjAwMDs0MjAwMAo=';
async function run(){
  const dir=await mkdtemp(path.join(tmpdir(),'tensei-v06-'));
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',
    TENSEI_DATA_DIR:path.join(dir,'data'),TENSEI_REPORTS_DIR:path.join(dir,'reports'),TENSEI_NO_BROWSER:'1'},
    stdio:['ignore','pipe','pipe']});
  let stream='',err='';
  child.stderr.on('data',x=>err+=x.toString());
  const base=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill();reject(Error('Server timeout '+err))},16000);
    child.stdout.on('data',x=>{
      stream+=x.toString();
      const m=stream.match(/TENSEI_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if(m){clearTimeout(timeout);resolve(m[1])}
    });
    child.once('exit',c=>{clearTimeout(timeout);reject(Error('Server stopped '+c+' '+err))});
  });
  return {dir,child,base};
}
const post=async(base,endpoint,payload)=>{
  const res=await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  return {status:res.status,payload:await res.json()};
};
async function poll(base,id){
  for(let i=0;i<80;i++){
    const res=await fetch(base+'/api/scans/'+id);
    assert.equal(res.status,200);
    const payload=await res.json();
    if(['done','error','interrupted'].includes(payload.scan.status))return payload;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  throw Error('Scan did not terminate in test');
}
test('complete local API: all vector assets, CSV analytics, idempotent import and preserved failed photo',async()=>{
  const s=await run();
  try{
    for(const route of ['/','/analytics.js','/analytics.css','/scans.js','/scans.css']){
      const res=await fetch(s.base+route);
      assert.equal(res.status,200,route);
      assert.ok((await res.text()).length>100);
    }
    let a=await fetch(s.base+'/api/analytics');
    const empty=await a.json();
    assert.equal(empty.kpi.trips,0);
    const upload={name:'CSV карьера 01.11.csv',file:'data:text/csv;base64,'+sampleBase64};
    const first=await post(s.base,'/api/legion/import-csv',upload);
    assert.equal(first.status,200,JSON.stringify(first.payload));
    assert.equal(first.payload.count,3);
    const second=await post(s.base,'/api/legion/import-csv',upload);
    assert.equal(second.status,200);
    assert.equal(second.payload.reused,true);
    assert.equal(second.payload.importId,first.payload.importId);
    a=await fetch(s.base+'/api/analytics');
    const stats=await a.json();
    assert.equal(stats.kpi.trips,3);
    assert.equal(stats.kpi.tonnes,85.24);
    assert.equal(stats.source.files,1);
    assert.equal(stats.products.length,2);
    a=await fetch(s.base+'/api/analytics?from=2026-11-01&to=2026-11-01&period=day');
    assert.equal((await a.json()).kpi.trips,3);
    const image=await sharp({create:{width:1200,height:1400,channels:3,background:'#fafafa'}}).jpeg().toBuffer();
    const created=await post(s.base,'/api/scans',{name:'Скан 1.jpg',
      image:'data:image/jpeg;base64,'+image.toString('base64')});
    assert.equal(created.status,200,JSON.stringify(created.payload));
    const id=created.payload.scan.id;
    const final=await poll(s.base,id);
    assert.equal(final.scan.status,'error'); // No Cloud.ru key was configured
    assert.match(final.scan.error,/API-ключ/);
    a=await fetch(s.base+'/api/scans');
    const gallery=await a.json();
    assert.equal(gallery.total,1);
    assert.equal(gallery.scans[0].name,'Скан 1.jpg');
    assert.equal(gallery.scans[0].status,'error');
    a=await fetch(s.base+'/api/scans/'+id+'/preview');
    assert.equal(a.status,200);assert.equal(a.headers.get('Content-Type'),'image/jpeg');
    a=await fetch(s.base+'/api/scans/'+id+'/original');
    assert.equal(a.status,200);
    assert.deepEqual(Buffer.from(await a.arrayBuffer()),image);
    a=await fetch(s.base+'/api/analytics');
    assert.equal((await a.json()).source.scannedPhotos,1);
    assert.equal((await a.json().catch(()=>null)),null); // Body is consumed.
    const retry=await post(s.base,'/api/scans/'+id+'/retry',{force:false});
    assert.equal(retry.status,200);
    await poll(s.base,id);
    a=await fetch(s.base+'/api/scans/'+id+'/original');
    assert.deepEqual(Buffer.from(await a.arrayBuffer()),image);
  }finally{s.child.kill();await rm(s.dir,{recursive:true,force:true})}
});
