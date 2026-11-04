import {createHash} from 'node:crypto';
import {fixBox} from './vision.mjs';

// Diagnostics only. Equal OCR strings are not proof of correctness or row identity.
export function localOcrConsensus(localOcr,secondary=null){
  const candidates=(localOcr?.recognizedCells||[]).filter(c=>fixBox(c.bbox)&&typeof c.text==='string');
  const other=Array.isArray(secondary?.recognizedCells)?secondary.recognizedCells:[];
  const normalize=x=>String(x||'').normalize('NFKC').replace(/[\s\u00a0]+/g,'').toUpperCase();
  return candidates.slice(0,400).map(c=>{
    const box=fixBox(c.bbox);
    const matches=other.filter(d=>{
      const b=fixBox(d.bbox);
      if(!b)return false;
      const mid=[(box[0]+box[2])/2,(box[1]+box[3])/2];
      return mid[0]>=b[0]&&mid[0]<=b[2]&&mid[1]>=b[1]&&mid[1]<=b[3];
    });
    const agreed=matches.length===1&&normalize(matches[0].text)===normalize(c.text);
    return {bbox:box,reading:c.text.slice(0,200),agree:agreed,
      readers:matches.length?2:1,verified:false,
      confidence:typeof c.confidence==='number'?c.confidence:null};
  });
}
export function missingRowEvidence(rows,layout){
  const located=(rows||[]).map(r=>fixBox(r.gridRowBox||r.bbox)).filter(Boolean);
  const regions=(layout?.rows||[]).map(fixBox).filter(Boolean);
  const missing=[];
  for(let i=0;i<regions.length;i++){
    const band=regions[i],center=(band[1]+band[3])/2;
    const compatible=located.some(box=>{
      const overlap=Math.max(0,Math.min(box[3],band[3])-Math.max(box[1],band[1]));
      const height=Math.max(1e-6,band[3]-band[1]);
      return overlap/height>=.35 || (center>=box[1]&&center<=box[3]);
    });
    if(!compatible)missing.push({gridIndex:i,bbox:band});
  }
  return {detected:regions.length,located:located.length,
    unmatched:missing.slice(0,150),incomplete:missing.length>0,
    note:'Строки без надёжного координатного соответствия; возможны заголовки и пустые строки'};
}
export function classifyFromLayout(layout,localOcr,templates=[]){
  const lines=(localOcr?.lines||[]).map(x=>String(x.text||'').toLowerCase()).join(' ').slice(0,12000);
  const weight=/(нетто|брутто|тара|вес|тонн|кг|госномер)/.test(lines);
  const hasGrid=Array.isArray(layout?.cells)&&layout.cells.length>=4;
  const suggested=weight?'weights':null;
  return {suggestedTemplate:suggested,
    evidence:weight?'local-header-terms':hasGrid?'table-grid':'none',
    confirmed:false,confidence:null,
    availableTemplates:(templates||[]).filter(t=>t?.id===suggested).map(t=>t.id)};
}
export function photoBatchMetadata(name,rows,startedAt){
  const dateCandidates=(rows||[]).map(r=>r.tripDate).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(String(x||'')));
  const date=dateCandidates.length>0&&dateCandidates.length===(rows||[]).length&&
    [...new Set(dateCandidates)].length===1?dateCandidates[0]:null;
  const file=String(name||'').replace(/[\\/]/g,'_').slice(0,160);
  return {file,date,dateSource:date?'recognized-row':'not-verified',
    groupKey:date||'undated',requiresDateReview:!date,
    sortKey:(date||'9999-99-99')+'|'+file.toLowerCase(),
    importedAt:startedAt||null};
}
export function cellCacheKey(imageBytes,box,engine){
  const b=fixBox(box);if(!b)throw Error('Invalid cell geometry');
  return createHash('sha256').update(imageBytes).update(JSON.stringify(b))
    .update(String(engine||'local')).digest('hex');
}
export function validatedCellEntry(value,{reviewed=false,box,engine='local'}={}){
  const bbox=fixBox(box);
  if(!reviewed||!bbox||typeof value!=='string'||!value.trim())return null;
  return {text:value.slice(0,180),bbox,engine,verified:true};
}
