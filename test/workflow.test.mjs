import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {callCloudVision,extractAssistantText,EmptyVisionError} from '../lib/cloud.mjs';
import {processPhoto} from '../lib/workflow.mjs';
const imageData=async()=> 'data:image/png;base64,'+
  (await sharp({create:{width:1000,height:1400,channels:3,background:'#fafafa'}}).png().toBuffer()).toString('base64');
const answer=(content,reason='stop')=>new Response(JSON.stringify({
  choices:[{message:{role:'assistant',content},finish_reason:reason}],usage:{total_tokens:100}
}),{status:200,headers:{'Content-Type':'application/json'}});

test('empty content gets exactly one retry with 16000 output tokens',async()=>{
  const requested=[];
  const mock=async(url,opts)=>{
    requested.push(JSON.parse(opts.body).max_tokens);
    return requested.length===1?answer(null,'length'):answer('{"rows":[{"vehicle":"A123","net":25000}]}');
  };
  const res=await callCloudVision('dummy','qwen/qwen3-vl-235b-a22b-instruct','data:image/jpeg;base64,AA==','read',mock);
  assert.equal(res.attempts,2);
  assert.deepEqual(requested,[8000,16000]);
  assert.match(res.text,/A123/);
});
test('empty content with no retry gives finish reason instead of generic error',async()=>{
  await assert.rejects(()=>callCloudVision('dummy','model','image','read',
    async()=>answer(null,'length'),{retryEmpty:false}),e=>{
      assert.ok(e instanceof EmptyVisionError);
      assert.match(e.message,/length/);
      return true;
    });
});
test('structured content alternatives parsed safely',()=>{
  assert.equal(extractAssistantText({choices:[{message:{content:[{type:'text',text:'{"rows":[]}'}]},finish_reason:'stop'}]}).text,'{"rows":[]}');
});
test('end-to-end photo workflow retries blank Cloud response without real API',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async(url,opts)=>{
    calls++;
    if(!String(url).endsWith('/chat/completions'))throw Error('unexpected URL');
    return calls===1?answer(null,'length'):answer('{"rows":[{"time":"08:01","vehicle":"A123BC","tare":17650,"gross":48250,"net":30600,"bbox":[0.1,0.2,0.9,0.3]}]}');
  };
  try{
    const out=await processPhoto({image:await imageData(),name:'journal.png',
      cfg:{key:'fake-key',model:'qwen/qwen3-vl-235b-a22b-instruct',fallback:false,
        cropRecovery:false,enhance:true,paddle:false,chandra:false},
      template:{id:'weights',name:'Журнал весовой',columns:['Время','ТС','Тара','Брутто','Нетто']}});
    assert.equal(calls,2);
    assert.equal(out.rows[0].net,30600);
    assert.deepEqual(out.rows[0].bbox,[.1,.2,.9,.3]);
    assert.ok(out.rows[0].sourceId);
    assert.equal(out.rows[0].reviewed,false);
  }finally{globalThis.fetch=old}
});
test('full-page empty output recovers via two cropped segments',async()=>{
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    return calls<=2?answer(null,'length'):answer('{"rows":[{"time":"08:00","vehicle":"M123","tare":10000,"gross":40000,"net":30000}]}');
  };
  try{
    const out=await processPhoto({image:await imageData(),name:'journal.png',
      cfg:{key:'fake-key',model:'qwen/qwen3-vl-235b-a22b-instruct',fallback:false,
        cropRecovery:true,enhance:false,paddle:false,chandra:false},
      template:{columns:['Тара','Брутто','Нетто']}});
    assert.equal(calls,4);
    assert.equal(out.rows.length,2);
    assert.equal(out.rows[0].uncertain,true);
    assert.match(out.warnings.join(' '),/увеличенные части/);
  }finally{globalThis.fetch=old}
});
