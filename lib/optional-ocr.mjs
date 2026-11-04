import {fixBox,rowBands} from './vision.mjs';

const isLocal=url=>{
  try{const u=new URL(url);return u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&(!u.username&&!u.password)}
  catch{return false}
};
function safeEndpoint(value,defaultValue){
  const url=String(value||defaultValue).replace(/\/+$/,'');
  if(!isLocal(url))throw Error('OCR-сервер должен работать на localhost, без внешнего адреса');
  return url;
}
async function callLocal(url,body,timeout=45000){
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),timeout);
  try{
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:control.signal});
    const txt=await res.text();
    if(!res.ok)throw Error('Локальный OCR HTTP '+res.status+': '+txt.slice(0,150));
    try{return JSON.parse(txt)}catch{throw Error('Локальный OCR вернул не JSON')}
  }catch(e){if(e.name==='AbortError')throw Error('Локальный OCR не ответил вовремя');throw e}
  finally{clearTimeout(timer)}
}
export function normalizePaddle(response,width,height){
  const res=response?.res||response?.result||response||{};
  const w=Number(width||res.width),h=Number(height||res.height);
  if(!(w>0&&h>0))throw Error('Неизвестные размеры фотографии для OCR-разметки');
  const source=res.cells||res.boxes||res.cell_boxes||res.cellBoxes||
    res.table_res_list?.flatMap(x=>x.cell_box_list||[])||[];
  const cells=source.map(b=>{
    let raw=Array.isArray(b)?b:Array.isArray(b?.box)?b.box:Array.isArray(b?.coordinate)?b.coordinate:null;
    if(!raw)return null;
    if(raw.length>4&&Array.isArray(raw[0])){const xs=raw.map(p=>Number(p[0])),ys=raw.map(p=>Number(p[1]));raw=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]}
    if(raw.length!==4)return null;
    const box=raw.map(Number);
    if(box.every(x=>x>=0&&x<=1))return fixBox(box);
    return fixBox([box[0]/w,box[1]/h,box[2]/w,box[3]/h]);
  }).filter(Boolean).slice(0,1200);
  const regions=Array.isArray(res.row_boxes)?res.row_boxes.map(fixBox).filter(Boolean):rowBands(cells);
  const columns=Array.isArray(res.column_boxes)?res.column_boxes.map(fixBox).filter(Boolean):[];
  return {cells,rows:regions,columns,
    engine:String(res.engine||'PaddleOCR / PP-StructureV3').slice(0,90),
    method:String(res.method||'pp-structure').slice(0,40),
    confidence:typeof res.confidence==='number'&&Number.isFinite(res.confidence)?res.confidence:null,
    available:cells.length>0||regions.length>0};
}
export async function analyzePaddle(image,{width,height,url='http://127.0.0.1:8765'}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8765');
  const raw=await callLocal(address+'/analyze',{image},90000);
  return normalizePaddle(raw,width,height);
}
export async function analyzeLocalGrid(image,{width,height,url='http://127.0.0.1:8765'}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8765');
  const raw=await callLocal(address+'/segment',{image},90000);
  return normalizePaddle(raw,width,height);
}

export async function analyzeChandra(image,{url='http://127.0.0.1:8000/v1',model='chandra'}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8000/v1');
  const result=await callLocal(address+'/chat/completions',{
    model,temperature:0,max_tokens:10000,
    messages:[{role:'user',content:[{type:'text',text:'Transcribe this document accurately. Preserve its rows and table layout in Markdown or HTML; do not invent unreadable digits.'},
      {type:'image_url',image_url:{url:image}}]}]
  },125000);
  const text=result?.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw Error('Chandra не вернула распознанный текст');
  return {engine:'Chandra OCR 2',text:text.slice(0,30000)};
}
export function compareRowsWithChandra(rows,text){
  if(!text)return {checked:false,differences:[],info:'Нет вывода Chandra'};
  const raw=String(text).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const digits=(raw.match(/\b\d{1,3}(?:[ .,]\d{3})+\b|\b\d{4,7}\b/g)||[]).map(x=>x.replace(/[^\d]/g,'')).filter(x=>x.length>=4);
  // This is only an advisory candidate list, not a claim of cell-by-cell agreement.
  if(digits.length<3)return {checked:false,differences:[],info:'Chandra выдала недостаточно чисел для сравнения',raw:text.slice(0,8000)};
  const differences=[];
  rows.forEach((row,index)=>{
    for(const key of ['tare','gross','net']){
      const n=row[key];if(n===null||n===undefined)continue;
      const val=String(Math.trunc(Number(n)));if(val.length<4)continue;
      if(!digits.includes(val))differences.push({index,field:key,value:val});
    }
  });
  return {checked:true,differences:differences.slice(0,150),raw:text.slice(0,8000),
    info:'Предварительная проверка присутствия цифр в другом распознавании; порядок и соответствие ячеек требуют ручной сверки'};
}

export async function analyzeLocalText(image,{url}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8765');
  const response=await callLocal(address+'/ocr',{image},120000);
  return {engine:'PP-OCRv6 + OpenCV',lines:Array.isArray(response.lines)?response.lines.slice(0,400):[],
    recognizedCells:Array.isArray(response.recognized_cells)?response.recognized_cells.slice(0,400):[],verified:false};
}
export async function analyzeLocalVL(image,{url}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8765');
  const response=await callLocal(address+'/vl',{image},180000);
  return {engine:'PaddleOCR-VL',preview:String(response.raw||'').slice(0,16000),verified:false};
}

export async function previewPerspective(image,{url}={}){
  const address=safeEndpoint(url,'http://127.0.0.1:8765');
  const result=await callLocal(address+'/preprocess',{image},90000);
  return {applied:result.applied===true,
    image:result.applied===true&&typeof result.image==='string'?result.image:null,
    reason:String(result.reason||'').slice(0,150)};
}
