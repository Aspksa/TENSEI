import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {createScanLibrary,parseOriginal} from '../lib/scan-library.mjs';

const image=async()=> {
  const buffer=await sharp({create:{width:1200,height:1600,channels:3,background:'#f3f3f3'}}).jpeg().toBuffer();
  return {buffer,data:'data:image/jpeg;base64,'+buffer.toString('base64')};
};
const wait=async(check,timeout=3200)=>{
  const start=Date.now();
  while(Date.now()-start<timeout){
    const value=await check();if(value)return value;
    await new Promise(r=>setTimeout(r,20));
  }
  throw Error('Timed out waiting for scan state');
};
const library=(dir,process)=>createScanLibrary({dataDir:dir,readBody:async()=>{throw Error('unexpected')},
  send:()=>{},process});
test('each scan saves original bytes first and has its own editable local result',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'tensei-scan-'));
  try{
    const asset=await image();
    const l=library(dir,async({name,progress})=>{
      progress('Cloud.ru: анализ страницы');
      return {rows:[{time:'08:00',vehicle:'А123ВС',tare:12000,gross:40000,net:28000,note:name,
        uncertain:false}],sourceId:randomUUID(),model:'mock-vision',warnings:[]};
    });
    const a=(await l.create({image:asset.data,name:'page 1.jpg'})).scan;
    const b=(await l.create({image:asset.data,name:'page 2.jpg'})).scan;
    assert.notEqual(a.id,b.id);
    await wait(async()=>(await l.response(a.id)).scan.status==='done');
    await wait(async()=>(await l.response(b.id)).scan.status==='done');
    const originalA=await fs.readFile(path.join(dir,'scans',a.id,'original.bin'));
    const originalB=await fs.readFile(path.join(dir,'scans',b.id,'original.bin'));
    assert.deepEqual(originalA,asset.buffer);
    assert.deepEqual(originalB,asset.buffer);
    await l.persistRows(a.id,[{vehicle:'А123ВС',time:'08:00',net:28001,note:'Проверено',reviewed:true}]);
    const first=await l.response(a.id),second=await l.response(b.id);
    assert.equal(first.rows[0].net,28001);
    assert.equal(first.rows[0].reviewed,true);
    assert.equal(second.rows[0].net,28000);
    assert.equal(first.scan.rowsCount,1);
    assert.ok((await fs.stat(path.join(dir,'scans',a.id,'preview.jpg'))).size>1000);
  }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('failed OCR preserves original and can be retried with same scan ID',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'tensei-scan-'));
  try{
    const asset=await image();let calls=0;
    const l=library(dir,async()=>{
      calls++;if(calls===1)throw Error('Cloud.ru HTTP 404 unavailable');
      return {rows:[{vehicle:'А123ВС',net:25000}],sourceId:randomUUID(),model:'retry'};
    });
    const scan=(await l.create({image:asset.data,name:'failed.jpg'})).scan;
    await wait(async()=>(await l.response(scan.id)).scan.status==='error');
    assert.match((await l.response(scan.id)).scan.error,/404/);
    assert.deepEqual(await fs.readFile(path.join(dir,'scans',scan.id,'original.bin')),asset.buffer);
    await l.retry(scan.id,false);
    const done=await wait(async()=>{
      const x=await l.response(scan.id);return x.scan.status==='done'?x:null
    });
    assert.equal(done.rows.length,1);assert.equal(done.scan.id,scan.id);assert.equal(calls,2);
  }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('unfinished scans recover as interrupted after server restart',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'tensei-scan-'));
  try{
    const asset=await image();
    const stuck=library(dir,()=>new Promise(()=>{}));
    const scan=(await stuck.create({image:asset.data,name:'waiting.jpg'})).scan;
    await wait(async()=>{const x=await stuck.response(scan.id);return x.scan.status==='processing'});
    const afterRestart=library(dir,async()=>({rows:[{vehicle:'М111ММ',net:10000}],sourceId:randomUUID()}));
    await afterRestart.init();
    const found=await afterRestart.response(scan.id);
    assert.equal(found.scan.status,'interrupted');
    assert.match(found.scan.error,/закрыт/);
    assert.ok((await fs.stat(path.join(dir,'scans',scan.id,'original.bin'))).size>1000);
  }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('invalid image and unsafe data URI cannot enter scan library',()=>{
  assert.throws(()=>parseOriginal('data:text/html;base64,PHNjcmlwdD4='),/изображение/);
  assert.throws(()=>parseOriginal('file:///C:/secret.txt'),/изображение/);
});
