import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const response=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=1800){
  const start=Date.now();
  while(Date.now()-start<timeout){if(check())return;await sleep(20)}
  throw Error('DOM action did not finish within '+timeout+' ms');
}
test('visible settings save API key, check model and edit a journal row',async()=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:57474/',pretendToBeVisual:true});
  const saved={model:'qwen/qwen3-vl-235b-a22b-instruct',key:'',fallback:true};
  let settingsWrites=0,draftWrites=0;
  const fetchStub=async(url,options={})=>{
    const path=String(url),method=options.method||'GET';
    if(path==='/api/settings'&&method==='GET'){
      return response({model:saved.model,hasKey:!!saved.key,fallback:saved.fallback,models:[
        {id:'qwen/qwen3-vl-235b-a22b-instruct',name:'Qwen3 VL 235B'},
        {id:'Qwen/Qwen3.5-397B-A17B',name:'Qwen3.5 397B'}
      ]});
    }
    if(path==='/api/settings'&&method==='POST'){
      const input=JSON.parse(options.body);
      saved.key=input.key||saved.key;saved.model=input.model;saved.fallback=input.fallback;
      settingsWrites++;
      return response({ok:true,hasKey:!!saved.key,model:saved.model});
    }
    if(path==='/api/connection'){
      return response({ok:true,selected:saved.model,selectedAvailable:true,availableCount:2,available:[],reason:'Найдена'});
    }
    if(path==='/api/draft'&&method==='GET')return response({rows:[],savedAt:null});
    if(path==='/api/draft'&&method==='POST'){draftWrites++;return response({ok:true,savedAt:new Date().toISOString()})}
    if(path==='/api/draft'&&method==='DELETE')return response({ok:true});
    return response({error:'Unexpected request: '+method+' '+path},404);
  };
  const old={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,FileReader:globalThis.FileReader,confirm:globalThis.confirm,URL:globalThis.URL};
  try{
    globalThis.document=dom.window.document;
    globalThis.window=dom.window;
    globalThis.fetch=fetchStub;
    globalThis.FileReader=dom.window.FileReader;
    globalThis.confirm=()=>true;
    globalThis.URL=dom.window.URL;
    dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
    const errors=[];
    dom.window.addEventListener('error',e=>errors.push(e.message));
    await import('../app.js?ui-regression');
    const $=id=>dom.window.document.getElementById(id);
    await until(()=>$('connectionStatus').textContent.includes('Нужен API-ключ'));
    assert.equal($('settingsDetails').open,true,'settings are visible without navigation');
    assert.ok($('apiKey'));
    assert.equal($('model').value,'qwen/qwen3-vl-235b-a22b-instruct');
    $('apiKey').value='example-not-a-real-key';
    $('settingsForm').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>settingsWrites===1&&$('connectionStatus').textContent.includes('Модель доступна'));
    assert.equal(saved.key,'example-not-a-real-key');
    assert.equal($('apiKey').value,'','secret is removed from UI after saving');
    assert.equal($('connectionDetails').hidden,false);
    $('addRow').click();
    await until(()=>$('metricRows').textContent==='1');
    assert.equal($('download').disabled,false);
    const field=dom.window.document.querySelector('input[aria-label="Номер ТС; строка 1"]');
    assert.ok(field,'journal row has editable input');
    field.value='а123вс';field.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    assert.ok(dom.window.document.body.textContent.includes('на проверку'));
    await until(()=>draftWrites>=1,2600);
    assert.deepEqual(errors,[]);
  }finally{
    dom.window.close();
    for(const [key,value] of Object.entries(old)){
      if(value===undefined)delete globalThis[key];
      else globalThis[key]=value;
    }
  }
});
