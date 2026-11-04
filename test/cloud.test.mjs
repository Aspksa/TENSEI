import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudError,listCloudModels,recognizeWithFallback,describe} from '../lib/cloud.mjs';
const models=(ids)=>new Response(JSON.stringify({object:'list',data:ids.map(id=>({id}))}),{status:200,headers:{'Content-Type':'application/json'}});
const ok=(str)=>new Response(JSON.stringify({choices:[{message:{content:str}}],usage:{total_tokens:80}}),{status:200,headers:{'Content-Type':'application/json'}});
const notFound=()=>new Response(JSON.stringify({error:{message:'model_not_found'}}),{status:404});
const testArgs={key:'private-secret',model:'qwen/qwen3-vl-235b-a22b-instruct',image:'data:image/jpeg;base64,AA==',prompt:'Read rows'};
test('API model list extracts IDs without exposing key',async()=>{
  const urls=[];
  const list=await listCloudModels('private-secret',async(url,options)=>{
    urls.push(url);
    assert.equal(options.headers.Authorization,'Bearer private-secret');
    return models(['qwen/qwen3-vl-235b-a22b-instruct','qwen/qwen3-vl-8b-instruct']);
  });
  assert.equal(urls[0],'https://foundation-models.api.cloud.ru/v1/models');
  assert.equal(list.length,2);
});
test('404 retries only a listed vision backup',async()=>{
  const tried=[];
  const mock=async(url,options)=>{
    if(url.endsWith('/models'))return models(['qwen/qwen3-vl-30b-a3b-instruct']);
    const payload=JSON.parse(options.body);
    tried.push(payload.model);
    return tried.length===1?notFound():ok('{"rows":[]}');
  };
  const result=await recognizeWithFallback({...testArgs,fetcher:mock});
  assert.equal(result.model,'qwen/qwen3-vl-30b-a3b-instruct');
  assert.equal(result.fallbackFrom,testArgs.model);
  assert.deepEqual(tried,['qwen/qwen3-vl-235b-a22b-instruct','qwen/qwen3-vl-30b-a3b-instruct']);
});
test('404 without fallback preserves error',async()=>{
  await assert.rejects(()=>recognizeWithFallback({...testArgs,fallback:false,fetcher:async()=>notFound()}),e=>{
    assert.equal(e.status,404);
    assert.match(e.message,/HTTP 404/);
    return true;
  });
});
test('model list failure shows useful diagnosis and not key',async()=>{
  const err=()=>new Response(JSON.stringify({error:{message:'bad private-secret token'}}),{status:401});
  await assert.rejects(()=>listCloudModels('private-secret',async()=>err()),e=>{
    assert.ok(e instanceof CloudError);
    assert.match(e.message,/HTTP 401/);
    assert.ok(!e.message.includes('private-secret'));
    return true;
  });
});
test('404 with no accessible backups is actionable',async()=>{
  let calls=0;
  const mock=async(url)=>{calls++;return url.endsWith('/models')?models(['openai/gpt-oss-120b']):notFound()};
  await assert.rejects(()=>recognizeWithFallback({...testArgs,fetcher:mock}),/нет доступных резервных моделей/);
  assert.equal(calls,2);
});
test('HTTP diagnostics cover authentication and model not found',()=>{
  assert.match(describe(404),/Модель/);
  assert.match(describe(403),/Ключ/);
});
