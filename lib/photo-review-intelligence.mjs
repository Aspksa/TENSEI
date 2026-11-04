import {fixBox} from './vision.mjs';
import {plateKey} from './legion.mjs';

const normalized=x=>String(x??'').normalize('NFKC').trim();
const integerCandidate=x=>{
  const value=normalized(x).replace(/[\s\u00a0]/g,'');
  return /^\d{1,6}$/.test(value)?Number(value):null;
};
export function handwritingCandidates(cells){
  return (Array.isArray(cells)?cells:[]).slice(0,400).map((c,index)=>{
    const bbox=fixBox(c.bbox);
    if(!bbox)return null;
    const text=normalized(c.text).slice(0,120);
    return {index,bbox,text,integer:integerCandidate(text),
      engine:normalized(c.engine||'local').slice(0,80),
      verified:false,score:Number.isFinite(c.score)?c.score:null};
  }).filter(Boolean);
}
// A hint is never an automatic substitution, particularly if OCR confuses 0/O or 8/B.
export function plateCandidates(reading,approved=[]){
  const raw=normalized(reading).toUpperCase().replace(/[\s\-_.]/g,'');
  const key=plateKey(raw),registry=new Set(approved.map(x=>plateKey(x)));
  const standard=/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/.test(key);
  return {raw,normalized:key,standard,known:registry.has(key),
    suggestions:standard&&registry.has(key)?[key]:[],verified:false};
}
export function findCrossSourceDuplicates(rows,history=[]){
  // Only duplicate suspects, never silently delete, merge or overwrite.
  const key=r=>[String(r.tripDate||''),String(r.time||''),plateKey(r.vehicle||''),
    r.tare??'',r.gross??'',r.net??''].join('|');
  const current=rows.map((row,index)=>({row,index,source:'current'}));
  const prior=history.map((row,index)=>({row,index,source:'history'}));
  const seen=new Map(),duplicates=[];
  for(const item of [...prior,...current]){
    const id=key(item.row);
    if(!item.row.tripDate||!item.row.vehicle||item.row.net==null||!item.row.time)continue;
    const other=seen.get(id);
    if(other&&other.source!==item.source)
      duplicates.push({index:item.index,priorIndex:other.index,
        type:'cross-source',verified:false});
    else if(other&&other.index!==item.index&&item.source==='current')
      duplicates.push({index:item.index,priorIndex:other.index,
        type:'within-batch',verified:false});
    else seen.set(id,item);
  }
  return duplicates;
}
export function detectUnruledColumns(lines,{minimumRows=3}={}){
  const boxes=(lines||[]).map(x=>({text:normalized(x.text),bbox:fixBox(x.bbox)}))
    .filter(x=>x.bbox&&x.text);
  if(boxes.length<minimumRows)return {columns:[],verified:false,reason:'too-few-located-lines'};
  // Candidate column anchors from actual observed x centers, no invented table values.
  const mid=boxes.map(x=>(x.bbox[0]+x.bbox[2])/2).sort((a,b)=>a-b);
  const groups=[];
  for(const x of mid){
    const last=groups.at(-1);
    if(last&&x-last.center<=.065){
      last.values.push(x);last.center=last.values.reduce((a,b)=>a+b,0)/last.values.length;
    }else groups.push({center:x,values:[x]});
  }
  return {columns:groups.filter(g=>g.values.length>=minimumRows)
      .map(g=>({center:Number(g.center.toFixed(4)),observations:g.values.length})).slice(0,20),
    verified:false,reason:'observed-text-anchors-only'};
}
export function detectEditMarks(lines){
  return (lines||[]).filter(x=>fixBox(x.bbox)&&/(^|[^а-яё])(?:исправлено|зачеркнуто|замена|ошибка)($|[^а-яё])/i.test(x.text||''))
    .slice(0,40).map(x=>({bbox:fixBox(x.bbox),text:String(x.text).slice(0,90),
      suspected:true,verified:false}));
}
export function reconcileRows(rows,detectedBands){
  const bands=(detectedBands||[]).map(fixBox).filter(Boolean);
  const positioned=(rows||[]).map(r=>fixBox(r.bbox)).filter(Boolean);
  const missing=bands.filter(b=>!positioned.some(r=>((r[1]+r[3])/2>=b[1]&&
    (r[1]+r[3])/2<=b[3])));
  return {detectedBands:bands.length,positionedRows:positioned.length,
    unmatchedBands:missing.slice(0,100),verified:false,
    note:'Среди пропусков могут быть заголовки, пустые строки и артефакты'};
}
export function reviewPriority(row,{vehicleKnown=true,duplicate=false}={}){
  const issues=[];
  if(row.uncertain)issues.push('OCR отметил неопределённость');
  if(row.net==null)issues.push('Нет значения нетто');
  if(row.gross!=null&&row.tare!=null&&row.net!=null&&
    Math.abs(Number(row.gross)-Number(row.tare)-Number(row.net))>1)
    issues.push('Брутто − тара ≠ нетто');
  if(!vehicleKnown)issues.push('ТС отсутствует в подтверждённой базе');
  if(duplicate)issues.push('Возможный повтор рейса');
  return {needsReview:issues.length>0,issues,verified:false};
}

export function tentativeCellsFromInk(rowBands,columnHints){
  const bands=(rowBands||[]).map(fixBox).filter(Boolean).slice(0,100);
  const columns=(columnHints?.columns||[]).map(c=>Number(c.center)).filter(c=>Number.isFinite(c)&&c>0&&c<1).sort((a,b)=>a-b);
  if(bands.length<2||columns.length<2)return {boxes:[],verified:false,reason:'not-enough-observed-anchors'};
  const limits=columns.map((x,i)=>[
    i===0?Math.max(0,x-(columns[1]-x)/2):(columns[i-1]+x)/2,
    i===columns.length-1?Math.min(1,x+(x-columns[i-1])/2):(x+columns[i+1])/2
  ]);
  const boxes=[];
  for(const band of bands)for(const [left,right] of limits){
    const box=fixBox([left,band[1],right,band[3]]);
    if(box)boxes.push(box);
    if(boxes.length>=400)break;
  }
  return {boxes,verified:false,reason:'hypothetical-cells-from-text-row-and-column-anchors'};
}
