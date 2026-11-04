import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const analyticsHtml=readFileSync(new URL('../analytics.html',import.meta.url),'utf8');
const analyticsJs=readFileSync(new URL('../analytics.js',import.meta.url),'utf8');
const response=(value,status=200)=>new Response(JSON.stringify(value),{
  status,headers:{'Content-Type':'application/json'}});
const wait=async(check,n=2000)=>{for(let i=0;i<n/20;i++){if(check())return;await new Promise(r=>setTimeout(r,20))}throw Error('UI wait timed out')};

test('analytics renders real totals and calendar without undefined kg; optional service outage is isolated',async()=>{
  const dom=new JSDOM(analyticsHtml,{url:'http://127.0.0.1:3000/analytics',runScripts:'outside-only'});
  const $=id=>dom.window.document.getElementById(id);
  dom.window.fetch=async url=>{
    if(String(url).startsWith('/api/fleet/stats'))return response({
      totals:{tonnes:27,trips:1,vehicles:1,avgTripTonnes:27},
      audit:{excluded:0,copyDuplicates:0,matchedPhotos:1},sourcePolicy:'csv-authoritative',
      vehicles:[{plate:'А905УО',trips:1,netKg:27000,model:'FAW',driver:'Иванов'}],
      products:[{name:'Скала',trips:1,netKg:27000}],
      daily:[{date:'2026-11-05',trips:1,netKg:27000}],
      hours:[{hour:'12:00',trips:1,netKg:27000}],
      trips:[{date:'2026-11-05',time:'12:00',plate:'А905УО',netKg:27000,
        product:'Скала',from:'csv',photoEvidence:1}],review:[],
      catalog:{vehicles:['А905УО'],products:['Скала']},tripsTruncated:false
    });
    throw Error('Auxiliary service is intentionally offline');
  };
  dom.window.eval(analyticsJs);
  try{
    await wait(()=>$('state').textContent.includes('Учтено 1'));
    assert.equal($('totalTons').textContent,'27 т');
    assert.equal($('fleetTable').children.length,1);
    assert.equal($('calendar').children.length,30,'calendar should render without kg ReferenceError');
    assert.equal($('state').textContent.includes('Ошибка статистики'),false);
    assert.equal($('sourcePolicy').textContent.includes('CSV'),true);
  }finally{dom.window.close()}
});

test('photo upload visibly queues a file and shows a concrete next step without Cloud.ru key',async()=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:3000/',pretendToBeVisual:true});
  const old={document:globalThis.document,window:globalThis.window,
    fetch:globalThis.fetch,FileReader:globalThis.FileReader,URL:globalThis.URL};
  try{
    globalThis.document=dom.window.document;
    globalThis.window=dom.window;
    globalThis.FileReader=dom.window.FileReader;
    globalThis.URL=dom.window.URL;
    dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
    globalThis.fetch=async url=>{
      const route=String(url);
      if(route==='/api/settings')return response({model:'qwen/qwen3-vl-235b-a22b-instruct',
        hasKey:false,models:[]});
      if(route==='/api/draft')return response({rows:[]});
      if(route==='/api/ocr-health')return response({rapid:{available:false,reason:'offline'}});
      if(route==='/api/templates')return response({templates:[{id:'weights',name:'Весовой'}]});
      if(route==='/api/tasks')return response({tasks:[]});
      if(route==='/api/quality')return response({quality:{width:320,height:240,warnings:[]}});
      return response({error:'unavailable'},400);
    };
    await import('../app.js?photo-user-journey-v3');
    const $=id=>dom.window.document.getElementById(id);
    await wait(()=>$('connectionStatus').textContent.includes('Нужен API'));
    const file=new dom.window.File(['fake image bytes'],'weights.jpg',{type:'image/jpeg'});
    Object.defineProperty($('photoFiles'),'files',{configurable:true,value:[file]});
    $('photoFiles').dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    assert.equal($('recognize').disabled,false);
    assert.match($('uploadFeedback').textContent,/Добавлено фотографий: 1/);
    assert.match($('progressStatus').textContent,/API-ключ/);
    $('recognize').click();
    assert.match($('uploadFeedback').textContent,/Обработка не началась/);
    assert.equal($('fileQueue').children.length,1);
  }finally{
    dom.window.close();
    for(const [key,value] of Object.entries(old)){
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
  }
});
