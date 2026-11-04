// Fully local interactive SVG analytics. No Google Charts, no external fonts or networks.
const by=id=>document.getElementById(id);
const NS='http://www.w3.org/2000/svg';
const colors=['#168D94','#426DB2','#9A73CB','#DE995B','#5EAD77','#DB6983','#83A0C6','#A4B665','#B77962'];
const state={data:null,loading:false,loaded:false};
const format=(n,digits=0)=>Number(n||0).toLocaleString('ru-RU',{minimumFractionDigits:digits,maximumFractionDigits:digits});
function node(tag,attrs={},label){
  const el=document.createElementNS(NS,tag);
  for(const [key,value] of Object.entries(attrs))if(value!==null&&value!==undefined)el.setAttribute(key,String(value));
  if(label!==undefined)el.textContent=String(label);
  return el;
}
function label(svg,text,x,y,options={}){
  const item=node('text',{x,y,fill:options.fill||'#74869B','font-size':options.size||12,
    'font-weight':options.bold?700:400,'text-anchor':options.anchor||'start',
    'font-family':'Segoe UI,system-ui,sans-serif'},text);
  svg.append(item);return item;
}
function title(el,text){
  el.append(node('title',{},text));return el;
}
function clickable(el,callback){
  el.setAttribute('tabindex','0');el.setAttribute('role','button');el.style.cursor='pointer';
  el.addEventListener('click',callback);
  el.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();callback()}});
  return el;
}
function svg(container,w=640,h=245){
  const box=by(container);box.replaceChildren();
  const root=node('svg',{viewBox:'0 0 '+w+' '+h,width:'100%',height:'100%',
    preserveAspectRatio:'xMidYMid meet','role':'img','aria-label':'Векторный график, данные из локальных CSV'});
  box.append(root);return root;
}
function empty(id,message){
  const box=by(id);box.replaceChildren();
  const element=document.createElement('div');element.className='analytics-chart-empty';
  element.textContent=message||'Нет данных в выбранном периоде';
  box.append(element);
}
function info(message,kind='info'){const el=by('analyticsNotice');el.hidden=!message;el.textContent=message;el.className='notice '+kind}
function dimensions(values,max=undefined){return Math.max(1,max||Math.max(0,...values))}
function drawGrid(root,{left=52,top=20,width=540,height=174,max=1,steps=4,unit=''}={}){
  for(let i=0;i<=steps;i++){
    const y=top+height-i*height/steps;
    root.append(node('line',{x1:left,y1:y,x2:left+width,y2:y,stroke:'#dce6ef','stroke-dasharray':i?'4 5':'none'}));
    label(root,format(max*i/steps,max<10?1:0)+unit,left-10,y+4,{anchor:'end',size:10});
  }
}
function lineChart(id,items,{metric='tonnes',compare=[],height=234,clickDate=true}={}){
  if(!items.length)return empty(id,'Здесь появится динамика после импорта CSV. Выберите период, в котором были рейсы.');
  const root=svg(id,640,height),left=55,top=17,w=550,h=height-72;
  const series=[items,...(compare.length?[compare]:[])];
  const max=dimensions(series.flatMap(x=>x.map(p=>p[metric]||0)));
  drawGrid(root,{left,top,width:w,height:h,max});
  const plot=(data,color,dashed)=>{
    const points=data.map((p,i)=>{
      const x=left+(data.length===1?w/2:(i*w/(data.length-1)));
      return [x,top+h-h*(Number(p[metric]||0)/max),p];
    });
    const line=points.map((v,i)=>(i?'L':'M')+v[0].toFixed(2)+','+v[1].toFixed(2)).join(' ');
    root.append(node('path',{d:line,fill:'none',stroke:color,'stroke-width':3,
      'stroke-linecap':'round','stroke-linejoin':'round',
      'stroke-dasharray':dashed?'7 6':null}));
    for(const [x,y,p] of points){
      const circle=node('circle',{cx:x,cy:y,r:4.2,fill:'#fff',stroke:color,'stroke-width':2.2});
      title(circle,p.date+': '+format(p[metric],metric==='tonnes'?3:0)+(metric==='tonnes'?' т':' рейсов'));
      if(clickDate&&!dashed)clickable(circle,()=>showDetails('period',p.date));
      root.append(circle);
    }
  };
  plot(items,colors[0],false);
  if(compare.length)plot(compare,colors[1],true);
  const step=Math.max(1,Math.ceil(items.length/6));
  items.forEach((p,i)=>{
    if(i%step===0||i===items.length-1)label(root,p.date.slice(5),left+(items.length===1?w/2:i*w/(items.length-1)),top+h+21,{anchor:'middle',size:10});
  });
  if(compare.length){
    const caption=node('g');
    caption.append(node('line',{x1:left+4,y1:height-12,x2:left+29,y2:height-12,stroke:colors[0],'stroke-width':3}));
    caption.append(node('line',{x1:left+165,y1:height-12,x2:left+190,y2:height-12,stroke:colors[1],'stroke-width':3,'stroke-dasharray':'6 4'}));
    root.append(caption);
    label(root,'Основной период',left+36,height-8,{size:10});
    label(root,'Период сравнения',left+198,height-8,{size:10});
  }
}
function horizontalBars(id,data,{metric='tonnes',onClick=null,maxBars=10,unit='',names=x=>x.name||x.key||''}={}){
  if(!data.length)return empty(id,'Недостаточно данных для отображения списка.');
  const rows=data.slice(0,maxBars),h=Math.max(188,rows.length*32+23),w=590;
  const root=svg(id,w,h),max=dimensions(rows.map(v=>v[metric]));
  rows.forEach((v,i)=>{
    const y=10+i*32,barW=395*(v[metric]||0)/max,name=names(v);
    label(root,name.length>17?name.slice(0,15)+'…':name,5,y+17,{size:11,bold:true,fill:'#53677F'});
    const bg=node('rect',{x:134,y:y+4,width:395,height:17,rx:6,fill:'#edf2f7'}),bar=node('rect',{
      x:134,y:y+4,width:Math.max(barW,0),height:17,rx:6,fill:colors[i%colors.length]});
    title(bar,name+' · '+format(v[metric],metric==='tonnes'||metric==='avgTonnes'?3:0)+' '+unit);
    if(onClick)clickable(bar,()=>onClick(v));
    root.append(bg,bar);
    label(root,format(v[metric],metric==='tonnes'||metric==='avgTonnes'?2:0),538,y+18,{size:11,bold:true,fill:'#38546E'});
    if(onClick)clickable(label(root,'↗',575,y+18,{size:13,fill:colors[0]}),()=>onClick(v));
  });
}
function donut(id,data){
  if(!data.length)return empty(id,'Состав грузов появится после загрузки CSV.');
  const sorted=[...data].sort((a,b)=>b.tonnes-a.tonnes);
  const main=sorted.slice(0,7),other=sorted.slice(7);
  if(other.length)main.push({key:'Прочие ('+other.length+')',tonnes:other.reduce((s,x)=>s+x.tonnes,0),trips:other.reduce((s,x)=>s+x.trips,0),isOther:true});
  const total=main.reduce((sum,r)=>sum+r.tonnes,0);
  const root=svg(id,580,260),cx=132,cy=128,r=83,length=2*Math.PI*r;
  root.append(node('circle',{cx,cy,r,fill:'none',stroke:'#edf2f7','stroke-width':32}));
  let offset=0;
  if(total){
    main.forEach((x,i)=>{
      const fract=x.tonnes/total,seg=node('circle',{cx,cy,r,fill:'none',stroke:colors[i%colors.length],
        'stroke-width':32,'stroke-dasharray':(fract*length)+' '+((1-fract)*length),
        'stroke-dashoffset':-offset*length,transform:'rotate(-90 '+cx+' '+cy+')'});
      title(seg,x.key+' — '+format(x.tonnes,3)+' т ('+format(fract*100,1)+'%)');
      if(!x.isOther)clickable(seg,()=>filterProduct(x.key));
      root.append(seg);offset+=fract;
    });
  }
  label(root,format(total,1),cx,cy-1,{size:27,bold:true,anchor:'middle',fill:'#27445D'});
  label(root,'тонн нетто',cx,cy+21,{size:12,anchor:'middle'});
  main.forEach((x,i)=>{
    const y=29+i*31;
    root.append(node('rect',{x:270,y:y-10,width:12,height:12,rx:4,fill:colors[i%colors.length]}));
    const t=label(root,x.key.length>23?x.key.slice(0,21)+'…':x.key,291,y,{size:12,fill:'#52677F',bold:true});
    title(t,x.key);
    label(root,format(total?x.tonnes/total*100:0,1)+'%',560,y,{size:11,bold:true,anchor:'end',fill:'#365774'});
    if(!x.isOther)clickable(t,()=>filterProduct(x.key));
  });
}
function calendar(id,days,month,metric='tonnes'){
  if(!month)return empty(id,'Выберите месяц в календаре.');
  const monthStart=new Date(month+'-01T12:00:00Z');
  if(Number.isNaN(monthStart.getTime()))return empty(id,'Некорректный месяц.');
  const year=monthStart.getUTCFullYear(),m=monthStart.getUTCMonth();
  const count=new Date(Date.UTC(year,m+1,0)).getUTCDate();
  const start=(monthStart.getUTCDay()+6)%7;
  const cells=new Map(days.map(x=>[x.date,x]));
  const max=dimensions(days.filter(x=>x.date.startsWith(month)).map(x=>x[metric]||0));
  const root=svg(id,560,320),x0=57,y0=38,sw=66,sh=38;
  ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach((x,i)=>label(root,x,x0+i*sw+23,21,{anchor:'middle',size:12,bold:true}));
  for(let day=1;day<=count;day++){
    const index=start+day-1,col=index%7,row=Math.floor(index/7);
    const key=year+'-'+String(m+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
    const record=cells.get(key);
    const amount=record?.[metric]||0;
    const opacity=amount?(.13+.78*amount/max):0.04;
    const rect=node('rect',{x:x0+col*sw,y:y0+row*sh,width:56,height:31,rx:7,
      fill:'#168D94','fill-opacity':opacity,stroke:amount?'#cce7e8':'#dfe6eb'});
    title(rect,key+': '+format(amount,metric==='tonnes'?3:0)+(metric==='tonnes'?' т':' рейсов'));
    clickable(rect,()=>showDetails('date',key));root.append(rect);
    label(root,day,x0+col*sw+28,y0+row*sh+20,{anchor:'middle',size:12,
      bold:amount>max*.55,fill:amount>max*.55?'#fff':'#3d576e'});
  }
  label(root,'Выберите день, чтобы открыть его рейсы',58,299,{size:11});
}
function histogram(id,bins){
  if(!bins?.length||bins.every(x=>!x.count))return empty(id,'Для гистограммы нужны рейсы с указанным весом.');
  const root=svg(id,610,254),left=55,top=20,w=520,h=175,max=dimensions(bins.map(x=>x.count));
  drawGrid(root,{left,top,width:w,height:h,max});
  const bw=w/bins.length-6;
  bins.forEach((bin,i)=>{
    const bh=bin.count/max*h;
    const rect=node('rect',{x:left+i*w/bins.length+3,y:top+h-bh,width:bw,
      height:Math.max(0,bh),rx:4,fill:colors[i%colors.length]});
    title(rect,format(bin.from,1)+'–'+format(bin.to,1)+' т · '+bin.count+' рейсов');
    clickable(rect,()=>showDetails('weight',{from:bin.from,to:bin.to,last:i===bins.length-1}));
    root.append(rect);
    if(i%2===0)label(root,format(bin.from,0),left+(i+.5)*w/bins.length,top+h+21,{anchor:'middle',size:10});
  });
  label(root,'Диапазоны тонн нетто →',left,238,{size:11});
}
function hourly(id,items){
  if(!items?.some(x=>x.trips))return empty(id,'В загруженных CSV нет времени рейсов. График появится, когда файл будет содержать время.');
  const metric=by('analyticsMetric').value;
  const root=svg(id,620,250),left=46,top=18,w=548,h=169,max=dimensions(items.map(x=>x[metric]));
  drawGrid(root,{left,top,width:w,height:h,max});
  const bw=w/24-5;
  items.forEach((r,i)=>{
    const height=r[metric]/max*h,element=node('rect',{
      x:left+i*w/24+2.5,y:top+h-height,width:bw,height,rx:3,
      fill:i>=8&&i<18?colors[0]:colors[1]});
    title(element,String(i).padStart(2,'0')+':00 — '+format(r.trips)+' рейсов · '+format(r.tonnes,3)+' т');
    root.append(element);
    if(i%3===0)label(root,i+':00',left+(i+.5)*w/24,top+h+20,{anchor:'middle',size:10});
  });
  label(root,'Утро и день',left,243,{size:10,fill:colors[0]});
}
function renderFleet(data){
  const s=data.truckUtilization;
  if(!s.active)return empty('chartFleet','Сначала импортируйте CSV с госномерами автомобилей.');
  const root=svg('chartFleet',590,255);
  label(root,'В среднем рейсов на машину',14,21,{size:12});
  label(root,format(s.avgTrips,1),14,53,{size:27,bold:true,fill:colors[0]});
  label(root,'Средний вес рейса',290,21,{size:12});
  label(root,format(s.avgWeight,2)+' т',290,53,{size:27,bold:true,fill:colors[1]});
  root.append(node('line',{x1:12,y1:70,x2:578,y2:70,stroke:'#e4edf3'}));
  label(root,'Самые активные',13,96,{size:12,bold:true,fill:'#46627C'});
  label(root,'Редко используются',305,96,{size:12,bold:true,fill:'#46627C'});
  for(const [group,startX] of [[s.busiest,13],[s.quietest,305]]){
    group.slice(0,5).forEach((r,i)=>{
      const y=120+i*25;
      label(root,r.key,startX,y,{size:11,fill:'#435d73'});
      label(root,r.trips+' рейс.',startX+265,y,{size:11,anchor:'end',fill:colors[i%colors.length]});
      clickable(root.lastChild,()=>showDetails('vehicle',r.key));
    });
  }
}
function dataQuality(data){
  const root=svg('chartDataQuality',580,230);
  const k=data.kpi,src=data.source;
  const rows=[
    {name:'Время заполнено',value:k.trips?k.timeKnown/k.trips:0,description:format(k.timeKnown)+' / '+k.trips+' рейсов'},
    {name:'Машины с данными',value:k.trips?(k.trips-k.modelMissing)/k.trips:0,description:format(k.trips-k.modelMissing)+' / '+k.trips},
    {name:'Без замечаний',value:k.trips?(k.trips-k.issues)/k.trips:0,description:format(k.trips-k.issues)+' / '+k.trips},
    {name:'CSV без пропусков',value:src.importedRows+src.skippedCsvRows?
      src.importedRows/(src.importedRows+src.skippedCsvRows):0,
      description:src.skippedCsvRows+' пропущено'}
  ];
  if(!k.trips)return empty('chartDataQuality','Нет загруженных CSV для оценки качества.');
  rows.forEach((row,i)=>{
    const y=18+i*51;
    label(root,row.name,13,y,{size:12,bold:true,fill:'#476178'});
    label(root,format(row.value*100,0)+'% · '+row.description,558,y,{size:11,anchor:'end'});
    root.append(node('rect',{x:13,y:y+8,width:545,height:13,rx:6,fill:'#eaf0f6'}));
    root.append(node('rect',{x:13,y:y+8,width:545*row.value,height:13,rx:6,fill:colors[i]}));
  });
}
function scanHealth(data){
  const root=svg('chartScanHealth',560,210),s=data.source;
  if(!s.scannedPhotos)return empty('chartScanHealth','Нет сканов. Добавьте фотографию в разделе «Распознавание фото».');
  const items=[{key:'Сохранено всего',value:s.scannedPhotos},{key:'Успешно прочитано',value:s.photoOk},
    {key:'С ошибкой OCR',value:s.photoErrors}];
  items.forEach((v,i)=>{
    const y=20+i*53,max=s.scannedPhotos;
    label(root,v.key,16,y,{size:12,bold:true,fill:'#4d667e'});
    label(root,v.value,537,y,{size:13,bold:true,anchor:'end',fill:colors[i]});
    root.append(node('rect',{x:16,y:y+9,width:522,height:16,rx:8,fill:'#eaf0f6'}));
    root.append(node('rect',{x:16,y:y+9,width:522*v.value/max,height:16,rx:8,fill:colors[i]}));
  });
  label(root,'Оригиналы сохраняются локально даже при ошибке распознавания',16,197,{size:11});
}
function showDetails(type,value){
  const data=state.data;if(!data)return;
  let titleText='Детализация',list=data.vehicleDetails;
  if(type==='vehicle'){list=list.filter(x=>x.plate===value);titleText='Рейсы машины '+value}
  else if(type==='date'){list=list.filter(x=>x.date===value);titleText='Рейсы за '+value}
  else if(type==='period'){
    const period=by('analyticsPeriod').value;
    list=list.filter(x=>period==='month'?x.date.startsWith(value):
      period==='week'?x.date>=value&&x.date<=shiftDay(value,6):x.date===value);
    titleText='Период '+value;
  }else if(type==='issue'){list=list.filter(x=>x.issues.includes(value));titleText='Проверка: '+value}
  else if(type==='weight'){list=list.filter(x=>x.netKg/1000>=value.from&&(value.last?
    x.netKg/1000<=value.to:x.netKg/1000<value.to));titleText='Рейсы '+value.from+'–'+value.to+' т'}
  else if(type==='allIssues'){list=list.filter(x=>x.issues.length);titleText='Все проблемные записи'}
  const box=by('analyticsDetailPanel'),tbody=by('analyticsDetailRows');
  tbody.replaceChildren();by('analyticsDetailTitle').textContent=titleText+' · '+list.length+' строк';
  for(const r of list.slice(0,150)){
    const tr=document.createElement('tr');
    for(const value of [r.date,r.time||'—',r.plate,r.product,format(r.netKg,0),r.issues.join(' · ')||'—']){
      const td=document.createElement('td');td.textContent=value;tr.append(td)
    }
    tbody.append(tr);
  }
  box.hidden=false;box.scrollIntoView?.({behavior:'smooth',block:'nearest'});
}
function shiftDay(d,delta){const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+delta);return x.toISOString().slice(0,10)}
function filterProduct(product){by('analyticsProduct').value=product;void load()}
by('analyticsHideDetails').onclick=()=>by('analyticsDetailPanel').hidden=true;
function render(data){
  state.data=data;
  const k=data.kpi,source=data.source;
  by('akTonnes').textContent=format(k.tonnes,2);
  by('akTrips').textContent=format(k.trips);
  by('akVehicles').textContent=format(k.vehicles);
  by('akAvg').textContent=format(k.avgTonnes,2);
  by('akIssues').textContent=format(k.issues);
  by('analyticsSource').textContent='Источник: '+source.files+' уникальных CSV · '+source.importedRows+
    ' рейсов импортировано · '+source.dedupedFiles+' повторных импортов исключено · '+
    source.scannedPhotos+' сканов в локальной библиотеке.';
  const selected=by('analyticsProduct').value;
  by('analyticsProduct').replaceChildren();
  const def=document.createElement('option');def.value='';def.textContent='Все товары';by('analyticsProduct').append(def);
  for(const name of source.allProducts){
    const option=document.createElement('option');option.value=name;option.textContent=name;
    by('analyticsProduct').append(option);
  }
  if(source.allProducts.includes(selected))by('analyticsProduct').value=selected;
  if(!by('analyticsMonth').value&&source.availableDates?.length)
    by('analyticsMonth').value=source.availableDates.at(-1).slice(0,7);
  const metric=by('analyticsMetric').value;
  lineChart('chartTrend',data.trend,{metric,compare:data.comparison?.trend||[],height:265});
  horizontalBars('chartVehicles',
    [...data.topVehicles].sort((a,b)=>b[by('analyticsVehicleMetric').value]-a[by('analyticsVehicleMetric').value]),
    {metric:by('analyticsVehicleMetric').value,unit:metric==='tonnes'?'т':'',
      names:r=>r.plate,onClick:r=>showDetails('vehicle',r.plate)});
  donut('chartProducts',data.products);
  calendar('chartCalendar',data.calendar,by('analyticsMonth').value,metric);
  renderFleet(data);
  hourly('chartHours',data.hours);
  horizontalBars('chartAnomalies',data.anomalies.categories,{metric:'count',maxBars:8,
    names:r=>r.label,onClick:r=>showDetails('issue',r.label),unit:'замечаний'});
  histogram('chartWeights',data.weights.bins);
  lineChart('chartCumulative',data.cumulative,{metric:'tonnes',height:250,clickDate:true});
  horizontalBars('chartWeekdays',data.daysOfWeek.map(x=>({...x,key:x.day})),
    {metric,names:r=>r.day,maxBars:7});
  dataQuality(data);
  scanHealth(data);
}
async function load(){
  if(state.loading)return;state.loading=true;
  by('analyticsRefresh').disabled=true;
  try{
    const q=new URLSearchParams();
    for(const [key,id] of [['from','analyticsFrom'],['to','analyticsTo'],['period','analyticsPeriod'],
      ['product','analyticsProduct'],['compareFrom','analyticsCompareFrom'],
      ['compareTo','analyticsCompareTo']]){
      if(by(id)?.value)q.set(key,by(id).value);
    }
    const response=await fetch('/api/analytics?'+q.toString());
    const result=await response.json();
    if(!response.ok)throw Error(result.error||'Ошибка аналитики');
    state.loaded=true;render(result);info('');
  }catch(e){info('Аналитика не загрузилась: '+e.message,'error')}
  finally{state.loading=false;by('analyticsRefresh').disabled=false}
}
by('analyticsRefresh').onclick=load;
for(const id of ['analyticsFrom','analyticsTo','analyticsPeriod','analyticsProduct',
  'analyticsCompareFrom','analyticsCompareTo']){
  by(id).addEventListener('change',()=>void load());
}
for(const id of ['analyticsMetric','analyticsVehicleMetric','analyticsMonth']){
  by(id).addEventListener('change',()=>{if(state.data)render(state.data)});
}
by('analyticsCompareReset').onclick=()=>{
  by('analyticsCompareFrom').value='';by('analyticsCompareTo').value='';void load();
};
document.addEventListener('tensei:page',event=>{
  if(event.detail?.page==='analytics')void load();
});
window.addEventListener('tensei:legion-updated',()=>{if(!by('analyticsWorkspace').hidden)void load()});
