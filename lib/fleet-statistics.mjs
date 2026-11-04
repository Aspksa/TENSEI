import {plateKey} from './legion.mjs';

// Single source of truth for fleet statistics. CSV is authoritative where
// imported; matching photo evidence never adds another trip. Conflicting and
// insufficiently identified rows are quarantined for operator review.
const date=value=>{
  const x=String(value||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x))return '';
  const d=new Date(x+'T00:00:00Z');
  return !Number.isNaN(+d)&&d.toISOString().slice(0,10)===x?x:'';
};
const time=value=>{
  const x=String(value||'').trim();
  return /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(x)?x.padStart(5,'0'):'';
};
const kg=value=>value!==''&&value!==null&&value!==undefined&&
  Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=150000?Number(value):null;
const string=(v,max=120)=>String(v??'').trim().slice(0,max);
const sourceRow=(row,from,importId,index)=>({
  from,importId,index,date:date(from==='csv'?row.date:row.tripDate),
  time:time(row.time),plate:plateKey(from==='csv'?row.plate:row.vehicle),
  netKg:kg(from==='csv'?row.netKg:row.net),
  product:string(row.product)||'Товар не указан',
  driver:string(from==='csv'?row.driverCsv:row.driver),
  id:string(row.id),source:string(from==='csv'?row.sourceFile:row.source),
  reviewed:row.reviewed===true
});
const tripKey=r=>[r.date,r.plate,r.time||'?',r.product,r.netKg,r.id||'?'].join('|');
const eventKey=r=>[r.date,r.plate,r.time].join('|');
// All imported CSV snapshots are handled as alternative copies of the same
// underlying trip, not as additive ledger transactions.
export function unifyFleet({imports=[],photoRows=[],vehicles=[]}={}){
  if(!Array.isArray(imports)||!Array.isArray(photoRows)||!Array.isArray(vehicles))
    throw Error('Invalid fleet inputs');
  const candidates=[],review=[],ledger=[],seen=new Map(),eventGroups=new Map();
  const sorted=[...imports].sort((a,b)=>String(b.importedAt||'').localeCompare(String(a.importedAt||'')));
  for(const file of sorted.slice(0,50)){
    if(!Array.isArray(file.rows))continue;
    for(const [index,row] of file.rows.slice(0,12000).entries()){
      const r=sourceRow(row,'csv',string(file.id,40),index);
      if(!r.date||!r.plate||r.netKg===null){
        review.push({...r,reason:'CSV: отсутствует дата, госномер или вес',status:'invalid'});
        continue;
      }
      const key=tripKey(r),copy=seen.get(key);
      if(copy){
        copy.imports.push(r.importId);
        copy.duplicateCopies++;
        continue;
      }
      const item={...r,imports:[r.importId],duplicateCopies:0,photoEvidence:0,
        status:'csv',counted:false,needsReview:false};
      candidates.push(item);seen.set(key,item);
      // Same vehicle at the same time with conflicting cargo or weights is
      // genuinely ambiguous and must not be added to totals.
      if(r.time){
        const event=eventKey(r);
        if(!eventGroups.has(event))eventGroups.set(event,[]);
        eventGroups.get(event).push(item);
      }
    }
  }
  const conflicts=new Set();
  for(const group of eventGroups.values())if(group.length>1){
    for(const r of group)conflicts.add(r);
  }
  const matched=new Map();
  const photos=photoRows.slice(0,2500).map((r,i)=>sourceRow(r,'photo','',i));
  for(const p of photos){
    if(!p.reviewed){review.push({...p,status:'unreviewed',reason:'Фото не подтверждено оператором'});continue}
    if(!p.date||!p.time||!p.plate||p.netKg===null){
      review.push({...p,status:'incomplete',reason:'Фото: для сверки нужны дата, время, ТС и нетто'});
      continue;
    }
    const options=candidates.filter(c=>c.date===p.date&&c.time===p.time&&
      c.plate===p.plate&&c.netKg===p.netKg);
    if(options.length===1&&!conflicts.has(options[0])){
      options[0].photoEvidence++;
      matched.set(p.index,options[0]);
      continue;
    }
    const sameEvent=candidates.some(c=>c.date===p.date&&c.time===p.time&&c.plate===p.plate);
    review.push({...p,status:options.length>1?'ambiguous':sameEvent?'weight-conflict':'photo-only',
      reason:options.length>1?'Несколько возможных совпадений CSV':
        sameEvent?'Вес или товар отличается от CSV':'Нет соответствующего рейса в CSV; не суммируется автоматически'});
  }
  for(const item of candidates){
    if(conflicts.has(item)){
      item.status='conflict';item.needsReview=true;
      review.push({...item,reason:'Противоречащие CSV-рейсы одного ТС в одно время'});
    }else{item.counted=true;ledger.push(item)}
  }
  // No CSV: only verified complete photo records may contribute; duplicates
  // remain excluded until an operator resolves them.
  if(candidates.length===0&&sorted.length===0){
    const photoSeen=new Map();
    for(const p of photos){
      if(!p.reviewed||!p.date||!p.time||!p.plate||p.netKg===null)continue;
      const k=[p.date,p.time,p.plate,p.netKg].join('|');
      if(photoSeen.has(k)){
        const previous=photoSeen.get(k);
        previous.counted=false;
        review.push({...p,status:'possible-duplicate',reason:'Второй подтверждённый фото-рейс с теми же реквизитами'});
        continue;
      }
      const entry={...p,status:'photo-only-verified',counted:true,photoEvidence:1,
        duplicateCopies:0,imports:[]};
      ledger.push(entry);photoSeen.set(k,entry);
    }
    for(let i=ledger.length-1;i>=0;i--)if(!ledger[i].counted){
      review.push({...ledger[i],status:'possible-duplicate',reason:'Требует разрешения дубля по фото'});
      ledger.splice(i,1);
    }
  }
  const byVehicle=new Map(vehicles.map(v=>[plateKey(v.plate),v]));
  for(const r of ledger){const v=byVehicle.get(r.plate);r.model=string(v?.model);r.driver=r.driver||string(v?.driver)}
  const totalKg=ledger.reduce((sum,r)=>sum+r.netKg,0);
  const cars=new Map(),products=new Map(),days=new Map();
  for(const r of ledger){
    const car=cars.get(r.plate)||{plate:r.plate,model:r.model,driver:r.driver,
      trips:0,netKg:0,products:{}};
    car.trips++;car.netKg+=r.netKg;car.products[r.product]=(car.products[r.product]||0)+r.netKg;
    cars.set(r.plate,car);
    products.set(r.product,(products.get(r.product)||0)+r.netKg);
    days.set(r.date,(days.get(r.date)||0)+r.netKg);
  }
  return {ledger,review:review.slice(0,3000),totals:{trips:ledger.length,netKg:totalKg,
    tonnes:totalKg/1000,vehicles:cars.size,avgTripTonnes:ledger.length?totalKg/1000/ledger.length:0,
    excluded:review.length,copyDuplicates:candidates.reduce((s,r)=>s+r.duplicateCopies,0),
    matchedPhotos:matched.size},
    vehicles:[...cars.values()].sort((a,b)=>b.netKg-a.netKg||a.plate.localeCompare(b.plate)),
    products:[...products].map(([name,netKg])=>({name,netKg})),
    daily:[...days].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,netKg])=>({date,netKg})),
    sourcePolicy:sorted.length?'csv-authoritative':'verified-photos-only',
    verified:false,
    note:'Совпадающие импорты не суммируются; противоречия исключены из итогов до проверки. Совпадение OCR с CSV не подтверждает точность фото.'};
}
export function fleetFiltered(data,{vehicle='all',product='all',from='',to=''}={}){
  const rows=(data.ledger||[]).filter(r=>
    (vehicle==='all'||r.plate===vehicle)&&(product==='all'||r.product===product)&&
    (!from||r.date>=from)&&(!to||r.date<=to));
  const totalKg=rows.reduce((n,r)=>n+r.netKg,0);
  const vehicles=new Map(),products=new Map(),dates=new Map(),hours=new Map();
  for(const r of rows){
    const x=vehicles.get(r.plate)||{plate:r.plate,model:r.model,driver:r.driver,trips:0,netKg:0};
    x.trips++;x.netKg+=r.netKg;vehicles.set(r.plate,x);
    const add=(map,key)=>{const x=map.get(key)||{netKg:0,trips:0};
      x.netKg+=r.netKg;x.trips++;map.set(key,x)};
    add(products,r.product);add(dates,r.date);
    if(r.time)add(hours,r.time.slice(0,2)+':00');
  }
  return {rows,totals:{trips:rows.length,netKg:totalKg,tonnes:totalKg/1000,
    vehicles:vehicles.size,avgTripTonnes:rows.length?totalKg/1000/rows.length:0},
    vehicles:[...vehicles.values()].sort((a,b)=>b.netKg-a.netKg),
    products:[...products].map(([name,values])=>({name,...values})),
    daily:[...dates].sort((a,b)=>a[0].localeCompare(b[0])).map(([date,values])=>({date,...values})),
    hours:[...hours].sort((a,b)=>a[0].localeCompare(b[0])).map(([hour,values])=>({hour,...values}))};
}
