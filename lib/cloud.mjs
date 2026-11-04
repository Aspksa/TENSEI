const API = 'https://foundation-models.api.cloud.ru/v1';
export const VISION_BACKUPS = [
  'qwen/qwen3-vl-235b-a22b-instruct',
  'qwen/qwen3-vl-30b-a3b-instruct',
  'qwen/qwen3-vl-8b-instruct',
  'Qwen/Qwen3.5-397B-A17B',
  'Qwen/Qwen3.6-35B-A3B'
];
export class CloudError extends Error{
  constructor(status,message){super(message);this.name='CloudError';this.status=status}
}
export class EmptyVisionError extends Error{
  constructor({finishReason='unknown',model='',usage=null}={}){
    super('Cloud.ru ответил без текста распознавания (finish_reason: '+finishReason+'). Возможно, лимит токенов ушёл на внутреннее рассуждение или модель не смогла завершить ответ.');
    this.name='EmptyVisionError';this.finishReason=finishReason;this.model=model;this.usage=usage;
  }
}
const auth=key=>({Authorization:'Bearer '+key,'Content-Type':'application/json'});
function message(body,secret){
  let x='';
  try{const o=JSON.parse(body);const e=o.error||o;x=typeof e==='string'?e:(e.message||e.detail||e.type||o.message||'');if(typeof x!=='string')x=JSON.stringify(x)}
  catch{x=body}
  x=String(x).replace(/[\r\n\t]+/g,' ').slice(0,280);
  return secret?x.replaceAll(secret,'[скрыто]'):x;
}
export function describe(status,detail=''){
  let hint;
  if(status===401||status===403)hint='Проверьте ключ и права доступа к Foundation Models.';
  else if(status===404)hint='Модель или маршрут API недоступны для этого ключа.';
  else if(status===429)hint='Превышен лимит Cloud.ru. Повторите позже.';
  else if(status>=500)hint='Временная ошибка Cloud.ru.';
  else hint='Сервис не принял запрос.';
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
  let o;try{o=await r.json()}catch{throw Error('Cloud.ru вернул неверный список моделей')}
  if(!Array.isArray(o.data))throw Error('Cloud.ru вернул каталог в неожиданном формате');
  return [...new Set(o.data.map(x=>x?.id).filter(x=>typeof x==='string'))];
}
export function extractAssistantText(o){
  const choice=o?.choices?.[0];
  const msg=choice?.message||{};
  const c=msg.content;
  let value=typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p&&(['text','output_text'].includes(p.type)||typeof p.text==='string')).map(p=>typeof p.text==='string'?p.text:(p.text?.value||'')).join('\n'):'';
  if(!value&&typeof msg.output_text==='string')value=msg.output_text;
  if(!value&&typeof o.output_text==='string')value=o.output_text;
  return {text:value.trim(),finishReason:String(choice?.finish_reason||o?.finish_reason||'unknown'),usage:o?.usage||null};
}
export async function callCloudVision(key,model,image,prompt,fetcher=fetch,{retryEmpty=true}={}){
  const params=(retry)=>({model,temperature:0,max_tokens:retry?16000:8000,
    messages:[
      ...(retry?[{role:'system',content:'Return a short, valid JSON object with rows. Do not output analysis, explanatory text, or Markdown.'}]:[]),
      {role:'user',content:[{type:'text',text:prompt+(retry?'\nВАЖНО: короткий JSON в поле content сразу, без рассуждений.':'')},{type:'image_url',image_url:{url:image}}]}
    ]});
  const reasons=[];
  for(let attempt=0;attempt<(retryEmpty?2:1);attempt++){
    const r=await fetchBounded(API+'/chat/completions',{method:'POST',headers:auth(key),body:JSON.stringify(params(attempt>0))},125000,fetcher);
    if(!r.ok)throw new CloudError(r.status,describe(r.status,message(await r.text(),key)));
    let output;try{output=await r.json()}catch{throw Error('Cloud.ru вернул не JSON')}
    const parsed=extractAssistantText(output);
    if(parsed.text)return {text:parsed.text,usage:parsed.usage,model,attempts:attempt+1};
    reasons.push(parsed.finishReason);
    if(attempt>0||!retryEmpty)throw new EmptyVisionError({finishReason:reasons.join(' → '),model,usage:parsed.usage});
  }
  throw new Error('Не удалось получить ответ модели');
}
export async function recognizeWithFallback({key,model,image,prompt,fallback=true,fetcher=fetch}){
  try{return await callCloudVision(key,model,image,prompt,fetcher)}
  catch(e){
    const supported=e instanceof CloudError&&e.status===404||e instanceof EmptyVisionError;
    if(!supported||!fallback||!VISION_BACKUPS.includes(model))throw e;
    let available;
    try{available=await listCloudModels(key,fetcher)}
    catch(listError){throw new Error(e.message+' Проверка резервных моделей не удалась: '+listError.message)}
    const alternatives=VISION_BACKUPS.filter(id=>id!==model&&available.includes(id)).slice(0,2);
    if(!alternatives.length)throw new Error(e.message+' Доступных запасных моделей не найдено.');
    const failures=[];
    for(const next of alternatives){
      try{const x=await callCloudVision(key,next,image,prompt,fetcher,{retryEmpty:false});return {...x,fallbackFrom:model}}
      catch(err){
        failures.push(next+': '+err.message);
        if(!(err instanceof CloudError&&[400,404,422].includes(err.status)||err instanceof EmptyVisionError))throw err;
      }
    }
    throw new Error('Не удалось прочитать фото. '+failures.join(' | '));
  }
}
