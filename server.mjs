import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import ExcelJS from 'exceljs';
import {DEFAULT_MODEL,MODELS,parseModel,safeRows} from './lib/records.mjs';
import {prepareImage,FORMATS} from './lib/images.mjs';
import {listCloudModels} from './lib/cloud.mjs';
import {processPhoto} from './lib/workflow.mjs';
import {getMineruTask} from './lib/mineru-tasks.mjs';
import {improvePhoto} from './lib/vision.mjs';
import {BUILTIN_TEMPLATES,createTemplate} from './lib/templates.mjs';
import {createLegionHandler} from './lib/legion-server.mjs';
import {createScanLibrary} from './lib/scan-library.mjs';
import {analyzeTrips,loadLegionStats} from './lib/analytics.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.TENSEI_DATA_DIR ? path.resolve(process.env.TENSEI_DATA_DIR) : path.join(root,'data');
const settingsPath=path.join(dataDir,'settings.json');
const draftPath=path.join(dataDir,'draft.json');
const tasksPath=path.join(dataDir,'tasks.json');
const templatesPath=path.join(dataDir,'templates.json');
const sourceDir=path.join(dataDir,'sources');

async function settings(){
  try{const o=JSON.parse(await fs.readFile(settingsPath,'utf8'));return {key:String(o.key||''),model:String(o.model||DEFAULT_MODEL),fallback:o.fallback!==false,
    cropRecovery:o.cropRecovery!==false,enhance:o.enhance!==false,paddle:o.paddle===true,chandra:o.chandra===true,mineru:o.mineru===true}}
  catch(e){if(e.code==='ENOENT')return {key:'',model:DEFAULT_MODEL,fallback:true,cropRecovery:true,enhance:true,paddle:false,chandra:false,mineru:false};throw Error('Ошибка чтения настроек')}
}
async function writeJson(file,obj){
  await fs.mkdir(dataDir,{recursive:true});
  const tmp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(tmp,JSON.stringify(obj,null,2),{mode:0o600});await fs.rename(tmp,file)}
  finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
}
function send(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))}
async function json(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw Error('Ожидается JSON');
  const chunks=[];let length=0;
  for await(const c of req){length+=c.length;if(length>32*1024*1024)throw Error('Запрос больше 32 МБ');chunks.push(c)}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('Некорректный JSON')}
}
function safeRequest(req){
  const host=String(req.headers.host||'');
  if(!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host))return false;
  const origin=req.headers.origin;
  return !origin||origin==='http://'+host;
}
function cloudError(status){
  if(status===401||status===403)return 'Cloud.ru: проверьте API-ключ и доступ к модели ('+status+')';
  if(status===429)return 'Cloud.ru: превышен лимит запросов, повторите позднее';
  if(status===402)return 'Cloud.ru: недостаточно средств';
  return 'Cloud.ru вернул HTTP '+status+'. Проверьте ID модели, её доступность и подключение.';
}
async function tasks(){
  try{const o=JSON.parse(await fs.readFile(tasksPath,'utf8'));return Array.isArray(o)?o:[]}
  catch(e){if(e.code==='ENOENT')return [];throw Error('Не удалось открыть историю заданий')}
}
let updateChain=Promise.resolve();
async function updateTask(task){
  updateChain=updateChain.catch(()=>{}).then(async()=>{
    const list=await tasks();
    const i=list.findIndex(x=>x.id===task.id);
    if(i>=0)list[i]={...list[i],...task};
    else list.unshift(task);
    await writeJson(tasksPath,list.slice(0,200));
  });
  return updateChain;
}
async function savedTemplates(){
  try{const list=JSON.parse(await fs.readFile(templatesPath,'utf8'));return Array.isArray(list)?list.slice(0,25):[]}
  catch(e){if(e.code==='ENOENT')return [];throw Error('Ошибка чтения шаблонов')}
}
function identity(input,cfg,template){
  const bytes=Buffer.from(String(input.image||''));
  if(bytes.length>28000000)throw Error('Слишком большой файл');
  return createHash('sha256').update(bytes).update(cfg.model)
    .update(JSON.stringify([cfg.enhance,cfg.cropRecovery,cfg.paddle,cfg.chandra,template.id])).digest('hex');
}
async function recognize(input,progress=()=>{}){
  const cfg=await settings();
  if(!cfg.key)throw Error('Сначала сохраните API-ключ Cloud.ru');
  if(typeof input.image!=='string')throw Error('Нужна фотография');
  const templates=[...BUILTIN_TEMPLATES,...await savedTemplates()];
  const template=templates.find(t=>t.id===String(input.templateId||'weights'))||BUILTIN_TEMPLATES[0];
  const hash=identity(input,cfg,template);
  const previous=(await tasks()).find(x=>x.hash===hash&&x.status==='done'&&Array.isArray(x.rows));
  if(previous&&!input.force){
    progress('Кэш: используется уже готовый результат');
    return {rows:previous.rows,sourceId:previous.sourceId,cached:true,model:previous.model,
      warnings:previous.warnings||[],quality:previous.quality||null,layout:previous.layout||null,
      comparison:previous.comparison||null,mineruTask:previous.mineruTask||null};
  }
  const id=createHash('sha256').update(hash+Date.now()).digest('hex').slice(0,24);
  const task={id,name:String(input.name||'Фото').slice(0,160),hash,templateId:template.id,
    model:cfg.model,status:'processing',attempts:1,startedAt:new Date().toISOString()};
  await updateTask(task);
  try{
    const result=await processPhoto({image:input.image,name:task.name,cfg,template,progress,
      paddleUrl:process.env.TENSEI_PADDLE_URL,chandraUrl:process.env.TENSEI_CHANDRA_URL,
      mineruUrl:process.env.TENSEI_MINERU_URL,mineruKey:process.env.TENSEI_MINERU_KEY});
    await fs.mkdir(sourceDir,{recursive:true});
    const filename=path.join(sourceDir,result.sourceId+'.jpg');
    await fs.writeFile(filename,Buffer.from(result.image.slice('data:image/jpeg;base64,'.length),'base64'));
    const output={rows:result.rows,sourceId:result.sourceId,model:result.model,
      warnings:result.warnings,quality:result.quality,layout:result.layout,
      comparison:result.comparison,mineruTask:result.mineruTask,attempts:result.attempts};
    await updateTask({...task,...output,status:'done',finishedAt:new Date().toISOString()});
    return output;
  }catch(e){
    await updateTask({...task,status:'error',error:String(e.message||e).slice(0,260),finishedAt:new Date().toISOString()});
    throw e;
  }
}
async function excel(raw){
  const records=safeRows(raw);
  const book=new ExcelJS.Workbook();
  book.creator='TENSEI';
  book.calcProperties.fullCalcOnLoad=true;
  const sheet=book.addWorksheet('Реестр',{views:[{state:'frozen',ySplit:1}]});
  sheet.columns=[
    ['№',7],['Время',11],['ТС',18],['Водитель',24],['Тара, кг',15],
    ['Брутто, кг',16],['Нетто, кг',15],['Нетто, т',14],
    ['Источник',23],['Примечание',35],['Сверено с фото',17],['Проверить',16],['Аномалии',55]
  ].map(([header,width])=>({header,width}));
  sheet.getRow(1).height=28;
  sheet.getRow(1).eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF202A38'}};c.alignment={vertical:'middle'}});
  records.forEach((r,i)=>{
    const row=sheet.addRow([i+1,r.time,r.vehicle,r.driver,r.tare,r.gross,r.net,
      r.net===null?null:r.net/1000,r.source,r.note,r.reviewed?'ДА':'НЕТ',r.issues.length?'ПРОВЕРИТЬ':'OK',r.issues.join('; ')]);
    for(const n of [5,6,7])row.getCell(n).numFmt='#,##0.##';
    row.getCell(8).numFmt='0.000';
    if(r.issues.length)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE8C3'}};
    else if(i%2)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F5F8'}};
  });
  sheet.autoFilter={from:{row:1,column:1},to:{row:records.length+1,column:13}};
  sheet.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1};
  sheet.pageMargins={left:0.25,right:0.25,top:0.45,bottom:0.45,header:0.2,footer:0.2};
  const summary=book.addWorksheet('Контроль');
  summary.addRows([['Проверка','Значение'],['Всего строк',records.length],['С замечаниями',records.filter(x=>x.issues.length).length],
    ['Без замечаний',records.filter(x=>!x.issues.length).length],['Итог нетто, т',records.reduce((s,x)=>s+(x.net??0),0)/1000]]);
  summary.getColumn(1).width=27;summary.getColumn(2).width=20;
  summary.getCell('B5').numFmt='0.000';
  summary.getRow(1).font={bold:true};
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function getDraft(){try{const x=JSON.parse(await fs.readFile(draftPath,'utf8'));return {rows:Array.isArray(x.rows)?x.rows:[],savedAt:x.savedAt||null}}
  catch(e){if(e.code==='ENOENT')return {rows:[],savedAt:null};throw Error('Не удалось открыть сохранённый черновик')}}
