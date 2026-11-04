import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareImage} from './images.mjs';
import {safeRows} from './records.mjs';

const ID=/^[0-9a-f-]{36}$/i;
const regex=/^data:([a-zA-Z0-9.+/-]+);base64,([a-zA-Z0-9+/=]+)$/;
const maxSource=20*1024*1024;
const date=()=>new Date().toISOString();
const safe=x=>String(x||'фотография').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,140);
const cleanRow=r=>safeRows(r).map(({issues,index,...other})=>other);
async function storeJson(file,body){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temp,JSON.stringify(body,null,2),{mode:0o600});
    await fs.rename(temp,file);
  }finally{await fs.rm(temp,{force:true}).catch(()=>{})}
}
async function readJson(file,otherwise){
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch(e){if(e.code==='ENOENT')return otherwise;throw e}
}
export function parseOriginal(dataUrl){
  if(typeof dataUrl!=='string')throw Error('Нужно изображение');
  const match=regex.exec(dataUrl);
  if(!match||!(match[1].startsWith('image/')||match[1]==='application/octet-stream'))
    throw Error('Ожидается изображение JPEG, PNG, WebP, TIFF или другой поддерживаемый формат');
  if(match[2].length>Math.ceil(maxSource*4/3)+8)throw Error('Скан больше 20 МБ');
  const buf=Buffer.from(match[2],'base64');
  if(!buf.length||buf.length>maxSource)throw Error('Пустой или слишком большой скан');
  return {buffer:buf,mime:match[1],image:dataUrl};
}
function compact(r){
  const {sourceHash,originalMime,...all}=r;
  return all;
}
export function createScanLibrary({dataDir,readBody,send,process,maxActive=1}){
  const dir=path.join(dataDir,'scans'),indexPath=path.join(dir,'index.json');
  let initialized=false,index=[],lock=Promise.resolve(),active=0;
  const pending=[];
  const saveIndex=()=>storeJson(indexPath,index);
  async function init(){
    if(initialized)return;
    lock=lock.catch(()=>{}).then(async()=>{
      if(initialized)return;
      const value=await readJson(indexPath,[]);
      index=Array.isArray(value)?value.filter(x=>ID.test(String(x.id||''))):[];
      // A process has no tasks after restart. Do not leave a false "processing" indicator.
      let changed=false;
      for(const x of index)if(['queued','processing'].includes(x.status)){
        x.status='interrupted';x.stage='Прервано: приложение было закрыто';
        x.error='TENSEI был закрыт во время обработки. Оригинал сохранён, можно повторить запрос.';
        x.updatedAt=date();changed=true;
      }
      initialized=true;
      if(changed)await saveIndex();
    });
    return lock;
  }
  function serial(action){
    const next=lock.catch(()=>{}).then(action);
    lock=next.catch(()=>{});
    return next;
  }
  function item(id){
    const value=index.find(x=>x.id===id);
    if(!value)throw Error('Скан не найден в локальной библиотеке');
    return value;
  }
  const folder=id=>path.join(dir,id);
  const metaPath=id=>path.join(folder(id),'result.json');
  async function revise(id,patch){
    return serial(async()=>{
      const current=item(id);
      Object.assign(current,patch,{updatedAt:date()});
      await saveIndex();
      return current;
    });
  }
  async function runJob(id){
    const current=item(id);
    await revise(id,{status:'processing',stage:'Подготовка фотографии',step:'prepare',
      startedAt:date(),error:'',finishedAt:null,progress:8});
    let lastStage='';
    const progress=(stage,details={})=>{
      if(stage===lastStage)return;
      lastStage=stage;
      const text=String(stage||'Обработка').slice(0,150);
      const phase=/Paddle/i.test(text)?'layout':/Chandra/i.test(text)?'compare':
        /MinerU/i.test(text)?'mineru':/част|фрагмент/i.test(text)?'crop':
        /Cloud/i.test(text)?'cloud':'prepare';
      const percent={prepare:12,layout:24,cloud:46,crop:63,compare:77,mineru:85}[phase]||25;
      void revise(id,{stage:text,step:phase,progress:percent,stepStartedAt:date()})
        .catch(()=>{});
    };
    try{
      const raw=await fs.readFile(path.join(folder(id),'original.bin'));
      const image='data:'+current.originalMime+';base64,'+raw.toString('base64');
      const result=await process({image,name:current.name,templateId:current.templateId,
        progress,force:current.force===true});
      const rows=cleanRow(result.rows);
      // Keep previous records when a completed scan is intentionally reprocessed.
      try{await fs.access(metaPath(id));await fs.copyFile(metaPath(id),
        path.join(folder(id),'result-backup-'+Date.now()+'.json'))}
      catch{}
      await storeJson(metaPath(id),{rows,sourceId:result.sourceId,
        quality:result.quality||null,model:result.model||'',warnings:result.warnings||[],
        comparison:result.comparison||null,finishedAt:date()});
      await revise(id,{status:'done',stage:'Распознавание завершено',step:'complete',
        progress:100,rowsCount:rows.length,sourceId:result.sourceId,model:result.model,
        warnings:result.warnings||[],quality:result.quality||null,
        finishedAt:date(),revision:(current.revision||0)+1});
    }catch(e){
      await revise(id,{status:'error',stage:'Ошибка обработки',step:'error',
        progress:0,error:String(e?.message||e).slice(0,500),finishedAt:date()});
    }
  }
  function schedule(){
    while(active<maxActive&&pending.length){
      const id=pending.shift();
      active++;
      void runJob(id).catch(()=>{}).finally(()=>{active--;schedule()});
    }
  }
  function enqueue(id){pending.push(id);queueMicrotask(schedule)}
  async function create(payload){
    await init();
    const raw=parseOriginal(payload.image);
    // Decode and validate once, preserving original bytes for future reprocessing.
    const preview=await prepareImage(raw.image);
    const id=randomUUID(),now=date();
    const templateId=String(payload.templateId||'weights').slice(0,100);
    const record={id,name:safe(payload.name),templateId,status:'queued',
      stage:'Скан сохранён, ожидает распознавания',step:'queued',progress:3,
      originalMime:raw.mime,size:raw.buffer.length,createdAt:now,updatedAt:now,
      stepStartedAt:now,rowsCount:0,revision:0,sourceId:null,model:'',
      warnings:[],quality:{width:preview.width,height:preview.height},error:'',force:payload.force===true};
    await fs.mkdir(folder(id),{recursive:true});
    await fs.writeFile(path.join(folder(id),'original.bin'),raw.buffer,{mode:0o600});
    await fs.writeFile(path.join(folder(id),'preview.jpg'),
      Buffer.from(preview.image.slice('data:image/jpeg;base64,'.length),'base64'),{mode:0o600});
    await serial(async()=>{
      index.unshift(record);
      await saveIndex();
    });
    enqueue(id);
    return {scan:compact(record)};
  }
  async function response(id){
    await init();const r=item(id);
    const result=await readJson(metaPath(id),{rows:[]});
    return {scan:compact(r),rows:result.rows||[],sourceId:result.sourceId||r.sourceId,
      comparison:result.comparison||null};
  }
  async function persistRows(id,rows){
    await init();
    const current=item(id);
    if(current.status!=='done')throw Error('Редактирование доступно после распознавания');
    const content=await readJson(metaPath(id),null);
    if(!content)throw Error('Для этого скана нет распознанной таблицы');
    content.rows=cleanRow(rows);
    content.editedAt=date();
    await serial(async()=>{
      await storeJson(metaPath(id),content);
      Object.assign(current,{rowsCount:content.rows.length,revision:(current.revision||0)+1,
        updatedAt:date()});
      await saveIndex();
    });
    return {ok:true,count:content.rows.length,revision:current.revision};
  }
  async function retry(id,force=false){
    await init();
    const x=item(id);
    if(['processing','queued'].includes(x.status))throw Error('Этот скан уже обрабатывается');
    if(x.status==='done'&&!force)throw Error('Повторное платное распознавание требует подтверждения');
    if(!['done','error','interrupted'].includes(x.status))throw Error('Нельзя повторить эту задачу');
    await revise(id,{status:'queued',stage:'Повтор поставлен в очередь',
      step:'queued',progress:2,error:'',force:Boolean(force)});
    enqueue(id);
    return {ok:true,scan:compact(item(id))};
  }
  async function handler(req,res,url){
    if(!url.pathname.startsWith('/api/scans'))return false;
    await init();
    const route=url.pathname;
    if(route==='/api/scans'&&req.method==='GET'){
      const scans=index.slice(0,1000).map(compact);
      return send(res,200,{scans,total:index.length,active});
    }
    if(route==='/api/scans'&&req.method==='POST'){
      const payload=await readBody(req);
      if(index.length>=2000)throw Error('Библиотека достигла лимита 2000 сканов; создайте отдельную папку TENSEI для следующего архива');
      return send(res,200,await create(payload));
    }
    const m=/^\/api\/scans\/([0-9a-f-]{36})(?:\/(preview|original|rows|retry))?$/.exec(route);
    if(!m)return send(res,404,{error:'Скан не найден'});
    const id=m[1],action=m[2]||'';
    if(req.method==='GET'&&!action)return send(res,200,await response(id));
    if(req.method==='GET'&&action==='preview'){
      item(id);const buf=await fs.readFile(path.join(folder(id),'preview.jpg'));
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private,max-age=120',
        'X-Content-Type-Options':'nosniff'});return res.end(buf);
    }
    if(req.method==='GET'&&action==='original'){
      const scan=item(id),buf=await fs.readFile(path.join(folder(id),'original.bin'));
      res.writeHead(200,{'Content-Type':'application/octet-stream',
        'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(scan.name),
        'Cache-Control':'no-store','Content-Length':buf.length,'X-Content-Type-Options':'nosniff'});
      return res.end(buf);
    }
    if(req.method==='POST'&&action==='rows'){
      const payload=await readBody(req);
      return send(res,200,await persistRows(id,payload.rows));
    }
    if(req.method==='POST'&&action==='retry'){
      const payload=await readBody(req);
      return send(res,200,await retry(id,payload.force===true));
    }
    return send(res,405,{error:'Метод не поддерживается'});
  }
  return {handler,init,create,retry,response,persistRows,list:async()=>{await init();return index.map(compact)}};
}
