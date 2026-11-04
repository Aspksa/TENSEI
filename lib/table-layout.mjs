import {fixBox} from './vision.mjs';

export function alignRowsByGeometry(records,regions){
  if(!Array.isArray(records)||!Array.isArray(regions))return records;
  const boxes=regions.map(fixBox).filter(Boolean);
  if(!boxes.length)return records;
  return records.map(record=>{
    const current=fixBox(record.bbox);
    if(!current)return record; // Never invent a row location from list ordering.
    const centerY=(current[1]+current[3])/2;
    const candidates=boxes.filter(box=>centerY>=box[1]&&centerY<=box[3]&&
      current[0]<box[2]&&current[2]>box[0]);
    if(candidates.length!==1)return record;
    const selected=candidates[0];
    // Align only when the OCR's own box and the grid agree spatially.
    const intersect=Math.max(0,Math.min(selected[3],current[3])-Math.max(selected[1],current[1]));
    const union=Math.max(selected[3],current[3])-Math.min(selected[1],current[1]);
    if(union<=0||intersect/union<.25)return record;
    return {...record,gridRowBox:selected};
  });
}
export function completeRecoveryBands(rows){
  // Group up to 4 crops covering *all* rows; don't silently skip the tail.
  const sorted=(Array.isArray(rows)?rows:[]).map(fixBox).filter(Boolean).sort((a,b)=>a[1]-b[1]);
  if(sorted.length<2)return [[0,0,1,.5],[0,.5,1,1]];
  const count=Math.min(4,sorted.length);
  const groups=[];
  for(let i=0;i<count;i++){
    const begin=Math.floor(i*sorted.length/count);
    const end=Math.floor((i+1)*sorted.length/count);
    const section=sorted.slice(begin,end);
    if(!section.length)continue;
    const upper=i===0?0:(sorted[begin-1][3]+section[0][1])/2;
    const lower=i===count-1?1:(section.at(-1)[3]+sorted[end][1])/2;
    const band=fixBox([0,Math.max(0,upper-.005),1,Math.min(1,lower+.005)]);
    if(band)groups.push(band);
  }
  return groups.length?groups:[[0,0,1,.5],[0,.5,1,1]];
}