const handleLegion=createLegionHandler({root,dataDir,json,send});
const scanLibrary=createScanLibrary({dataDir,readBody:json,send,
  process:async({image,name,templateId,progress,force})=>
    recognize({image,name,templateId,force},progress)});

const server=http.createServer(async(req,res)=>{
  try{
    if(!safeRequest(req))return send(res,403,{error:'Доступ только с локального компьютера'});
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url=new URL(req.url,'http://127.0.0.1');
    const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],
      '/legion.js':['legion.js','text/javascript; charset=utf-8'],
      '/legion.css':['legion.css','text/css; charset=utf-8']};
    if(req.method==='GET'&&staticFiles[url.pathname]){
      const [filename,type]=staticFiles[url.pathname];
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
      return res.end(await fs.readFile(path.join(root,filename)));
    }
    if(url.pathname.startsWith('/api/legion/'))return await handleLegion(req,res,url);
    if(url.pathname.startsWith('/api/scans'))return await scanLibrary.handler(req,res,url);
    if(req.method==='GET'&&url.pathname==='/api/analytics'){
      const dataset=await loadLegionStats(dataDir);
      const params=Object.fromEntries(['from','to','period','product','plate','compareFrom','compareTo']
        .map(key=>[key,url.searchParams.get(key)||'']));
      return send(res,200,analyzeTrips(dataset.trips,params,dataset.context));
    }
    if(req.method==='GET'&&url.pathname==='/api/settings'){
      const cfg=await settings();return send(res,200,{model:cfg.model,hasKey:!!cfg.key,models:MODELS,formats:FORMATS,fallback:cfg.fallback,
        cropRecovery:cfg.cropRecovery,enhance:cfg.enhance,paddle:cfg.paddle,chandra:cfg.chandra,mineru:cfg.mineru});
    }
    if(req.method==='POST'&&url.pathname==='/api/settings'){
      const payload=await json(req),previous=await settings();
      const model=String(payload.model||DEFAULT_MODEL).trim();
      if(model.length>140||!/^[-a-zA-Z0-9_./]+$/.test(model))throw Error('Некорректный ID модели');
      const key=String(payload.key||previous.key||'').trim();
      if(key.length>2048)throw Error('API-ключ слишком длинный');
      await writeJson(settingsPath,{key,model,fallback:payload.fallback!==false,
        cropRecovery:payload.cropRecovery!==false,enhance:payload.enhance!==false,
        paddle:payload.paddle===true,chandra:payload.chandra===true,mineru:payload.mineru===true});
      return send(res,200,{ok:true,hasKey:!!key,model});
    }
    if(req.method==='GET'&&url.pathname==='/api/connection'){
      const cfg=await settings();
      if(!cfg.key)return send(res,200,{ok:false,reason:'Нет ключа Cloud.ru',models:[]});
      const list=await listCloudModels(cfg.key);
      const chosen=list.includes(cfg.model);
      const suggested=MODELS.filter(m=>list.includes(m.id));
      const extras=list.filter(id=>/vision|qwen.*vl|(^|[\/.-])vl([\/.-]|$)/i.test(id)&&
        !suggested.some(x=>x.id===id)).slice(0,20).map(id=>({id,name:id}));
      suggested.push(...extras);
      return send(res,200,{ok:true,selected:cfg.model,selectedAvailable:chosen,
        available:suggested,availableCount:list.length,
        reason:chosen?'Выбранная модель есть в каталоге API. Работа с фото ещё не проверена.':
          'Выбранной модели нет в списке API для этого ключа. Выберите доступную модель ниже.'});
    }
    const mineruStatus=/^\/api\/mineru\/([a-zA-Z0-9_-]{5,160})$/.exec(url.pathname);
    if(req.method==='GET'&&mineruStatus){
      const cfg=await settings();
      if(!cfg.mineru)throw Error('MinerU Tasks не включена в настройках');
      const output=await getMineruTask(mineruStatus[1],{url:process.env.TENSEI_MINERU_URL,
        key:process.env.TENSEI_MINERU_KEY});
      return send(res,200,output);
    }
    if(req.method==='GET'&&url.pathname==='/api/tasks'){
      return send(res,200,{tasks:(await tasks()).map(({rows,hash,comparison,...x})=>({...x,rowCount:rows?.length||0}))});
    }
    if(req.method==='GET'&&url.pathname==='/api/templates'){
      return send(res,200,{templates:[...BUILTIN_TEMPLATES,...await savedTemplates()]});
    }
    if(req.method==='POST'&&url.pathname==='/api/templates'){
      const incoming=await json(req),existing=await savedTemplates();
      const t=createTemplate(incoming,existing);
      const rest=existing.filter(x=>x.id!==t.id);
      if(rest.length>=24)throw Error('Максимум 25 пользовательских шаблонов');
      await writeJson(templatesPath,[...rest,t]);
      return send(res,200,{ok:true,template:t});
    }
    const sourceMatch=/^\/api\/source\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(req.method==='GET'&&sourceMatch){
      const buffer=await fs.readFile(path.join(sourceDir,sourceMatch[1]+'.jpg'));
      res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=60',
        'X-Content-Type-Options':'nosniff'});
      return res.end(buffer);
    }
    if(req.method==='GET'&&url.pathname==='/api/draft')return send(res,200,await getDraft());
    if(req.method==='POST'&&url.pathname==='/api/draft'){
      const payload=await json(req),rows=safeRows(payload.rows).map(({issues,index,...r})=>r);
      const savedAt=new Date().toISOString();await writeJson(draftPath,{rows,savedAt});
      return send(res,200,{ok:true,savedAt,count:rows.length});
    }
    if(req.method==='DELETE'&&url.pathname==='/api/draft'){await fs.rm(draftPath,{force:true});return send(res,200,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/quality'){
      const input=await json(req);
      const image=await improvePhoto(input.image,{enhance:false});
      return send(res,200,{quality:image.report,format:image.format});
    }
    if(req.method==='POST'&&url.pathname==='/api/recognize')return send(res,200,await recognize(await json(req)));
    if(req.method==='POST'&&url.pathname==='/api/export'){
      const rows=(await json(req)).rows;
      const file=await excel(rows);
      res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':'attachment; filename="TENSEI.xlsx"','Content-Length':file.length,'Cache-Control':'no-store'});
      return res.end(file);
    }
    return send(res,404,{error:'Раздел не найден'});
  }catch(e){return send(res,400,{error:String(e.message||e).slice(0,260)})}
});
const requestedPort=process.env.PORT?Number(process.env.PORT):0;
server.on('error',e=>{console.error('Не удалось открыть локальный порт:',e.message);process.exitCode=1});
server.listen(requestedPort,'127.0.0.1',()=>{
  const address='http://127.0.0.1:'+server.address().port;
  console.log('TENSEI_READY '+address);
  if(process.platform==='win32'&&process.env.TENSEI_NO_BROWSER!=='1')
    execFile('rundll32.exe',['url.dll,FileProtocolHandler',address],()=>{});
});
