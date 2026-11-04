const $=id=>document.getElementById(id);
const num=n=>Number(n||0).toLocaleString('ru-RU',{maximumFractionDigits:3});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let snapshot=null,tasks=[],requestToken=0;
function drawPhotoGroups(data){
  const items=(data.groups||[]).slice(0,40);
  $('photoGroups').innerHTML=items.length?items.map(g=>'<p><strong>'+esc(g.groupKey==='undated'?'Без даты':g.groupKey)+'</strong> · '+num(g.files)+' фото · '+num(g.rows)+' строк</p>').join(''):'<p class="hint">Обработанных фотографий пока нет.</p>';
}
function drawMonitor(data){
  const metrics=[
    ['Обработано фото',num(data.photos)],
    ['Ошибки обработки',num(data.failedPhotos)],
    ['Запросы к Cloud.ru',num(data.cloudCalls)],
    ['Учтено токенов',num(data.totalReportedTokens)],
    ['В очереди',num(data.queuePending)],
    ['Покрытие токенов',data.tokenCoverage==null?'—':num(data.tokenCoverage*100)+'%']
  ];
  $('aiMonitor').innerHTML=metrics.map(([k,v])=>'<article><small>'+esc(k)+'</small><strong>'+esc(v)+'</strong></article>').join('');
  const events=Array.isArray(data.recentWatchEvents)?data.recentWatchEvents:[];
  $('watchEvents').innerHTML='<p class="hint">Наблюдаемая папка: '+(data.watchEnabled?'включена':'выключена')+
    ' · Файлов в истории: '+num(data.watchedFileCount)+
    '. Денежная стоимость не рассчитана без подтверждённых тарифов.</p>'+
    events.slice(0,12).map(e=>'<p><small>'+esc(e.at||'')+' · '+esc(e.name||'')+' · '+
      esc(e.type||'')+(e.error?' · '+esc(e.error):'')+'</small></p>').join('');
}

