// Optional CPU-only OCR sidecar. Never sends images to external addresses.
const defaultUrl='http://127.0.0.1:8767';
export function rapidUrl(value=defaultUrl){
  const u=new URL(String(value||defaultUrl));
  if(u.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||
    u.username||u.password||u.search||u.hash||u.pathname!=='/')
    throw Error('RapidOCR accepts only a localhost HTTP URL');
  return u.origin;
}
async function bounded(url,opts={},milliseconds=2000){
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),milliseconds);
  try{return await fetch(url,{...opts,signal:control.signal})}
  finally{clearTimeout(timer)}
}
export async function rapidHealth(url=defaultUrl){
  try{
    const origin=rapidUrl(url);
    const r=await bounded(origin+'/health',{},800);
    if(!r.ok)return {available:false,installed:false,reason:'HTTP '+r.status};
    const j=await r.json();
    return {available:j.ok===true&&j.installed===true,
      installed:j.installed===true,engine:'RapidOCR CPU ONNX',
      reason:j.installed===true?'Готов к локальному OCR':'Установите rapidocr и onnxruntime',
      keepWarm:j.keepWarm===true};
  }catch{return {available:false,installed:false,reason:'Локальный сервер RapidOCR не запущен'}}
}
export async function analyzeRapidOCR(image,{url=defaultUrl}={}){
  const origin=rapidUrl(url);
  if(typeof image!=='string'||!image.startsWith('data:image/jpeg;base64,'))
    throw Error('RapidOCR requires a JPEG data URL');
  const response=await bounded(origin+'/ocr',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({image})
  },90000);
  if(!response.ok)throw Error('RapidOCR HTTP '+response.status);
  const payload=await response.json();
  const lines=(Array.isArray(payload.lines)?payload.lines:[]).slice(0,250).filter(x=>{
    const b=x?.bbox;
    return typeof x.text==='string'&&Array.isArray(b)&&b.length===4&&
      b.every(v=>typeof v==='number'&&v>=0&&v<=1)&&b[2]>b[0]&&b[3]>b[1];
  }).map(x=>({text:x.text.slice(0,180),bbox:x.bbox,
    score:Number.isFinite(x.score)?x.score:null,verified:false}));
  return {engine:'RapidOCR CPU ONNX',lines,recognizedCells:[],
    localOnly:true,verified:false};
}

export async function analyzeRapidDigitVariants(image,{url=defaultUrl}={}){
  const origin=rapidUrl(url);
  if(typeof image!=='string'||!image.startsWith('data:image/jpeg;base64,'))
    throw Error('Only local JPEG crop data is accepted');
  const res=await bounded(origin+'/ocr',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({image,mode:'digit-variants'})},120000);
  if(!res.ok)throw Error('RapidOCR variants HTTP '+res.status);
  const data=await res.json();
  return {engine:'RapidOCR CPU ONNX',verified:false,
    variants:(Array.isArray(data.variants)?data.variants:[]).slice(0,3).map(x=>({
      rotationDegrees:Number(x.rotationDegrees)||0,
      readings:(Array.isArray(x.readings)?x.readings:[]).slice(0,8).map(v=>String(v).slice(0,90)),
      verified:false
    }))};
}
