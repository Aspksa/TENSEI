import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const answer=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
async function until(fn,timeout=3200){
  const begun=Date.now();
  while(Date.now()-begun<timeout){if(fn())return;await new Promise(done=>setTimeout(done,25))}
  throw Error('Legion UI timed out');
}
test('left menu works; vehicle can be saved; CSV preview renders without a new page',async()=>{
  const dom=new JSDOM(html,{url:'http://127.0.0.1:5353/',pretendToBeVisual:true});
  const old={window:globalThis.window,document:globalThis.document,FileReader:globalThis.FileReader,
    fetch:globalThis.fetch,confirm:globalThis.confirm};
  const base=[],calls=[];
  const preview={importId:'53e5375c-093b-4767-a2d4-203d6bc1ad76',source:'Карьер.csv',count:3,
    groups:[{product:'Скала',count:2,tonnes:55.24,uniqueVehicles:1,dates:['2026-11-01']},
      {product:'СКАЛА +',count:1,tonnes:30,uniqueVehicles:1,dates:['2026-11-01']}],
    summary:{tonnes:85.24,unknownVehicles:['С301СВ']},errors:[],
    audit:{ready:false,count:3,totalTonnes:85.24,duplicates:[],critical:[{line:4,kind:'vehicle',message:'Требуется автомобиль С301СВ'}],needsReview:1},
    unknown:{'С301СВ':{plate:'С301СВ',model:'НЕТ В БАЗЕ',driver:'НЕТ В БАЗЕ'}},sample:[]};
  const fake=async(url,opts={})=>{
    const path=String(url),method=opts.method||'GET';calls.push({path,method});
    if(path==='/api/legion/base')return answer({vehicles:base});
    if(path==='/api/legion/reports')return answer({reports:[],folder:'C:\\TENSEI\\reports\\Легион'});
    if(path==='/api/legion/imports')return answer({imports:[]});
    if(path==='/api/legion/vehicle'&&method==='POST'){
      const input=JSON.parse(opts.body);
      base.push({plate:input.plate,displayPlate:input.plate,model:input.model,driver:input.driver});
      return answer({ok:true,count:base.length,vehicle:input});
    }
    if(path==='/api/legion/import-csv'&&method==='POST')return answer(preview);
    if(path==='/api/legion/import/'+preview.importId)return answer(preview);
    return answer({error:'Unexpected '+method+' '+path},404);
  };
  try{
    globalThis.window=dom.window;globalThis.document=dom.window.document;
    globalThis.FileReader=dom.window.FileReader;globalThis.fetch=fake;globalThis.confirm=()=>true;
    dom.window.HTMLElement.prototype.scrollIntoView=function(){};
    await import('../legion.js?test-navigation');
    const $=id=>dom.window.document.getElementById(id);
    await until(()=>$('legionBaseStatus').textContent.includes('0 автомобилей'));
    assert.equal($('photoWorkspace').hidden,false);
    $('navLegion').click();
    assert.equal($('photoWorkspace').hidden,true);
    assert.equal($('legionWorkspace').hidden,false);
    assert.equal($('navLegion').getAttribute('aria-current'),'page');
    $('legionPlate').value='Н508КО';
    $('legionModel').value='Scania';
    $('legionDriver').value='Мохнач З.Г.';
    $('legionVehicleForm').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    await until(()=>$('legionBaseStatus').textContent.includes('1 автомобилей'));
    assert.ok($('legionBaseList').textContent.includes('Н508КО'));
    $('legionAutoGenerate').checked=false;
    const file=new dom.window.File(['ТС;Товар;Дата оформления;Нетто\nН508КО;Скала;01.11.2026;33400'],
      'Карьер.csv',{type:'text/csv'});
    Object.defineProperty($('legionCsvFile'),'files',{configurable:true,value:[file]});
    $('legionCsvFile').dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    await until(()=>$('legionStatTrips').textContent==='3');
    assert.equal($('legionStatProducts').textContent,'2');
    assert.equal($('legionStatTons').textContent,'85,240');
    assert.equal($('legionPreview').hidden,false);
    assert.ok($('legionGroups').textContent.includes('СКАЛА +'));
    assert.ok($('legionAudit').textContent.includes('Требуется проверка'));
    assert.equal($('legionGenerate').disabled,true,'critical issues block auto report');
    assert.equal($('legionCsvFile').multiple,true);
    $('navPhoto').click();
    assert.equal($('photoWorkspace').hidden,false);
    assert.equal($('legionWorkspace').hidden,true);
    assert.ok(calls.some(x=>x.path==='/api/legion/vehicle'));
    assert.ok(calls.some(x=>x.path==='/api/legion/import-csv'));
  }finally{
    dom.window.close();
    for(const [k,v] of Object.entries(old)){if(v===undefined)delete globalThis[k];else globalThis[k]=v}
  }
});
