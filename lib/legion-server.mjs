import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import {parseLegionCsv,classifyTrips,reportSummary,plateKey} from './legion.mjs';
import {readVehicleWorkbook,mergeVehicles,exportVehicleMaster,groupByDateAndProduct,makeLegionReport,safeFilePart} from './legion-excel.mjs';

const secureId=x=>/^[0-9a-f-]{36}$/i.test(String(x||''))?x:null;
const safeName=x=>String(x||'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,110);
const decodeFile=(url,maxBytes,type)=>{
  if(typeof url!=='string')throw Error('Файл не загружен');
  const match=/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
  if(!match)throw Error('Формат передачи файла не поддерживается');
  if(!type.some(t=>match[1].includes(t)))throw Error('Ожидается файл '+type.join(' / '));
  if(match[2].length>maxBytes*4/3+12)throw Error('Файл превышает допустимый размер');
  const buf=Buffer.from(match[2],'base64');
  if(buf.byteLength<10||buf.byteLength>maxBytes)throw Error('Файл слишком большой или пуст');
  return buf;
};
const jsonFile=async(file,fallback)=>{
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch(e){if(e.code==='ENOENT')return fallback;throw Error('Не удалось прочитать данные Легиона: '+e.message)}
};
const writeJson=async(file,data)=>{
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(data,null,2),'utf8');await fs.rename(temp,file)}
  finally{await fs.rm(temp,{force:true}).catch(()=>{})}
};
const stamp=()=>{
  const d=new Date(),p=x=>String(x).padStart(2,'0');
  return d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
};
let dataLock=Promise.resolve();
function serial(task){
  const next=dataLock.catch(()=>{}).then(task);
  dataLock=next.catch(()=>{});
  return next;
}
export function createLegionHandler({root,dataDir,json,send}){
  const dir=path.join(dataDir,'legion'),
    imports=path.join(dir,'imports'),
    vehicleFile=path.join(dir,'vehicles.json'),
    reportIndex=path.join(dir,'reports-index.json'),
    outDir=path.join(root,'reports','Легион');
  const vehicles=async()=>await jsonFile(vehicleFile,[]);
  const reportList=async()=>await jsonFile(reportIndex,[]);
  const importRecord=async id=>{
    if(!secureId(id))throw Error('Некорректный номер загрузки');
    return await jsonFile(path.join(imports,id+'.json'),null);
  };
  const respondBuffer=(res,buffer,filename,contentType)=>{
    res.writeHead(200,{
      'Content-Type':contentType,
      'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(filename),
      'Content-Length':buffer.byteLength,'Cache-Control':'no-store',
      'X-Content-Type-Options':'nosniff'
    });
    res.end(buffer);
  };
  return async function legion(req,res,url){
    const route=url.pathname;
    if(!route.startsWith('/api/legion/'))return false;
    if(req.method==='GET'&&route==='/api/legion/base'){
      return send(res,200,{vehicles:await vehicles()});
    }
    if(req.method==='GET'&&route==='/api/legion/imports'){
      const list=await jsonFile(path.join(dir,'imports-index.json'),[]);
      return send(res,200,{imports:list.slice(0,20)});
    }
    if(req.method==='GET'&&route==='/api/legion/reports'){
      return send(res,200,{reports:(await reportList()).slice(0,30),folder:outDir});
    }
    if(req.method==='GET'&&route==='/api/legion/master'){
      const buffer=await exportVehicleMaster(await vehicles());
      return respondBuffer(res,buffer,'Легион_мастер_отчетов.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    const download=/^\/api\/legion\/download\/([0-9a-f-]{36})$/.exec(route);
    if(req.method==='GET'&&download){
      const entry=(await reportList()).find(x=>x.id===download[1]);
      if(!entry)throw Error('Архив отчёта не найден');
      const file=path.join(outDir,path.basename(entry.zip));
      return respondBuffer(res,await fs.readFile(file),entry.zip,'application/zip');
    }
    if(req.method==='POST'&&route==='/api/legion/import-master'){
      const payload=await json(req),buffer=decodeFile(payload.file,8*1024*1024,
        ['spreadsheetml','octet-stream','zip','vnd.ms-excel']);
      const parsed=await readVehicleWorkbook(buffer);
      const updated=await serial(async()=>{
        const old=await vehicles();
        // The operator's corrections already in TENSEI are authoritative.
        const all=mergeVehicles(parsed.vehicles,old);
        await writeJson(vehicleFile,all);
        return all;
      });
      return send(res,200,{ok:true,count:updated.length,source:parsed.source,
        imported:parsed.vehicles.length,errors:parsed.errors.slice(0,50)});
    }
    if(req.method==='POST'&&route==='/api/legion/vehicle'){
      const payload=await json(req);
      const key=plateKey(payload.plate);
      if(!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/.test(key))
        throw Error('Введите российский госномер, например Н508КО');
      if(String(payload.model||'').length>110||String(payload.driver||'').length>110)
        throw Error('Слишком длинная запись');
      const item={plate:key,displayPlate:String(payload.displayPlate||payload.plate||key).trim().slice(0,40),
        model:String(payload.model||'').trim(),driver:String(payload.driver||'').trim()};
      const all=await serial(async()=>{
        const result=mergeVehicles(await vehicles(),[item]);
        await writeJson(vehicleFile,result);return result;
      });
      return send(res,200,{ok:true,count:all.length,vehicle:item});
    }
    const deleteVehicle=/^\/api\/legion\/vehicle\/(.+)$/.exec(route);
    if(req.method==='DELETE'&&deleteVehicle){
      const key=plateKey(decodeURIComponent(deleteVehicle[1]));
      const next=await serial(async()=>{
        const result=(await vehicles()).filter(v=>v.plate!==key);
        await writeJson(vehicleFile,result);return result;
      });
      return send(res,200,{ok:true,count:next.length});
    }
    if(req.method==='POST'&&route==='/api/legion/import-csv'){
      const p=await json(req);
      const buffer=decodeFile(p.file,15*1024*1024,['csv','text/plain','octet-stream','text/comma-separated-values']);
      const parsed=parseLegionCsv(buffer);
      if(parsed.rows.length>12000)throw Error('Слишком много рейсов в одном файле (максимум 12 000)');
      const id=randomUUID();
      const entry={id,name:safeName(p.name||'Карьер.csv'),importedAt:new Date().toISOString(),...parsed};
      await serial(async()=>{
        await writeJson(path.join(imports,id+'.json'),entry);
        const list=await jsonFile(path.join(dir,'imports-index.json'),[]);
        await writeJson(path.join(dir,'imports-index.json'),
          [{id,name:entry.name,importedAt:entry.importedAt,count:parsed.rows.length,
            errors:parsed.errors.length,groups:parsed.groups},...list].slice(0,50));
      });
      const joined=classifyTrips(entry.rows,await vehicles());
      const sum=reportSummary(joined);
      return send(res,200,{importId:id,source:entry.name,count:joined.length,
        groups:entry.groups,errors:entry.errors.slice(0,100),
        columns:entry.headers,summary:sum,
        unknown:joined.filter(x=>x.model==='НЕТ В БАЗЕ'||x.driver==='НЕТ В БАЗЕ')
          .reduce((m,x)=>{m[x.plate]={plate:x.plate,model:x.model,driver:x.driver,
            csvDriver:x.driverCsv};return m},{}),
        sample:joined.slice(0,100)});
    }
    const getImport=/^\/api\/legion\/import\/([0-9a-f-]{36})$/.exec(route);
    if(req.method==='GET'&&getImport){
      const record=await importRecord(getImport[1]);
      if(!record)throw Error('Файл импорта не найден');
      const joined=classifyTrips(record.rows,await vehicles());
      return send(res,200,{importId:record.id,source:record.name,count:joined.length,
        groups:record.groups,errors:record.errors,summary:reportSummary(joined),
        unknown:joined.filter(x=>x.model==='НЕТ В БАЗЕ'||x.driver==='НЕТ В БАЗЕ')
          .reduce((m,x)=>{m[x.plate]={plate:x.plate,model:x.model,driver:x.driver,csvDriver:x.driverCsv};return m},{}),
        sample:joined.slice(0,100)});
    }
    if(req.method==='POST'&&route==='/api/legion/generate'){
      const p=await json(req),record=await importRecord(p.importId);
      if(!record)throw Error('Сначала выберите CSV-файл с карьера');
      if(record.errors.length&&p.acceptSkipped!==true)throw Error('CSV содержит '+record.errors.length+
        ' ошибочных строк. Подтвердите пропуск строк перед созданием отчётов');
      let coefficient=Number(String(p.coefficient??'1.55').replace(',','.'));
      if(!Number.isFinite(coefficient)||coefficient<=0||coefficient>1000)
        throw Error('Коэффициент должен быть числом больше нуля');
      const base=await vehicles(),groups=groupByDateAndProduct(record.rows);
      if(!groups.length||groups.length>80)throw Error('Неподходящее число групп отчётов');
      const zip=new JSZip(),created=[],createdAt=stamp(),files=[];
      for(const group of groups){
        const result=await makeLegionReport(group,base,{coefficient});
        const date=group.date.split('-').reverse().join('.');
        const filename=safeFilePart(date+'_'+group.product+'_'+createdAt)+'.xlsx';
        zip.file(filename,result.buffer);
        files.push({filename,buffer:result.buffer});
        created.push({name:filename,date:group.date,product:group.product,...result.summary});
      }
      const zipName='Легион_отчеты_'+createdAt+'.zip';
      const zipped=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',
        compressionOptions:{level:6}});
      const reportId=randomUUID();
      await fs.mkdir(outDir,{recursive:true});
      for(const {filename,buffer} of files)await fs.writeFile(path.join(outDir,filename),buffer);
      await fs.writeFile(path.join(outDir,zipName),zipped);
      const item={id:reportId,importId:record.id,zip:zipName,createdAt:new Date().toISOString(),
        coefficient,files:created};
      await serial(async()=>{
        const old=await reportList();
        await writeJson(reportIndex,[item,...old].slice(0,100));
      });
      return send(res,200,{ok:true,reportId,zip:zipName,folder:outDir,
        files:created,skippedRows:record.errors.length,coefficient});
    }
    return send(res,404,{error:'Раздел «Легион» не найден'});
  };
}
