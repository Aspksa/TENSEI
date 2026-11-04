import test from 'node:test';
import assert from 'node:assert/strict';
import {createMineruTask,getMineruTask,cancelMineruTask} from '../lib/mineru-tasks.mjs';
const response=o=>new Response(JSON.stringify(o),{status:200,headers:{'Content-Type':'application/json'}});
test('MinerU 4.1 task creation, same-origin PUT upload and status',async()=>{
  const seen=[];
  const mock=async(url,options)=>{
    seen.push({url,method:options.method||'GET',body:options.body});
    if(url.endsWith('/v1/tasks')&&options.method==='POST')
      return response({task_id:'job_12345',files:[{file_id:'file_001',
        upload:{url:'http://127.0.0.1:8766/v1/tasks/job_12345/upload/file_001',headers:{'X-Test':'yes'}}}]});
    if(options.method==='PUT')return response({ok:true});
    return response({task_id:'job_12345',status:'completed',files:[{file_id:'file_001',status:'completed',
      result_url:'http://127.0.0.1:8766/v1/files/file_001'}]});
  };
  const image='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
  const created=await createMineruTask({image,name:'journal.webp',fetcher:mock});
  assert.equal(created.taskId,'job_12345');
  assert.equal(seen[1].method,'PUT');
  assert.equal(seen[1].body.length,4);
  const status=await getMineruTask(created.taskId,{fetcher:mock});
  assert.equal(status.status,'completed');
  assert.equal(status.files[0].hasResult,true);
  assert.equal('result_url' in status.files[0],false);
});
test('MinerU rejects unexpected upload URLs and non-local hosts',async()=>{
  const image='data:image/jpeg;base64,'+Buffer.from([255,216]).toString('base64');
  await assert.rejects(()=>createMineruTask({url:'https://example.org',image}),/локальном/);
  const mock=async()=>response({task_id:'job_12345',files:[{upload:{url:'https://attack.example/upload'}}]});
  await assert.rejects(()=>createMineruTask({image,fetcher:mock}),/адрес/);
});
test('MinerU cancellation uses documented endpoint',async()=>{
  let url='';
  await cancelMineruTask('job_12345',{fetcher:async u=>{url=u;return response({status:'canceled'})}});
  assert.match(url,/\/v1\/tasks\/job_12345\/cancel$/);
});
