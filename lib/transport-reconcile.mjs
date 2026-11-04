import {plateKey} from './legion.mjs';

// Comparison never edits or de-duplicates source rows. Date and time are required
// for exact matching; a missing dimension means "needs review", not "no trip".
const isoDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?String(value):'';
const hhmm=value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value||''))?String(value):'';
const kg=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?
  Number(value):null;
const plate=value=>plateKey(value||'');
function photoRecord(row,index){
  return {index,source:'photo',date:isoDate(row.tripDate),time:hhmm(row.time),
    plate:plate(row.vehicle),netKg:kg(row.net),tareKg:kg(row.tare),
    grossKg:kg(row.gross),reviewed:row.reviewed===true,
    sourceId:String(row.sourceId||''),name:String(row.source||'').slice(0,160)};
}
function csvRecord(row,index){
  return {index,source:'csv',date:isoDate(row.date),time:hhmm(row.time),
    plate:plate(row.plate),netKg:kg(row.netKg),tareKg:kg(row.tareKg),
    grossKg:kg(row.grossKg),reviewed:false,product:String(row.product||'').slice(0,120),
    invoice:String(row.id||'').slice(0,80)};
}
function exactKey(r){return [r.date,r.time,r.plate].join('|')}
function fingerprint(r){return [r.date,r.time,r.plate,r.netKg].join('|')}
export function reconcilePhotoCsv(photoRows,csvRows,{limit=1500}={}){
  if(!Array.isArray(photoRows)||!Array.isArray(csvRows))throw Error('Expected both row arrays');
  if(photoRows.length>12000||csvRows.length>12000)throw Error('Too many rows for reconciliation');
  const photos=photoRows.map(photoRecord).slice(0,limit);
  const csv=csvRows.map(csvRecord).slice(0,limit);
  const byTrip=new Map(),byPlateDate=new Map(),csvDuplicates=new Map();
  for(const r of csv){
    if(r.date&&r.plate){
      const k=r.date+'|'+r.plate;
      byPlateDate.set(k,[...(byPlateDate.get(k)||[]),r]);
    }
    if(!r.date||!r.time||!r.plate||r.netKg===null)continue;
    const key=exactKey(r);
    byTrip.set(key,[...(byTrip.get(key)||[]),r]);
    const fp=fingerprint(r);csvDuplicates.set(fp,(csvDuplicates.get(fp)||0)+1);
  }
  const checked=[],used=new Set();
  for(const p of photos){
    const base={photoIndex:p.index,photo:p,status:'needs-review',reason:'',candidates:[],
      verified:false}; // "matched" means keys agree, not that handwriting is correct.
    if(!p.date||!p.time||!p.plate||p.netKg===null){
      base.reason='Недостаточно даты, времени, госномера или нетто для строгой сверки';
    }else{
      const candidates=byTrip.get(exactKey(p))||[];
      base.candidates=candidates.slice(0,5).map(r=>({csvIndex:r.index,date:r.date,
        time:r.time,plate:r.plate,netKg:r.netKg,product:r.product}));
      if(candidates.length===1&&candidates[0].netKg===p.netKg){
        const hit=candidates[0];
        base.status=(csvDuplicates.get(fingerprint(hit))||0)>1?'duplicate':'candidate-match';
        base.reason=base.status==='duplicate'?'Несколько одинаковых CSV-рейсов':'Дата, время, ТС и нетто совпадают';
        used.add(hit.index);
      }else if(candidates.length>1){
        base.status='duplicate';base.reason='Несколько CSV-рейсов с одинаковым ключом';
      }else if(candidates.length===1){
        base.status='weight-mismatch';base.reason='Нетто фотографии отличается от CSV';
      }else if(byPlateDate.has(p.date+'|'+p.plate)){
        base.status='time-mismatch';base.reason='Есть рейсы этого ТС за эту дату, но время не совпадает';
      }else{
        base.status='not-found';base.reason='Нет соответствующей записи в выбранном CSV';
      }
    }
    checked.push(base);
  }
  const unmatchedCsv=csv.filter(r=>!used.has(r.index)).map(r=>({index:r.index,date:r.date,
    time:r.time,plate:r.plate,netKg:r.netKg,product:r.product})).slice(0,limit);
  const totals={photoKg:photos.reduce((s,r)=>s+(r.netKg||0),0),
    csvKg:csv.reduce((s,r)=>s+(r.netKg||0),0)};
  const counts={photos:photos.length,csv:csv.length,matched:checked.filter(r=>r.status==='candidate-match').length,
    mismatched:checked.filter(r=>['weight-mismatch','time-mismatch','not-found'].includes(r.status)).length,
    ambiguous:checked.filter(r=>['needs-review','duplicate'].includes(r.status)).length,
    unmatchedCsv:unmatchedCsv.length};
  return {counts,totals,rows:checked,unmatchedCsv,
    complete:counts.matched===photos.length&&unmatchedCsv.length===0&&
      photos.length===csv.length,verified:false,
    note:'Совпадение реквизитов не подтверждает правильность OCR; исходный CSV и фото не изменяются'};
}
export function timeSequenceWarnings(rows){
  const warnings=[];
  const minutes=time=>{const t=hhmm(time);return t?Number(t.slice(0,2))*60+Number(t.slice(3)):null};
  const previous=new Map();
  (rows||[]).forEach((r,i)=>{
    const date=isoDate(r.tripDate||r.date),vehicle=plate(r.vehicle||r.plate);
    const minute=minutes(r.time);
    if(!date||!vehicle||minute===null)return;
    const k=date+'|'+vehicle,old=previous.get(k);
    if(old&&old.minute>minute)
      warnings.push({index:i,previousIndex:old.index,type:'out-of-order',
        note:'Время этого ТС идёт назад внутри выбранного порядка строк'});
    else if(old&&old.minute===minute)
      warnings.push({index:i,previousIndex:old.index,type:'same-minute',
        note:'Для одного ТС есть две записи в одну минуту'});
    previous.set(k,{minute,index:i});
  });
  return warnings.slice(0,200);
}
