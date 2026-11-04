const $=id=>document.getElementById(id),num=n=>Number(n||0).toLocaleString('ru-RU',{maximumFractionDigits:2}),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rows=[],tasks=[];
async function load(){try{const [d,t,m,g]=await Promise.all([fetch('/api/draft').then(r=>r.json()),fetch('/api/tasks').then(r=>r.json()),fetch('/api/ai-monitor').then(r=>r.json()),fetch('/api/photo-groups').then(r=>r.json())]);rows=d.rows||[];tasks=t.tasks||[];populate();draw();drawMonitor(m);drawPhotoGroups(g);$('state').textContent='Загружено '+rows.length+' записей';}catch(e){$('state').textContent='Ошибка: '+e.message}}
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
function populate(){for(const [id,key] of [['product','product'],['vehicle','vehicle']]){const select=$(id),value=select.value;select.replaceChildren(new Option('Все '+(id==='product'?'товары':'автомобили'),'all'));for(const x of [...new Set(rows.map(r=>String(r[key]||'').trim()).filter(Boolean))].sort())select.add(new Option(x,x));select.value=[...select.options].some(o=>o.value===value)?value:'all';}}
function tons(r){const n=Number(String(r.net??'').replace(',','.'));return Number.isFinite(n)&&n>0?n/1000:0;}
function dateOf(r){if(r.tripDate&&/^\d{4}-\d{2}-\d{2}$/.test(r.tripDate))return r.tripDate;const t=tasks.find(t=>t.sourceId&&t.sourceId===r.sourceId);return t?.startedAt?.slice(0,10)||null}
function graph(id,values){const el=$(id),max=Math.max(1,...values.map(x=>x[1]));el.innerHTML=values.length?values.map(([label,val])=>'<div class="barline"><span title="'+esc(label)+'">'+esc(label)+'</span><div class="track"><div class="fill" style="width:'+Math.max(0,100*val/max)+'%"></div></div><b>'+num(val)+'</b></div>').join(''):'<p class="hint">Нет данных</p>'}
function draw(){let filtered=rows.filter(r=>($('product').value==='all'||r.product===$('product').value)&&($('vehicle').value==='all'||r.vehicle===$('vehicle').value));const period=$('period').value,now=new Date(),cut=new Date(now);if(period!=='all')cut.setDate(cut.getDate()-Number(period)+1);const cutoff=cut.toISOString().slice(0,10);if(period!=='all')filtered=filtered.filter(r=>{const d=dateOf(r);return d&&d>=cutoff});const metric=$('metric').value,f=r=>metric==='tons'?tons(r):1;const total=filtered.reduce((s,r)=>s+tons(r),0);$('totalTons').textContent=num(total)+' т';$('totalTrips').textContent=num(filtered.length);$('activeVehicles').textContent=new Set(filtered.map(r=>r.vehicle).filter(Boolean)).size;$('avgTons').textContent=filtered.length?num(total/filtered.length)+' т':'—';
const group=(key)=>{const m=new Map();for(const r of filtered){const k=key(r);if(k)m.set(k,(m.get(k)||0)+f(r))}return [...m].sort((a,b)=>b[1]-a[1])};
graph('vehicles',group(r=>r.vehicle||'Без номера').slice(0,10));graph('products',group(r=>r.product||'Товар не указан'));graph('hours',group(r=>/^\d{1,2}:\d\d$/.test(r.time||'')?String(Number(r.time.split(':')[0])).padStart(2,'0')+':00':null).sort((a,b)=>a[0].localeCompare(b[0])));
const daily=group(dateOf).sort((a,b)=>a[0].localeCompare(b[0]));graph('daily',daily);
const dmap=new Map(daily);const cal=$('calendar');const start=new Date();start.setDate(start.getDate()-29);const max=Math.max(1,...daily.map(x=>x[1]));cal.innerHTML=Array.from({length:30},(_,i)=>{const date=new Date(start);date.setDate(start.getDate()+i);const day=date.toISOString().slice(0,10),v=dmap.get(day)||0,alpha=(.12+.78*v/max).toFixed(2);return '<div class="day '+(!v?'empty':'')+'" title="'+esc(day)+' — '+num(v)+'" style="background:rgba(88,170,250,'+alpha+')">'+date.getDate()+'</div>'}).join('');
$('tasks').innerHTML=tasks.slice(0,50).map(t=>{const phase=t.phase||t.status,trace=Array.isArray(t.trace)?t.trace:[],usage=t.usage||{},pct=t.status==='done'?100:t.status==='error'?100:t.progress||0;return '<details class="task"><summary><b>'+esc(t.name||'Фото')+'</b> · '+esc(phase)+' · '+esc(t.model||'модель не определена')+'</summary><div class="meter"><span style="width:'+Math.min(100,Math.max(0,pct))+'%"></span></div><small>Начало: '+esc(t.startedAt||'—')+' · облачных запросов: '+num(t.cloudCalls??t.attempts??0)+' · токены вход/выход: '+esc(usage.prompt_tokens??'нет данных')+'/'+esc(usage.completion_tokens??'нет данных')+'</small>'+(Array.isArray(t.modelUsage)?t.modelUsage.map(x=>'<p><small>Модель '+esc(x.model)+' · попытка '+esc(x.attempt)+' · токены '+esc(x.total_tokens??'нет данных')+'</small></p>').join(''):'')+trace.map(x=>'<p><small>'+esc(x.at||'')+' · '+esc(x.stage)+' · '+esc(x.module||'')+'</small></p>').join('')+(t.error?'<p class="error">'+esc(t.error)+'</p>':'')+'</details>'}).join('')||'<p class="hint">История пуста</p>';}
for(const id of ['metric','period','product','vehicle'])$(id).addEventListener('change',draw);$('reload').addEventListener('click',load);load();
// Update transport and AI cost statistics while the analytics screen is visible.
setInterval(()=>{if(!document.hidden)load()},45000);