function dateFilter(){
  if($('period').value==='all')return '';
  const d=new Date();
  d.setHours(12,0,0,0);
  d.setDate(d.getDate()-Number($('period').value)+1);
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}
function query(){
  return new URLSearchParams({vehicle:$('vehicle').value,product:$('product').value,
    from:dateFilter(),to:''});
}
function populate(catalog){
  for(const [id,values,all] of [
    ['product',catalog?.products||[],'Все товары'],
    ['vehicle',catalog?.vehicles||[],'Все автомобили']
  ]){
    const el=$(id),old=el.value;
    el.replaceChildren(new Option(all,'all'));
    for(const value of values.sort())el.add(new Option(value,value));
    el.value=[...el.options].some(o=>o.value===old)?old:'all';
  }
}
function graph(id,values){
  const el=$(id),max=Math.max(1,...values.map(x=>x[1]));
  el.innerHTML=values.length?values.map(([label,value])=>'<div class="barline"><span title="'+
    esc(label)+'">'+esc(label)+'</span><div class="track"><div class="fill" style="width:'+
    (100*value/max).toFixed(2)+'%"></div></div><b>'+num(value)+'</b></div>').join(''):
    '<p class="hint">Нет записей за выбранный период.</p>';
}
function draw(){
  if(!snapshot)return;
  const data=snapshot,metric=$('metric').value,scale=x=>metric==='tons'?x.netKg/1000:x.trips;
  $('totalTons').textContent=num(data.totals.tonnes)+' т';
  $('totalTrips').textContent=num(data.totals.trips);
  $('activeVehicles').textContent=num(data.totals.vehicles);
  $('avgTons').textContent=data.totals.trips?num(data.totals.avgTripTonnes)+' т':'—';
  $('sourcePolicy').textContent=data.sourcePolicy==='csv-authoritative'?
    'Источник итога: CSV «Легиона». Совпадающие фото добавляются как свидетельства, а не отдельные рейсы.':
    'Источник итога: подтверждённые строки фото (CSV ещё не загружен).';
  $('auditNotice').textContent='На проверку: '+num(data.audit.excluded)+
    ' записей · повторных копий CSV: '+num(data.audit.copyDuplicates)+
    ' · фото, сопоставленных с CSV: '+num(data.audit.matchedPhotos)+
    '. Спорные записи исключены из итогов.';
  const values=(list,key='netKg')=>list.map(x=>[x.plate||x.name||x.date||x.hour,
    metric==='tons'?Number(x[key]||0)/1000:Number(x.trips||0)]);
  graph('vehicles',values(data.vehicles.slice(0,10)));
  graph('products',data.products.map(x=>[x.name,scale(x)]));
  graph('hours',data.hours.map(x=>[x.hour,scale(x)]));
  graph('daily',data.daily.map(x=>[x.date,scale(x)]));
  const perDay=new Map(data.daily.map(x=>[x.date,scale(x)]));
  const top=Math.max(1,...data.daily.map(x=>scale(x)));
  const start=new Date();start.setHours(12,0,0,0);start.setDate(start.getDate()-29);
  $('calendar').innerHTML=Array.from({length:30},(_,i)=>{
    const date=new Date(start);date.setDate(date.getDate()+i);
    const day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),
      String(date.getDate()).padStart(2,'0')].join('-');
    const value=perDay.get(day)||0,alpha=(.12+.78*value/top).toFixed(2);
    return '<div class="day '+(!kg?'empty':'')+'" title="'+esc(day)+' — '+
      num(value)+(metric==='tons'?' т':' рейсов')+'" style="background:rgba(88,170,250,'+alpha+')">'+date.getDate()+'</div>';
  }).join('');
  const tbody=$('fleetTable');tbody.replaceChildren();
  for(const car of data.vehicles){
    const tr=document.createElement('tr');
    for(const value of [car.plate,car.model||'—',car.driver||'—',car.trips,
      num(car.netKg/1000),num(car.trips?car.netKg/1000/car.trips:0)]){
      const td=document.createElement('td');td.textContent=String(value);tr.append(td);
    }
    tr.tabIndex=0;tr.title='Показать рейсы автомобиля';
    tr.onclick=()=>{$('vehicle').value=car.plate;void load(false);};
    tr.onkeydown=e=>{if(e.key==='Enter')tr.click();};
    tbody.append(tr);
  }
  $('fleetTableEmpty').hidden=data.vehicles.length>0;
  const trips=$('fleetTrips');trips.replaceChildren();
  for(const item of data.trips.slice(0,150)){
    const tr=document.createElement('tr');
    for(const v of [item.date,item.time||'—',item.plate,item.product,
      num(item.netKg/1000),item.from==='csv'?'Легион':'Фото',item.photoEvidence||0]){
      const td=document.createElement('td');td.textContent=String(v);tr.append(td);
    }
    trips.append(tr);
  }
  $('tripPreviewInfo').textContent='Показано до 150 рейсов. '+(data.tripsTruncated?
    'Предпросмотр ограничен 2 000 строками, итоги рассчитаны по всему отбору.':'');
  $('reviewList').replaceChildren();
  for(const item of data.review.slice(0,40)){
    const p=document.createElement('p');
    p.textContent=[item.date||'Без даты',item.plate||'Без ТС',item.netKg??'—',
      item.reason||item.status].join(' · ');
    $('reviewList').append(p);
  }
  if(!data.review.length)$('reviewList').textContent='Нет обнаруженных замечаний.';
}
async function load(resetCatalog=false){
  const token=++requestToken;
  try{
    const [r,t,m,g]=await Promise.all([
      fetch('/api/fleet/stats?'+query()),
      fetch('/api/tasks').then(r=>r.json()),
      fetch('/api/ai-monitor').then(r=>r.json()),
      fetch('/api/photo-groups').then(r=>r.json())
    ]);
    const data=await r.json();
    if(!r.ok)throw Error(data.error||'HTTP '+r.status);
    if(token!==requestToken)return;
    snapshot=data;tasks=t.tasks||[];
    if(resetCatalog)populate(data.catalog);
    draw();drawMonitor(m);drawPhotoGroups(g);drawTasks();
    $('state').textContent='Учтено '+num(data.totals.trips)+' рейсов · '+num(data.totals.tonnes)+' т';
  }catch(e){if(token===requestToken)$('state').textContent='Ошибка статистики: '+e.message}
}
function drawTasks(){
  $('tasks').innerHTML=tasks.slice(0,50).map(t=>{
    const usage=t.usage||{},phase=t.phase||t.status;
    const percent=t.status==='done'||t.status==='error'?100:t.progress||0;
    return '<details class="task"><summary><b>'+esc(t.name||'Фото')+'</b> · '+esc(phase)+
      '</summary><div class="meter"><span style="width:'+
      Math.min(100,Math.max(0,percent))+'%"></span></div><small>Облачные запросы: '+
      num(t.cloudCalls??t.attempts??0)+' · токены: '+esc(usage.total_tokens??'нет данных')+
      '</small>'+(t.error?'<p class="error">'+esc(t.error)+'</p>':'')+'</details>';
  }).join('')||'<p class="hint">История пуста</p>';
}
for(const id of ['metric','period','product','vehicle']){
  $(id).addEventListener('change',()=>{if(id==='metric')draw();else void load(false)});
}
$('reload').addEventListener('click',()=>load(true));
$('exportFleet').addEventListener('click',()=>{
  const a=document.createElement('a');a.href='/api/fleet/export?'+query();
  a.download='TENSEI_Автопарк.xlsx';document.body.append(a);a.click();a.remove();
});
void load(true);
setInterval(()=>{if(!document.hidden)void load(false)},45000);
