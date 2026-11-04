export const DEFAULT_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';
export const MODELS = [
  {id:DEFAULT_MODEL,name:'Qwen3 VL 235B A22B — максимальная точность'},
  {id:'qwen/qwen3-vl-30b-a3b-instruct',name:'Qwen3 VL 30B A3B — экономичная'},
  {id:'qwen/qwen3-vl-8b-instruct',name:'Qwen3 VL 8B — быстрая'},
  {id:'Qwen/Qwen3.5-397B-A17B',name:'Qwen3.5 397B — внутренняя, Vision'},
  {id:'Qwen/Qwen3.6-35B-A3B',name:'Qwen3.6 35B — внутренняя, Vision'}
];
const trim=(v,max=180)=>String(v??'').trim().slice(0,max);
export function bounds(value){
  if(!Array.isArray(value)||value.length!==4)return null;
  let b=value.map(Number);if(b.some(v=>!Number.isFinite(v)))return null;
  if(b.some(x=>x>1)&&b.every(v=>v>=0&&v<=1000))b=b.map(x=>x/1000);
  return b.every(v=>v>=0&&v<=1)&&b[2]>b[0]&&b[3]>b[1]?b:null;
}
export function weight(v){
  if(v===null||v===undefined||String(v).trim()==='')return null;
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  let s=String(v).trim().replace(/[\s\u00a0]/g,'');
  if(/^\d{1,3}[.,]\d{3}$/.test(s))s=s.replace(/[.,]/g,'');
  else s=s.replace(',','.');
  return /^\d+(?:\.\d+)?$/.test(s)&&Number.isFinite(Number(s))?Number(s):null;
}
export function normalize(r={}){
  const tare=weight(r.tare),gross=weight(r.gross),net=weight(r.net);
  return {tripDate:trim(r.tripDate,20),time:trim(r.time,20),vehicle:trim(r.vehicle,50).toUpperCase(),driver:trim(r.driver,100),
    tare,gross,net:net??(tare!==null&&gross!==null&&gross>=tare?gross-tare:null),
    note:trim(r.note,400),source:trim(r.source,180),sourceId:/^[0-9a-f-]{36}$/i.test(String(r.sourceId||''))?String(r.sourceId):'',bbox:bounds(r.bbox),uncertain:Boolean(r.uncertain),reviewed:Boolean(r.reviewed)};
}
export function examine(rows){
  const seen=new Set();
  return rows.map((raw,i)=>{
    const r=normalize(raw),issues=[];
    if(r.uncertain&&!r.reviewed)issues.push('Неуверенное распознавание');
    if(!r.vehicle)issues.push('Не указан номер ТС');
    if(r.tripDate&&(!/^\\d{4}-\\d{2}-\\d{2}$/.test(r.tripDate)||Number.isNaN(Date.parse(r.tripDate))))
      issues.push('Некорректная дата рейса');
    if(r.time&&!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(r.time))issues.push('Некорректное время');
    if(r.gross===null&&r.net===null)issues.push('Нет веса');
    for(const [label,v] of [['Тара',r.tare],['Брутто',r.gross],['Нетто',r.net]]){
      if(v!==null&&(v<0||v>150000))issues.push(label+': значение вне диапазона');
    }
    if(r.tare!==null&&r.gross!==null&&r.gross<r.tare)issues.push('Брутто меньше тары');
    if(r.tare!==null&&r.gross!==null&&r.net!==null&&Math.abs(r.gross-r.tare-r.net)>1)issues.push('Брутто − тара не совпадает с нетто');
    if(r.net!==null&&r.net>45000)issues.push('Нетто больше 45 тонн — проверьте');
    if(r.net===0)issues.push('Нулевой вес');
    const fingerprint=[r.tripDate,r.time,r.vehicle,r.tare,r.gross,r.net].join('|');
    if(seen.has(fingerprint)&&r.vehicle)issues.push('Возможный дубль строки');
    seen.add(fingerprint);
    return {...r,issues,index:i};
  });
}
export function parseModel(text){
  if(typeof text!=='string')throw Error('Модель не вернула текст');
  let s=text.trim().replace(/^\x60{3}(?:json)?\s*/i,'').replace(/\s*\x60{3}$/,'');
  let obj;
  try{obj=JSON.parse(s)}catch{
    const a=s.indexOf('{'),b=s.lastIndexOf('}');
    if(a<0||b<a)throw Error('Модель вернула не JSON');
    try{obj=JSON.parse(s.slice(a,b+1))}catch{throw Error('Неверный JSON модели: попробуйте ещё раз')}
  }
  if(!obj||!Array.isArray(obj.rows))throw Error('В ответе модели нет rows');
  if(obj.rows.length>400)throw Error('Модель вернула слишком много строк');
  return obj.rows.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(x=>normalize({...x,reviewed:false}));
}
export function safeRows(rows,max=2500){
  if(!Array.isArray(rows)||rows.length>max)throw Error('Недопустимое количество строк');
  return examine(rows);
}
