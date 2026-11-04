import fs from 'node:fs/promises';
import path from 'node:path';

// Bounded, read-only filesystem integrity audit.
// Never read or print Cloud.ru tokens, OCR text, drivers or vehicle identifiers.
const json=async file=>{
  try{return {value:JSON.parse(await fs.readFile(file,'utf8')),exists:true}}
  catch(e){return e.code==='ENOENT'?{value:null,exists:false}:{value:null,exists:true,error:'invalid-json'}}
};
const safeId=value=>/^[a-f0-9-]{36}$/i.test(String(value||''));
const warn=(report,code,severity,detail)=>report.findings.push({code,severity,detail});
const directoryFiles=async dir=>{
  try{return (await fs.readdir(dir,{withFileTypes:true}))
    .filter(x=>x.isFile()).map(x=>x.name)}
  catch(e){if(e.code==='ENOENT')return [];throw e}
};
export async function auditStorage(dataDir,{maxFiles=3000}={}){
  const findings=[],counts={},report={version:1,checkedAt:new Date().toISOString(),
    readOnly:true,counts,findings};
  const legion=path.join(dataDir,'legion');
  const index=await json(path.join(legion,'imports-index.json'));
  const imports=Array.isArray(index.value)?index.value:[];
  if(index.error)warn(report,'CSV_INDEX_INVALID','high','Индекс CSV повреждён');
  else if(index.exists&&!Array.isArray(index.value))
    warn(report,'CSV_INDEX_SHAPE','high','Индекс CSV не является массивом');
  counts.indexedImports=imports.length;
  if(imports.length>=2000)warn(report,'CSV_INDEX_LIMIT','medium',
    'История близка к лимиту сохранения 2000 импортов');
  const importDir=path.join(legion,'imports'),files=await directoryFiles(importDir);
  counts.savedImportFiles=files.filter(x=>x.endsWith('.json')).length;
  if(files.length>maxFiles){warn(report,'AUDIT_LIMIT','medium',
    'Проверка файлов ограничена '+maxFiles+' элементами');}
  const ids=new Set(imports.filter(x=>safeId(x.id)).map(x=>x.id));
  const orphans=files.filter(x=>x.endsWith('.json')&&safeId(x.slice(0,-5))&&!ids.has(x.slice(0,-5)));
  counts.orphanImports=orphans.length;
  if(orphans.length)warn(report,'CSV_ORPHAN_IMPORTS','high',
    'Есть '+orphans.length+' импортов, не включённых в индекс статистики');
  let missing=0,bad=0,totalRows=0;
  for(const item of imports.slice(0,maxFiles)){
    if(!safeId(item?.id)){bad++;continue}
    const file=await json(path.join(importDir,item.id+'.json'));
    if(!file.exists){missing++;continue}
    if(file.error||!Array.isArray(file.value?.rows)){bad++;continue}
    totalRows+=file.value.rows.length;
  }
  counts.importRows=totalRows;
  counts.missingIndexedImports=missing;
  counts.invalidIndexedImports=bad;
  if(missing||bad)warn(report,'CSV_IMPORTS_UNREADABLE','high',
    'В индексе недоступны '+missing+' файлов, повреждены '+bad);
  if(totalRows>50000)warn(report,'FLEET_ROW_LIMIT','high',
    'Статистика ограничивает историю 50 000 исходных CSV-строк');
  const draft=await json(path.join(dataDir,'draft.json'));
  counts.photoDraftRows=Array.isArray(draft.value?.rows)?draft.value.rows.length:0;
  if(draft.error||draft.exists&&!Array.isArray(draft.value?.rows))
    warn(report,'PHOTO_DRAFT_INVALID','high','Сохранённый черновик фото не читается');
  if(counts.photoDraftRows>2500)warn(report,'PHOTO_DRAFT_LIMIT','high',
    'Статистика обрабатывает максимум 2500 строк фотографий');
  const tasks=await json(path.join(dataDir,'tasks.json'));
  const taskList=Array.isArray(tasks.value)?tasks.value:[];
  counts.recentTasks=taskList.length;
  if(tasks.error||tasks.exists&&!Array.isArray(tasks.value))
    warn(report,'PHOTO_TASKS_INVALID','medium','История OCR заданий повреждена');
  counts.failedTasks=taskList.filter(x=>x.status==='error').length;
  counts.interruptedTasks=taskList.filter(x=>x.status==='processing').length;
  if(counts.interruptedTasks)warn(report,'PHOTO_TASKS_INTERRUPTED','medium',
    'Есть '+counts.interruptedTasks+' заданий с незавершённым статусом; после перезапуска статус может устареть');
  const sources=await directoryFiles(path.join(dataDir,'sources'));
  const sourceSet=new Set(sources);
  counts.savedSourceImages=sources.filter(x=>x.endsWith('.jpg')).length;
  let missingSources=0;
  for(const task of taskList){
    if(task.status!=='done'||!task.sourceId)continue;
    if(!sourceSet.has(task.sourceId+'.jpg'))missingSources++;
  }
  counts.missingTaskImages=missingSources;
  if(missingSources)warn(report,'PHOTO_SOURCES_MISSING','high',
    'Для '+missingSources+' завершённых задач отсутствует исходное фото');
  const vehicles=await json(path.join(legion,'vehicles.json'));
  counts.vehicles=Array.isArray(vehicles.value)?vehicles.value.length:0;
  if(vehicles.error||vehicles.exists&&!Array.isArray(vehicles.value))
    warn(report,'VEHICLE_REGISTRY_INVALID','high','Справочник автомобилей повреждён');
  report.ok=!findings.some(f=>f.severity==='high');
  return report;
}
