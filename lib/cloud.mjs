const API = 'https://foundation-models.api.cloud.ru/v1';
export const VISION_BACKUPS = [
  'qwen/qwen3-vl-235b-a22b-instruct',
  'qwen/qwen3-vl-30b-a3b-instruct',
  'qwen/qwen3-vl-8b-instruct',
  'Qwen/Qwen3.5-397B-A17B',
  'Qwen/Qwen3.6-35B-A3B'
];
export class CloudError extends Error {
  constructor(status, message) { super(message); this.name='CloudError'; this.status=status; }
}
const auth = key => ({Authorization:'Bearer '+key,'Content-Type':'application/json'});
function message(body, secret){
  let x='';
  try {
    const o=JSON.parse(body);
    const e=o.error||o;
    x=typeof e==='string'?e:(e.message||e.detail||e.type||o.message||'');
    if(typeof x!=='string')x=JSON.stringify(x);
  }catch { x=body; }
  x=String(x).replace(/[\r\n\t]+/g,' ').slice(0,280);
  if(secret)x=x.replaceAll(secret,'[скрыто]');
  return x;
}
export function describe(status,detail=''){
  let hint;
  if(status===401||status===403)hint='Ключ не подходит, истёк или у аккаунта нет доступа к Foundation Models.';
  else if(status===404)hint='Модель или маршрут не найдены для этого ключа. Проверьте список доступных моделей в настройках.';
  else if(status===429)hint='Превышены лимиты Cloud.ru. Повторите попытку позже.';
  else if(status>=500)hint='Ошибка сервиса Cloud.ru. Повторите позже.';
  else hint='Cloud.ru не принял запрос. Проверьте параметры и разрешения.';
  return 'Cloud.ru HTTP '+status+': '+hint+(detail?' Подробности: '+detail:'');
}
async function fetchBounded(url,opts,timeout=30000,fetcher=fetch){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),timeout);
  try{return await fetcher(url,{...opts,signal:ac.signal})}
  catch(e){if(e.name==='AbortError')throw Error('Cloud.ru не ответил вовремя');throw Error('Нет подключения к Cloud.ru: '+(e.message||'сетевая ошибка'))}
  finally{clearTimeout(timer)}
}
export async function listCloudModels(key,fetcher=fetch){
  if(!key)throw Error('Сначала сохраните ключ Cloud.ru');
  const r=await fetchBounded(API+'/models',{headers:auth(key)},22000,fetcher);
  if(!r.ok)throw new CloudError(r.status,describe(r.status,message(await r.text(),key)));
  let result;
  try{result=await r.json()}catch{throw Error('Cloud.ru вернул неверный список моделей')}
  if(!Array.isArray(result.data))throw Error('Cloud.ru вернул список моделей в неожиданном формате');
  return [...new Set(result.data.map(x=>x?.id).filter(x=>typeof x==='string'))];
}
export async function callCloudVision(key,model,image,prompt,fetcher=fetch){
  const r=await fetchBounded(API+'/chat/completions',{
    method:'POST',headers:auth(key),body:JSON.stringify({model,temperature:0,max_tokens:8000,
      messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:image}}]}]})
  },125000,fetcher);
  if(!r.ok)throw new CloudError(r.status,describe(r.status,message(await r.text(),key)));
  let result;
  try{result=await r.json()}catch{throw Error('Cloud.ru вернул не JSON')}
  const content=result.choices?.[0]?.message?.content;
  const txt=typeof content==='string'?content:Array.isArray(content)?
    content.filter(x=>x.type==='text').map(x=>x.text||'').join(''):'';
  if(!txt.trim())throw Error('Модель не вернула текст с таблицей');
  return {text:txt,usage:result.usage||null,model};
}
export async function recognizeWithFallback({key,model,image,prompt,fallback=true,fetcher=fetch}){
  try{return await callCloudVision(key,model,image,prompt,fetcher)}
  catch(e){
    if(!(e instanceof CloudError)||e.status!==404||!fallback||!VISION_BACKUPS.includes(model))throw e;
    let available;
    try{available=await listCloudModels(key,fetcher)}
    catch(listError){throw new Error(e.message+' Не удалось прочитать каталог: '+listError.message)}
    const alternatives=VISION_BACKUPS.filter(id=>id!==model&&available.includes(id));
    if(!alternatives.length)throw new Error(e.message+' В каталоге для этого ключа нет доступных резервных моделей Qwen VL.');
    const failures=[];
    for(const next of alternatives){
      try{const value=await callCloudVision(key,next,image,prompt,fetcher);return {...value,fallbackFrom:model}}
      catch(nextError){failures.push(next+': '+nextError.message);if(!(nextError instanceof CloudError)||![404,400,422].includes(nextError.status))throw nextError}
    }
    throw new Error('Ни одна модель не обработала фотографию. '+failures.slice(0,3).join(' | '));
  }
}
