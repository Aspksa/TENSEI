import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {classifyTrips,reportSummary,plateKey} from './legion.mjs';

const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T12:00:00Z'));
const dateISO=d=>new Date(d+'T12:00:00Z');
const shiftDate=(d,n)=>{const x=dateISO(d);x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
const number=n=>Math.round((Number(n)||0)*1000)/1000;
function periodKey(day,period){
  if(period==='month')return day.slice(0,7);
  if(period==='week'){
    const d=dateISO(day),weekday=(d.getUTCDay()+6)%7;
    d.setUTCDate(d.getUTCDate()-weekday);
    return d.toISOString().slice(0,10);
  }
  return day;
}
function groupTime(rows,period){
  const values=new Map();
  for(const r of rows){
    const key=periodKey(r.date,period),item=values.get(key)||{date:key,tonnes:0,trips:0};
    item.trips++;item.tonnes+=r.netKg/1000;values.set(key,item);
  }
  return [...values.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(x=>({...x,tonnes:number(x.tonnes)}));
}
function bucket(rows,getKey,name){
  const values=new Map();
  for(const r of rows){
    const key=getKey(r),item=values.get(key)||{key,name:name?.(r)||key,tonnes:0,trips:0};
    item.tonnes+=r.netKg/1000;item.trips++;values.set(key,item);
  }
  return [...values.values()].map(x=>({...x,tonnes:number(x.tonnes),
    avgTonnes:number(x.tonnes/x.trips)}));
}
export function analyzeTrips(rawRows,options={},context={}){
  const from=validDate(options.from)?options.from:'';
  const to=validDate(options.to)?options.to:'';
  const product=String(options.product||'').slice(0,120);
  const plate=plateKey(options.plate||'');
  const period=['day','week','month'].includes(options.period)?options.period:'day';
  const rows=rawRows.filter(r=>validDate(r.date)&&r.netKg!==null&&Number.isFinite(r.netKg)&&r.netKg>=0)
    .filter(r=>(!from||r.date>=from)&&(!to||r.date<=to)&&(!product||r.product===product)
      &&(!plate||r.plate===plate));
  const totalTonnes=number(rows.reduce((acc,r)=>acc+r.netKg/1000,0));
  const vehicleMap=bucket(rows,x=>x.plate);
  const top=vehicleMap.map(x=>{
    const sample=rows.find(r=>r.plate===x.key);
    return {...x,plate:x.key,model:sample?.model||'',driver:sample?.driver||''};
  }).sort((a,b)=>b.tonnes-a.tonnes).slice(0,600);
  const allVehicles=vehicleMap.sort((a,b)=>b.trips-a.trips);
  const products=bucket(rows,x=>x.product).sort((a,b)=>b.tonnes-a.tonnes)
    .map(x=>({...x,percent:totalTonnes?number(x.tonnes/totalTonnes*100):0}));
  const days=groupTime(rows,'day');
  const cumulative=[];let running=0;
  for(const day of days){running+=day.tonnes;cumulative.push({date:day.date,tonnes:number(running),trips:day.trips})}
  const hourMap=new Map();
  for(let i=0;i<24;i++)hourMap.set(i,{hour:i,trips:0,tonnes:0});
  let timesKnown=0;
  for(const r of rows){
    const hour=/^([01]\d|2[0-3]):[0-5]\d/.exec(String(r.time||''));
    if(!hour)continue;
    const item=hourMap.get(Number(hour[1]));item.trips++;item.tonnes+=r.netKg/1000;timesKnown++;
  }
  const hours=[...hourMap.values()].map(x=>({...x,tonnes:number(x.tonnes)}));
  const weekdayMap=Array.from({length:7},(_,i)=>({day:weekdays[i],trips:0,tonnes:0}));
  for(const r of rows){
    const idx=(dateISO(r.date).getUTCDay()+6)%7;
    weekdayMap[idx].trips++;weekdayMap[idx].tonnes+=r.netKg/1000;
  }
  for(const x of weekdayMap)x.tonnes=number(x.tonnes);
  const issues=new Map(),issueRows=[];
  for(const r of rows){
    if(!r.issues?.length)continue;
    for(const issue of new Set(r.issues))issues.set(issue,(issues.get(issue)||0)+1);
    if(issueRows.length<250)issueRows.push({date:r.date,plate:r.plate,product:r.product,
      netKg:r.netKg,issues:r.issues.slice(0,10),id:r.id});
  }
  const tonnes=rows.map(r=>r.netKg/1000).sort((a,b)=>a-b);
  const weights=[];
  const maxWeight=Math.max(0,...tonnes.slice(-1));
  const ceiling=Math.max(10,Math.ceil(maxWeight/5)*5);
  const width=ceiling/10;
  for(let i=0;i<10;i++){
    const lo=i*width,hi=(i+1)*width;
    weights.push({from:number(lo),to:number(hi),count:tonnes.filter(v=>v>=lo&&(i===9?v<=hi:v<hi)).length});
  }
  const quantile=q=>tonnes.length?tonnes[Math.floor((tonnes.length-1)*q)]:0;
  const q1=quantile(.25),q3=quantile(.75),iqr=q3-q1;
  const outliers=rows.filter(r=>tonnes.length>=8&&(r.netKg/1000<Math.max(0,q1-1.5*iqr)
    ||r.netKg/1000>q3+1.5*iqr)).slice(0,70)
    .map(r=>({date:r.date,plate:r.plate,netKg:r.netKg,product:r.product}));
  let comparison=null;
  const compareFrom=validDate(options.compareFrom)?options.compareFrom:'';
  const compareTo=validDate(options.compareTo)?options.compareTo:'';
  if(compareFrom&&compareTo&&compareFrom<=compareTo){
    const prev=rawRows.filter(r=>validDate(r.date)&&r.date>=compareFrom&&r.date<=compareTo
      &&(!product||r.product===product)&&(!plate||r.plate===plate)&&Number.isFinite(r.netKg));
    comparison={from:compareFrom,to:compareTo,trips:prev.length,
      tonnes:number(prev.reduce((sum,r)=>sum+r.netKg/1000,0)),
      trend:groupTime(prev,period)};
  }
  return {
    filters:{from,to,period,product,plate,compareFrom,compareTo},
    source:{files:context.files||0,dedupedFiles:context.dedupedFiles||0,
      importedRows:context.importedRows||0,skippedCsvRows:context.skippedCsvRows||0,
      scannedPhotos:context.scannedPhotos||0,photoOk:context.photoOk||0,photoErrors:context.photoErrors||0,
      availableDates:[...new Set(rawRows.filter(x=>validDate(x.date)).map(x=>x.date))].sort(),
      allProducts:[...new Set(rawRows.map(x=>x.product).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ru'))},
    kpi:{trips:rows.length,tonnes:totalTonnes,vehicles:vehicleMap.length,products:products.length,
      avgTonnes:rows.length?number(totalTonnes/rows.length):0,activeDays:days.length,
      issues:rows.filter(x=>x.issues?.length).length,timeKnown:timesKnown,
      modelMissing:rows.filter(r=>r.model==='НЕТ В БАЗЕ'||r.driver==='НЕТ В БАЗЕ').length},
    trend:groupTime(rows,period),comparison,topVehicles:top,products,
    calendar:days,daysOfWeek:weekdayMap,hours,truckUtilization:{
      active:vehicleMap.length,avgTrips:vehicleMap.length?number(rows.length/vehicleMap.length):0,
      avgWeight:rows.length?number(totalTonnes/rows.length):0,
      busiest:allVehicles.slice(0,5),quietest:[...allVehicles].sort((a,b)=>a.trips-b.trips).slice(0,5)},
    anomalies:{categories:[...issues].map(([label,count])=>({label,count})).sort((a,b)=>b.count-a.count),
      rows:issueRows},
    weights:{bins:weights,min:tonnes[0]||0,max:tonnes.at(-1)||0,median:number(quantile(.5)),outliers},
    cumulative,vehicleDetails:rows.slice(0,1500).map(r=>({date:r.date,time:r.time,plate:r.plate,product:r.product,
      netKg:r.netKg,id:r.id,issues:r.issues?.slice(0,3)||[]})),
    generatedAt:new Date().toISOString()
  };
}
export async function loadLegionStats(dataDir,{maxFiles=60}={}){
  const dir=path.join(dataDir,'legion'),index=path.join(dir,'imports-index.json');
  let imports=[];
  try{imports=JSON.parse(await fs.readFile(index,'utf8'))}
  catch(e){if(e.code!=='ENOENT')throw e}
  if(!Array.isArray(imports))imports=[];
  let list=[],dedupedFiles=0,skippedCsvRows=0,importedRows=0;
  const seen=new Set();
  for(const item of imports.slice(0,maxFiles)){
    if(!/^[0-9a-f-]{36}$/i.test(String(item.id||'')))continue;
    try{
      const entry=JSON.parse(await fs.readFile(path.join(dir,'imports',item.id+'.json'),'utf8'));
      if(!Array.isArray(entry.rows))continue;
      const hash=entry.contentHash||createHash('sha256').update(JSON.stringify(entry.rows)).digest('hex');
      if(seen.has(hash)){dedupedFiles++;continue}
      seen.add(hash);importedRows+=entry.rows.length;
      skippedCsvRows+=entry.errors?.length||0;list.push(entry);
    }catch(e){if(e.code!=='ENOENT')throw e}
  }
  let vehicles=[];
  try{vehicles=JSON.parse(await fs.readFile(path.join(dir,'vehicles.json'),'utf8'))}
  catch(e){if(e.code!=='ENOENT')throw e}
  const trips=[];
  for(const entry of list)trips.push(...classifyTrips(entry.rows,vehicles));
  let scanCount=0,photoOk=0,photoErrors=0;
  try{
    const scans=JSON.parse(await fs.readFile(path.join(dataDir,'scans','index.json'),'utf8'));
    if(Array.isArray(scans)){scanCount=scans.length;photoOk=scans.filter(x=>x.status==='done').length;
      photoErrors=scans.filter(x=>x.status==='error').length}
  }catch(e){if(e.code!=='ENOENT')throw e}
  return {trips,context:{files:list.length,dedupedFiles,importedRows,skippedCsvRows,
    scannedPhotos:scanCount,photoOk,photoErrors}};
}
