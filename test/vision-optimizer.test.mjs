import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {perceptualHash,hashDistance,selectedModels,validateWeights} from '../lib/vision-optimizer.mjs';
import {processPhoto} from '../lib/workflow.mjs';

test('same photo similarity hash is deterministic; different pages never auto-merged',async()=>{
  const image='data:image/png;base64,'+(await sharp({create:{width:200,height:200,channels:3,background:'white'}}).png().toBuffer()).toString('base64');
  const a=await perceptualHash(image);
  assert.equal(a.length,16);
  assert.equal(hashDistance(a,await perceptualHash(image)),0);
  assert.equal(hashDistance('invalid',a),64);
});
test('economy chooses small then medium; local validator never fabricates values',()=>{
  assert.equal(selectedModels('economy','unused').primary,'qwen/qwen3-vl-8b-instruct');
  assert.equal(selectedModels('balanced','unused').primary,'qwen/qwen3-vl-30b-a3b-instruct');
  const rows=[{vehicle:'A123',net:30000,gross:49000,tare:19000},{vehicle:'',net:60000}];
  assert.equal(validateWeights(rows).flagged,1);
  assert.equal(rows[1].net,60000);
  assert.equal(rows[1].uncertain,true);
});
test('smart mode limits calls, uses selected model and stores tokens',async()=>{
  const image='data:image/png;base64,'+(await sharp({create:{width:1000,height:1400,channels:3,background:'white'}}).png().toBuffer()).toString('base64');
  const orig=globalThis.fetch,seen=[];
  globalThis.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);seen.push(body);
    return new Response(JSON.stringify({choices:[{message:{content:'{"rows":[{"vehicle":"A123","net":30000,"gross":49000,"tare":19000}]}'},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}}),{status:200});
  };
  try{
    const result=await processPhoto({image,name:'weights.png',
      cfg:{key:'test',model:'qwen/qwen3-vl-235b-a22b-instruct',costMode:'economy',maxCloudCalls:1,
        enhance:true,cropRecovery:true,fallback:true,paddle:false,chandra:false,mineru:false},
      template:{name:'Журнал',columns:['Время','ТС','Тара','Брутто','Нетто']}});
    assert.equal(seen.length,1);
    assert.equal(seen[0].model,'qwen/qwen3-vl-8b-instruct');
    assert.equal(seen[0].max_tokens,3500);
    assert.equal(result.cloudCalls,1);
    assert.equal(result.usage.total_tokens,60);
  }finally{globalThis.fetch=orig}
});
