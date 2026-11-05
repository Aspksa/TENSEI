import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudError,listCloudModels,recognizeWithFallback,describe,suggestedVisionModels,likelyVisionModel} from '../lib/cloud.mjs';
import {selectedModels} from '../lib/vision-optimizer.mjs';
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

test('auto mode respects selected model instead of forcing unavailable Qwen 30B',()=>{
  assert.equal(selectedModels('auto','Qwen/Qwen3.5-397B-A17B').primary,'Qwen/Qwen3.5-397B-A17B');
  assert.equal(selectedModels('auto','qwen/qwen3-vl-235b-a22b-instruct').primary,'qwen/qwen3-vl-235b-a22b-instruct');
  assert.equal(selectedModels('economy','qwen/qwen3-vl-235b-a22b-instruct').primary,'qwen/qwen3-vl-8b-instruct');
});
test('discovery only suggests vision-sounding published IDs and supports new releases',()=>{
  assert.equal(likelyVisionModel('Qwen/Qwen3-VL-30B-Instruct'),true);
  assert.equal(likelyVisionModel('Qwen/Qwen3.5-OCR'),true);
  assert.equal(likelyVisionModel('ai-sage/GigaChat3-10B-A1.8B'),false);
  assert.deepEqual(suggestedVisionModels(['ai-sage/GigaChat3-10B-A1.8B','Qwen/Qwen3-VL-New']),
    ['Qwen/Qwen3-VL-New']);
});
test('unknown historical model can fall back to newly advertised vision model on 404',async()=>{
  const attempted=[];
  const mock=async(url,options)=>{
    if(url.endsWith('/models'))return models(['Qwen/Qwen3-VL-New']);
    attempted.push(JSON.parse(options.body).model);
    return attempted.length===1?notFound():ok('{"rows":[{"vehicle":"А123ВС","net":27000}]}');
  };
  const result=await recognizeWithFallback({...testArgs,model:'Qwen/Old-Retired-VL',fetcher:mock});
  assert.equal(result.model,'Qwen/Qwen3-VL-New');
  assert.deepEqual(attempted,['Qwen/Old-Retired-VL','Qwen/Qwen3-VL-New']);
});
test('exhausted unavailable models keep structured 404 status',async()=>{
  const mock=async(url)=>url.endsWith('/models')?models(['plain-text-only']):notFound();
  await assert.rejects(()=>recognizeWithFallback({...testArgs,fetcher:mock}),e=>{
    assert.ok(e instanceof CloudError);
    assert.equal(e.status,404);
    assert.match(e.message,/Нет доступных резервных моделей/);
    return true;
  });
});
