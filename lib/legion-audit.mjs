import {createHash} from 'node:crypto';
import {plateKey} from './legion.mjs';

// Duplicate candidates, never silently merged or deleted.
export function tripIdentity(r){
  const fields=[r.date,r.time||'',plateKey(r.plate),r.product,r.id,r.netKg];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export function inspectLegionTrips(rows,vehicles=[]){
  const known=new Map(vehicles.map(v=>[plateKey(v.plate),v]));
  const seen=new Map(),duplicates=[],critical=[],warnings=[];
  for(let i=0;i<rows.length;i++){
    const r=rows[i],fingerprint=tripIdentity(r);
    if(seen.has(fingerprint))duplicates.push({line:r.line,firstLine:seen.get(fingerprint),plate:r.plate,
      date:r.date,product:r.product});
    else seen.set(fingerprint,r.line);
    const item=known.get(plateKey(r.plate));
    if(!item||!String(item.model||'').trim()||!String(item.driver||'').trim())
      critical.push({line:r.line,kind:'vehicle',message:'Не подтверждена модель или водитель ТС '+r.plate});
    const gross=r.grossKg,tare=r.tareKg,net=r.netKg;
    if(gross!=null&&tare!=null&&Math.abs(gross-tare-net)>1)
      critical.push({line:r.line,kind:'weight',message:'Брутто − тара не совпадает с нетто'});
    if(net>45000)critical.push({line:r.line,kind:'weight',message:'Нетто больше 45 т'});
    if(!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/.test(plateKey(r.plate)))
      critical.push({line:r.line,kind:'plate',message:'Нестандартный госномер'});
    if((r.issues||[]).some(issue=>/рассчитано/.test(issue)))
      warnings.push({line:r.line,message:'Нетто рассчитано из брутто и тары'});
  }
  const kg=rows.reduce((s,r)=>s+Number(r.netKg||0),0);
  return {count:rows.length,totalKg:kg,totalTonnes:kg/1000,duplicates,
    critical,notices:warnings,ready:duplicates.length===0&&critical.length===0,
    needsReview:duplicates.length+critical.length};
}
export function crossFileDuplicates(batch,prior=[]){
  const seen=new Map(),duplicates=[];
  for(const [fileIndex,file] of [...prior,...batch].entries()){
    for(const row of file.rows||[]){
      const fingerprint=tripIdentity(row),old=seen.get(fingerprint);
      if(old)duplicates.push({file:file.name,line:row.line,
        originalFile:old.file,originalLine:old.line});
      else seen.set(fingerprint,{file:file.name,line:row.line});
    }
  }
  return duplicates;
}
export function totalReconciliation(rows,groups){
  const expected=rows.reduce((sum,r)=>sum+Number(r.netKg||0),0);
  const actual=groups.reduce((sum,g)=>sum+g.rows.reduce((s,r)=>s+Number(r.netKg||0),0),0);
  const count=groups.reduce((s,g)=>s+g.rows.length,0);
  return {sourceKg:expected,reportKg:actual,sourceCount:rows.length,reportCount:count,
    matches:Math.abs(expected-actual)<=0.000001&&rows.length===count};
}
export function suggestVehicle(plate,vehicles){
  const key=plateKey(plate);
  const match=vehicles.find(v=>plateKey(v.plate)===key);
  return match?{plate:key,model:match.model||'',driver:match.driver||'',source:'approved-vehicle-base'}:
    {plate:key,model:null,driver:null,source:'unknown-needs-review'};
}
