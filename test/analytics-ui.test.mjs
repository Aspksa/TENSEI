import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {analyzeTrips} from '../lib/analytics.mjs';
import {classifyTrips} from '../lib/legion.mjs';
const markup=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const trips=classifyTrips([
  {id:'1',date:'2026-11-01',time:'08:30',plate:'А905УО',product:'Скала',netKg:27240,issues:[]},
  {id:'2',date:'2026-11-01',time:'11:30',plate:'А905УО',product:'Скала',netKg:28000,issues:[]},
  {id:'3',date:'2026-11-02',time:'16:30',plate:'С301СВ',product:'СКАЛА +',netKg:30000,issues:[]}
],[{plate:'А905УО',model:'FAW',driver:'Иванов'}]);
const wait=async check=>{
  for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,20))}
  throw Error('Analytics UI did not update');
};
test('SVG analytics shows grounded metrics, native product labels, chart details and filters',async()=>{
  const dom=new JSDOM(markup,{url:'http://127.0.0.1:5556/',pretendToBeVisual:true});
  const old={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
  const requests=[];
  try{
    globalThis.document=dom.window.document;globalThis.window=dom.window;
    globalThis.fetch=async url=>{
      requests.push(String(url));
      const params=new URL(String(url),'http://127.0.0.1:5556/').searchParams;
      const data=analyzeTrips(trips,{
        from:params.get('from'),to:params.get('to'),period:params.get('period'),
        product:params.get('product'),compareFrom:params.get('compareFrom'),
        compareTo:params.get('compareTo')
      },{files:1,importedRows:3,scannedPhotos:2,photoOk:1,photoErrors:1});
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
    await import('../analytics.js?unit-svg-dashboard');
    const $=id=>dom.window.document.getElementById(id);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('tensei:page',{detail:{page:'analytics'}}));
    await wait(()=>$('akTrips').textContent==='3');
    assert.equal($('akTonnes').textContent,'85,24');
    assert.equal($('akVehicles').textContent,'2');
    for(const id of ['chartTrend','chartVehicles','chartProducts','chartCalendar','chartFleet',
      'chartHours','chartAnomalies','chartWeights','chartCumulative','chartWeekdays',
      'chartDataQuality','chartScanHealth']){
      assert.ok($(id).querySelector('svg'),id+' is an actual vector chart');
    }
    assert.ok($('chartProducts').textContent.includes('СКАЛА +'));
    const first=dom.window.document.querySelector('#chartVehicles svg [role="button"]');
    assert.ok(first);
    first.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
    assert.equal($('analyticsDetailPanel').hidden,false);
    assert.ok($('analyticsDetailTitle').textContent.includes('А905УО'));
    $('analyticsProduct').value='СКАЛА +';
    $('analyticsProduct').dispatchEvent(new dom.window.Event('change',{bubbles:true}));
    await wait(()=>$('akTrips').textContent==='1');
    assert.ok(requests.some(x=>x.includes('product=%D0%A1%D0%9A%D0%90%D0%9B%D0%90')));
  }finally{
    dom.window.close();
    for(const [key,value] of Object.entries(old)){if(value===undefined)delete globalThis[key];else globalThis[key]=value}
  }
});
