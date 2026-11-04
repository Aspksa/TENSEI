import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import ExcelJS from 'exceljs';
import {DEFAULT_MODEL,MODELS,parseModel,safeRows} from './lib/records.mjs';
import {prepareImage,FORMATS} from './lib/images.mjs';
import {listCloudModels,recognizeWithFallback} from './lib/cloud.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'data');
const settingsPath=path.join(dataDir,'settings.json');
const draftPath=path.join(dataDir,'draft.json');
const prompt='Прочитай фото рукописного журнала отгрузок/взвешиваний. Верни ТОЛЬКО валидный JSON объект с массивом rows. Формат строки: {"time":"","vehicle":"","driver":"","tare":null,"gross":null,"net":null,"note":"","uncertain":false}. Каждое физическое событие/рейс — отдельная строка; не удаляй повторы ТС. Вес в килограммах, не тоннах. Извлекай значения строго из соответствующих колонок; не выдумывай сведения. Если символы неразборчивы, оставляй поле пустым/null и uncertain=true, объясни в note. Не вычисляй неизвестные значения в уме. Сохраняй порядок строк. Никакого markdown.';

async function settings(){
  try{const o=JSON.parse(await fs.readFile(settingsPath,'utf8'));return {key:String(o.key||''),model:String(o.model||DEFAULT_MODEL),fallback:o.fallback!==false}}
  catch(e){if(e.code==='ENOENT')return {key:'',model:DEFAULT_MODEL,fallback:true};throw Error('Ошибка чтения настроек')}
}
async function writeJson(file,obj){
  await fs.mkdir(dataDir,{recursive:true});
  const tmp=file+'.'+process.pid+'.tmp';
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
async function recognize(input){
  const cfg=await settings();
  if(!cfg.key)throw Error('Сначала сохраните API-ключ Cloud.ru');
  const converted=await prepareImage(input.image);
  const result=await recognizeWithFallback({key:cfg.key,model:cfg.model,
    image:converted.image,prompt,fallback:cfg.fallback});
  const rows=parseModel(result.text).map(r=>({...r,source:String(input.name||'').slice(0,180)}));
  return {rows,usage:result.usage,format:converted.originalFormat,model:result.model,
    fallbackFrom:result.fallbackFrom||null};
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
    ['Источник',23],['Примечание',35],['Проверить',16],['Аномалии',55]
  ].map(([header,width])=>({header,width}));
  sheet.getRow(1).height=28;
  sheet.getRow(1).eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF202A38'}};c.alignment={vertical:'middle'}});
  records.forEach((r,i)=>{
    const row=sheet.addRow([i+1,r.time,r.vehicle,r.driver,r.tare,r.gross,r.net,
      r.net===null?null:r.net/1000,r.source,r.note,r.issues.length?'ПРОВЕРИТЬ':'OK',r.issues.join('; ')]);
    for(const n of [5,6,7])row.getCell(n).numFmt='#,##0.##';
    row.getCell(8).numFmt='0.000';
    if(r.issues.length)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFE8C3'}};
    else if(i%2)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F5F8'}};
  });
  sheet.autoFilter={from:{row:1,column:1},to:{row:records.length+1,column:12}};
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
const server=http.createServer(async(req,res)=>{
  try{
    if(!safeRequest(req))return send(res,403,{error:'Доступ только с локального компьютера'});
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const url=new URL(req.url,'http://127.0.0.1');
    const staticFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8']};
    if(req.method==='GET'&&staticFiles[url.pathname]){
      const [filename,type]=staticFiles[url.pathname];
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});
      return res.end(await fs.readFile(path.join(root,filename)));
    }
    if(req.method==='GET'&&url.pathname==='/api/settings'){
      const cfg=await settings();return send(res,200,{model:cfg.model,hasKey:!!cfg.key,models:MODELS,formats:FORMATS,fallback:cfg.fallback});
    }
    if(req.method==='POST'&&url.pathname==='/api/settings'){
      const payload=await json(req),previous=await settings();
      const model=String(payload.model||DEFAULT_MODEL).trim();
      if(model.length>140||!/^[-a-zA-Z0-9_./]+$/.test(model))throw Error('Некорректный ID модели');
      const key=String(payload.key||previous.key||'').trim();
      if(key.length>2048)throw Error('API-ключ слишком длинный');
      await writeJson(settingsPath,{key,model,fallback:payload.fallback!==false});
      return send(res,200,{ok:true,hasKey:!!key,model});
    }
    if(req.method==='GET'&&url.pathname==='/api/connection'){
      const cfg=await settings();
      if(!cfg.key)return send(res,200,{ok:false,reason:'Нет ключа Cloud.ru',models:[]});
      const list=await listCloudModels(cfg.key);
      const chosen=list.includes(cfg.model);
      const suggested=MODELS.filter(m=>list.includes(m.id));
      return send(res,200,{ok:true,selected:cfg.model,selectedAvailable:chosen,
        available:suggested,availableCount:list.length,
        reason:chosen?'Выбранная модель есть в каталоге API. Работа с фото ещё не проверена.':
          'Выбранной модели нет в списке API для этого ключа. Выберите доступную модель ниже.'});
    }
    if(req.method==='GET'&&url.pathname==='/api/draft')return send(res,200,await getDraft());
    if(req.method==='POST'&&url.pathname==='/api/draft'){
      const payload=await json(req),rows=safeRows(payload.rows).map(({issues,index,...r})=>r);
      const savedAt=new Date().toISOString();await writeJson(draftPath,{rows,savedAt});
      return send(res,200,{ok:true,savedAt,count:rows.length});
    }
    if(req.method==='DELETE'&&url.pathname==='/api/draft'){await fs.rm(draftPath,{force:true});return send(res,200,{ok:true})}
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
