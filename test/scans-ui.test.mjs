import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const respond=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{'Content-Type':'application/json'}});
async function wait(check,timeout=3500){
  const start=Date.now();
  while(Date.now()-start<timeout){if(check())return;await new Promise(resolve=>setTimeout(resolve,20))}
  throw Error('Photo UI test timed out');
}
test('two new photos create distinct archive records and editing a scan never rewrites another',async()=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:5522/',pretendToBeVisual:true});
  const old={document:globalThis.document,window:globalThis.window,FileReader:globalThis.FileReader,
    fetch:globalThis.fetch,URL:globalThis.URL,confirm:globalThis.confirm};
  const scans=[],calls=[],saved=new Map();
  const base='qwen/qwen3-vl-235b-a22b-instruct';
  const getScan=id=>scans.find(x=>x.id===id);
  const mock=async(url,opts={})=>{
    const name=String(url),method=opts.method||'GET';calls.push({name,method});
    if(name==='/api/settings')return respond({model:base,hasKey:true,
      models:[{id:base,name:'Qwen3 VL'}],fallback:true,enhance:true,cropRecovery:true});
    if(name==='/api/draft')return respond(method==='GET'?{rows:[]}:{ok:true});
    if(name==='/api/storage')return respond({cloudSyncRisk:false});
    if(name==='/api/tasks')return respond({tasks:[]});
    if(name==='/api/templates')return respond({templates:[{id:'weights',name:'Журнал весовой'}]});
    if(name==='/api/quality')return respond({quality:{width:1200,height:1400,warnings:[]}});
    if(name==='/api/scans'&&method==='GET')return respond({scans:[...scans].reverse(),total:scans.length});
    if(name==='/api/scans'&&method==='POST'){
      const info=JSON.parse(opts.body),id=String(scans.length+1).padStart(8,'0')+'-1111-4111-8111-111111111111';
      const scan={id,name:info.name,status:'done',stage:'Распознавание завершено',step:'complete',
        progress:100,rowsCount:1,createdAt:'2026-11-04T15:00:00.000Z',warnings:[]};
      scans.push(scan);
      saved.set(id,[{vehicle:'А123ВС',time:'09:00',net:(scans.length===1?24000:30000),
        tare:10000,gross:(scans.length===1?34000:40000),source:info.name,
        sourceId:'11111111-1111-4111-8111-111111111111'}]);
      return respond({scan});
    }
    const save=/^\/api\/scans\/([0-9a-f-]+)\/rows$/.exec(name);
    if(save&&method==='POST'){saved.set(save[1],JSON.parse(opts.body).rows);return respond({ok:true,count:saved.get(save[1]).length})}
    const get=/^\/api\/scans\/([0-9a-f-]+)$/.exec(name);
    if(get){
      const scan=getScan(get[1]);
      if(!scan)return respond({error:'not found'},404);
      return respond({scan,rows:saved.get(get[1])||[]});
    }
    return respond({error:'Unexpected '+method+' '+name},404);
  };
  try{
    globalThis.document=dom.window.document;
    globalThis.window=dom.window;
    globalThis.FileReader=dom.window.FileReader;
    globalThis.fetch=mock;
    globalThis.URL=dom.window.URL;
    globalThis.confirm=()=>true;
    dom.window.URL.createObjectURL=()=> 'blob:fake-image';
    dom.window.URL.revokeObjectURL=()=>{};
    dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
    await import('../app.js?test-photo-saved-separately');
    const $=id=>dom.window.document.getElementById(id);
    await wait(()=>$('connectionStatus').textContent.includes('Ключ сохранён'));
    async function upload(name){
      const file=new dom.window.File([new Uint8Array([255,216,255,217])],name,{type:'image/jpeg'});
      Object.defineProperty($('photoFiles'),'files',{configurable:true,value:[file]});
      $('photoFiles').dispatchEvent(new dom.window.Event('change',{bubbles:true}));
      await wait(()=>$('queuedCount').textContent.includes('1'));
      $('recognize').click();
      await wait(()=>$('progressStatus').textContent.includes('Сканов сохранено: '+scans.length)&&
        !$('addRow').disabled,3800);
    }
    await upload('страница 1.jpg');
    assert.equal($('metricRows').textContent,'1');
    assert.equal($('metricTons').textContent,'24,000');
    assert.equal($('scanArchiveCount').textContent,'1');
    const first=scans[0].id;
    const net=dom.window.document.querySelector('input[aria-label="Нетто; строка 1"]');
    net.value='24500';net.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    await wait(()=>saved.get(first)?.[0]?.net===24500,3200);
    await upload('страница 2.jpg');
    assert.equal($('metricRows').textContent,'1','only the second scan appears in table');
    assert.equal($('metricTons').textContent,'30,000');
    assert.equal($('scanArchiveCount').textContent,'2');
    assert.equal(saved.get(first)[0].net,24500,'first scan retained edits');
    assert.equal(saved.get(scans[1].id)[0].net,30000,'second scan remains independent');
    $('clearData').click();
    await wait(()=>$('metricRows').textContent==='0');
    assert.equal(scans.length,2,'clearing current view cannot delete archive');
    assert.ok($('scanGallery').textContent.includes('страница 1.jpg'));
    assert.ok($('scanGallery').textContent.includes('страница 2.jpg'));
  }finally{
    dom.window.close();
    for(const [name,value] of Object.entries(old)){
      if(value===undefined)delete globalThis[name];else globalThis[name]=value;
    }
  }
});
