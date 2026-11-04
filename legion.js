// Legion CSV reporting workspace. Independent from photo OCR so each can run on its own.
const $=id=>document.getElementById(id);
const state={importId:null,preview:null,vehicles:[],reports:[],busy:false,lastReport:null};
const setBusy=flag=>{
  state.busy=flag;
  for(const id of ['legionCsvFile','legionMasterFile','legionGenerate','legionDownloadZip','legionExportMaster']){
    const el=$(id);if(el)el.disabled=flag||(id==='legionDownloadZip'&&!state.lastReport)||
      (id==='legionGenerate'&&!state.importId);
  }
};
function showPage(name){
  const legion=name==='legion',analytics=name==='analytics',photo=!legion&&!analytics;
  $('photoWorkspace').hidden=!photo;
  $('legionWorkspace').hidden=!legion;
  $('analyticsWorkspace').hidden=!analytics;
  for(const [id,active] of [['navPhoto',photo],['navLegion',legion],['navAnalytics',analytics]]){
    $(id).classList.toggle('active',active);
    $(id).setAttribute('aria-current',active?'page':'false');
  }
  document.title=(legion?'Легион · отчёты':analytics?'Статистика':'Распознавание фото')+' — TENSEI';
  if(legion)void Promise.all([refreshBase(),refreshReports()]).catch(e=>notice(e.message,'error'));
  document.dispatchEvent(new window.CustomEvent('tensei:page',{detail:{page:name}}));
}
$('navPhoto').onclick=()=>showPage('photo');
$('navLegion').onclick=()=>showPage('legion');
$('navAnalytics').onclick=()=>showPage('analytics');
document.querySelector('.toplink')?.addEventListener('click',()=>showPage('photo'));
function notice(value,type='info'){
  const el=$('legionNotice');el.hidden=!value;
  el.textContent=String(value||'');el.className='notice '+type;
}
async function api(route,data,method='POST'){
  const opts={method,headers:{}};
  if(data!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(data)}
  let r;try{r=await fetch('/api/legion/'+route,opts)}
  catch{throw Error('Локальный сервер TENSEI не отвечает. Перезапустите TENSEI.bat.')}
  let json;try{json=await r.json()}catch{throw Error('Не удалось прочитать ответ программы')}
  if(!r.ok)throw Error(json.error||'Ошибка сервера HTTP '+r.status);
  return json;
}
const formatTons=n=>Number(n||0).toLocaleString('ru-RU',{minimumFractionDigits:3,maximumFractionDigits:3});
async function downloadBlob(url,filename){
  const res=await fetch(url);
  if(!res.ok){
    let message='Не удалось скачать файл: HTTP '+res.status;
    try{message=(await res.json()).error||message}catch{}
    throw Error(message);
  }
  const blob=await res.blob(),href=URL.createObjectURL(blob);
  try{
    const link=document.createElement('a');
    link.href=href;link.download=filename;
    document.body.append(link);link.click();link.remove();
  }finally{setTimeout(()=>URL.revokeObjectURL(href),15000)}
}
function readAsDataURL(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(Error('Не удалось открыть '+file.name));
    reader.readAsDataURL(file);
  });
}
async function refreshBase(){
  const result=await api('base',undefined,'GET');
  state.vehicles=Array.isArray(result.vehicles)?result.vehicles:[];
  $('legionBaseStatus').textContent='В справочнике '+state.vehicles.length+
    ' автомобилей. Для новых номеров нужно указать модель и водителя.';
  drawBase();
  return state.vehicles;
}
function drawBase(){
  const box=$('legionBaseList');box.replaceChildren();
  const q=$('legionBaseSearch').value.toLocaleUpperCase('ru-RU').replace(/\s/g,'');
  const list=state.vehicles.filter(v=>[v.plate,v.displayPlate,v.model,v.driver]
    .some(x=>String(x||'').toLocaleUpperCase('ru-RU').replace(/\s/g,'').includes(q)));
  if(!list.length){const p=document.createElement('p');p.className='help';p.textContent='Совпадений нет. Добавьте автомобиль выше.';box.append(p);return}
  const frag=document.createDocumentFragment();
  for(const v of list.slice(0,400)){
    const button=document.createElement('button');button.className='legion-base-entry';button.type='button';
    const no=document.createElement('strong');no.textContent=v.displayPlate||v.plate;
    const desc=document.createElement('span');desc.textContent=(v.model||'НЕТ МОДЕЛИ')+' · '+(v.driver||'НЕТ ВОДИТЕЛЯ');
    button.append(no,desc);
    button.onclick=()=>{
      $('legionPlate').value=v.plate;
      $('legionModel').value=v.model||'';
      $('legionDriver').value=v.driver||'';
      $('legionPlate').scrollIntoView({behavior:'smooth',block:'center'});
      $('legionModel').focus();
    };
    frag.append(button);
  }
  box.append(frag);
}
$('legionBaseSearch').oninput=drawBase;
$('legionVehicleForm').onsubmit=async event=>{
  event.preventDefault();
  if(state.busy)return;
  const plate=$('legionPlate').value.trim(),model=$('legionModel').value.trim(),
    driver=$('legionDriver').value.trim();
  if(!plate)return notice('Введите госномер автомобиля.','error');
  setBusy(true);
  try{
    await api('vehicle',{plate,model,driver});
    window.dispatchEvent(new window.Event('tensei:legion-updated'));
    $('legionVehicleForm').reset();
    await refreshBase();
    if(state.importId)await restorePreview(state.importId);
    notice('Запись автомобиля сохранена. Следующие отчёты будут использовать её.','success');
  }catch(e){notice('Не удалось сохранить автомобиль: '+e.message,'error')}
  finally{setBusy(false)}
};
$('legionMasterFile').onchange=async event=>{
  const file=event.target.files?.[0];event.target.value='';
  if(!file)return;
  if(file.size>8*1024*1024)return notice('Файл Excel больше 8 МБ.','error');
  setBusy(true);
  $('legionBaseStatus').textContent='Импортирую автомобили из '+file.name+'…';
  try{
    const result=await api('import-master',{file:await readAsDataURL(file)});
    await refreshBase();
    if(state.importId)await restorePreview(state.importId);
    const details=result.errors?.length?' Ошибки строк: '+result.errors.slice(0,3).join(' | '):'';
    notice('Импортировано из «'+result.source+'»: '+result.imported+
      ' машин, в базе всего '+result.count+'.'+details,
      result.errors?.length?'info':'success');
  }catch(e){notice('Ошибка импорта Excel: '+e.message,'error');await refreshBase().catch(()=>{})}
  finally{setBusy(false)}
};
$('legionExportMaster').onclick=async()=>{
  try{await downloadBlob('/api/legion/master','Легион_мастер_отчетов.xlsx')}
  catch(e){notice(e.message,'error')}
};
function dataCell(value){
  const td=document.createElement('td');td.textContent=String(value??'');return td;
}
function showUnknown(unknown){
  const box=$('legionUnknown');box.replaceChildren();
  const items=Object.values(unknown||{});
  box.hidden=items.length===0;
  if(!items.length)return;
  const title=document.createElement('strong');title.textContent=
    'Неполные данные в «База ТС»: '+items.length+' машин. В отчёте будет «НЕТ В БАЗЕ».';
  box.append(title);
  const list=document.createElement('div');list.className='legion-unknown-list';
  for(const item of items){
    const button=document.createElement('button');button.type='button';button.textContent=item.plate;
    button.title='Из CSV: '+(item.csvDriver||'водитель не указан')+'. Заполните модель и водителя вручную.';
    button.onclick=()=>{
      $('legionPlate').value=item.plate;$('legionModel').value='';
      $('legionDriver').value='';
      $('legionPlate').scrollIntoView({behavior:'smooth',block:'center'});
      $('legionModel').focus();
    };
    list.append(button);
  }
  box.append(list);
}
function drawPreview(result){
  state.preview=result;state.importId=result.importId;
  $('legionStatTrips').textContent=result.count||0;
  $('legionStatTons').textContent=formatTons(result.summary?.tonnes||0);
  $('legionStatProducts').textContent=result.groups?.length||0;
  $('legionStatUnknown').textContent=result.summary?.unknownVehicles?.length||0;
  $('legionCsvFileName').textContent=result.source||'Импортированный файл';
  $('legionPreviewEmpty').hidden=true;$('legionPreview').hidden=false;
  $('legionGroups').replaceChildren();
  const fragment=document.createDocumentFragment();
  for(const g of result.groups||[]){
    const tr=document.createElement('tr');
    tr.append(dataCell((g.dates||[]).map(d=>d.split('-').reverse().join('.')).join(', ')),
      dataCell(g.product),dataCell(g.count),dataCell(g.uniqueVehicles),dataCell(formatTons(g.tonnes)));
    fragment.append(tr);
  }
  $('legionGroups').append(fragment);
  const errors=$('legionErrors');errors.replaceChildren();
  errors.hidden=!(result.errors?.length);
  if(result.errors?.length){
    const strong=document.createElement('strong');
    strong.textContent='Ошибочных CSV-строк: '+result.errors.length+'. Автоматический отчёт не запустится, пока не подтвердите пропуск.';
    const p=document.createElement('p');p.textContent=result.errors.slice(0,10).join(' | ');
    errors.append(strong,p);
  }
  showUnknown(result.unknown);
  $('legionGenerate').disabled=false;
  $('legionImportStatus').textContent='Загружено '+result.count+
    ' рейсов. Групп отчётов: '+(result.groups?.length||0)+'.';
}
async function restorePreview(id){
  const result=await api('import/'+encodeURIComponent(id),undefined,'GET');
  drawPreview(result);return result;
}
$('legionCsvFile').onchange=async event=>{
  const file=event.target.files?.[0];event.target.value='';
  if(!file)return;
  if(file.size>15*1024*1024)return notice('CSV больше 15 МБ.','error');
  if(state.busy)return;
  setBusy(true);
  $('legionImportStatus').textContent='Читаю '+file.name+'…';
  try{
    const result=await api('import-csv',{file:await readAsDataURL(file),name:file.name});
    window.dispatchEvent(new window.Event('tensei:legion-updated'));
    drawPreview(result);
    notice('CSV прочитан: '+result.count+' рейсов, '+(result.groups?.length||0)+
      ' товаров. '+(result.summary?.unknownVehicles?.length||0)+' автомобилей с неполными данными.',
      result.errors?.length?'info':'success');
    if($('legionAutoGenerate').checked&&!result.errors?.length){
      setBusy(false);await generate();
    }
  }catch(e){$('legionImportStatus').textContent='Ошибка импорта CSV';notice(e.message,'error')}
  finally{setBusy(false)}
};
async function generate(){
  if(!state.importId||state.busy)return;
  setBusy(true);
  $('legionOutputStatus').textContent='Формирую отчёты Excel и ZIP…';
  try{
    const coefficient=$('legionCoefficient').value.trim().replace(',','.');
    const response=await api('generate',{importId:state.importId,coefficient,
      acceptSkipped:$('legionAcceptSkipped').checked});
    state.lastReport=response;
    $('legionOutputStatus').textContent='Готово. Создано '+response.files.length+
      ' Excel-отчётов. Папка: '+response.folder;
    notice('Отчёты созданы и сохранены рядом с TENSEI. '+response.files.map(f=>
      f.product+': '+f.count+' рейсов, '+formatTons(f.tonnes)+' т').join(' | '),
      'success');
    await refreshReports().catch(()=>{});
    await downloadBlob('/api/legion/download/'+response.reportId,response.zip);
  }catch(e){$('legionOutputStatus').textContent='Ошибка формирования отчётов';notice(e.message,'error')}
  finally{setBusy(false)}
}
$('legionGenerate').onclick=generate;
$('legionDownloadZip').onclick=async()=>{
  if(!state.lastReport)return;
  try{await downloadBlob('/api/legion/download/'+state.lastReport.reportId,state.lastReport.zip)}
  catch(e){notice('ZIP не скачался: '+e.message,'error')}
};
async function refreshReports(){
  const response=await api('reports',undefined,'GET');
  state.reports=response.reports||[];
  $('legionReportsFolder').textContent='Файлы сохраняются в: '+response.folder;
  const box=$('legionReportHistory');box.replaceChildren();
  if(!state.reports.length){
    const p=document.createElement('p');p.className='help';p.textContent='Готовых отчётов пока нет.';box.append(p);return;
  }
  const fragment=document.createDocumentFragment();
  for(const entry of state.reports.slice(0,15)){
    const div=document.createElement('div');div.className='legion-report-entry';
    const text=document.createElement('div'),name=document.createElement('strong'),desc=document.createElement('small');
    name.textContent=entry.zip;
    desc.textContent=(entry.files?.length||0)+' файлов · '+(entry.files||[]).map(x=>
      x.product+': '+x.count+' рейсов').join(' · ');
    text.append(name,desc);
    const btn=document.createElement('button');btn.type='button';btn.className='button button-outline';
    btn.textContent='Скачать';btn.onclick=()=>downloadBlob('/api/legion/download/'+entry.id,entry.zip)
      .catch(e=>notice(e.message,'error'));
    div.append(text,btn);fragment.append(div);
  }
  box.append(fragment);
}

function initLegionTooltips(){
  const tips={
    legionCsvFile:'Выберите CSV, выгруженный карьером. Данные читаются локально, без Cloud.ru. Поддерживаются CP1251 и UTF-8.',
    legionStatTrips:'Количество строк-рейсов в загруженном CSV; повторные рейсы одной машины считаются отдельно.',
    legionStatTons:'Сумма Нетто (кг) / 1000. Источник: колонка Нетто (или Брутто − Тара) в CSV.',
    legionStatProducts:'Сколько разных наименований товаров в этом файле. «Скала» и «СКАЛА +» отдельно.',
    legionStatUnknown:'Госномера, для которых в локальной Базе ТС нет машины, модели или водителя.',
    legionMasterFile:'Загрузите XLSX с листом «База ТС». Если его нет, TENSEI попробует извлечь госномер, модель и водителя из старого отчёта.',
    legionPlate:'Введите госномер. Пробелы, регион и похожие русские/латинские буквы нормализуются при сопоставлении.',
    legionModel:'Марка и модель из вашей базы, например FAW или Scania; приложение не угадывает её.',
    legionDriver:'Водитель — только достоверные сведения. Оставьте пустым, если неизвестен.',
    legionCoefficient:'Коэффициент 1,55 сохранён из старого Excel. Формула итога: тонны / коэффициент. Это не физические тонно-километры.',
    legionAutoGenerate:'Когда CSV полностью корректен, отчёты формируются после выбора файла без отдельной кнопки.',
    legionAcceptSkipped:'Включайте только после просмотра ошибок CSV: пропущенные строки не попадут в итоговые отчёты.',
    legionGenerate:'Создаёт отдельный XLSX по каждой паре дата/товар и общий ZIP в reports/Легион.',
    legionDownloadZip:'Скачивает уже сформированный архив XLSX. Исходники остаются в папке reports/Легион.',
    legionBaseStatus:'Источник: локальная data/legion/vehicles.json. Без импорта мастер-файла база изначально пуста.',
    legionBaseSearch:'Поиск по номеру ТС, модели и водителю в локальной базе.',
    legionReportsFolder:'Путь к локальным файлам XLSX и ZIP, созданным после генерации.',
    legionStatUnknown:'Машины без заполненной модели или водителя считаются нуждающимися в проверке.'};
  for(const [id,text] of Object.entries(tips)){
    const el=$(id);if(el){el.title=text;el.setAttribute('data-explain',text)}
  }
  const sections=[
    ['legionCsvFileName','Требуются исходные CSV карьера. Поля: ТС, Товар, Дата и Нетто (либо Брутто + Тара).'],
    ['legionImportStatus','В строках CSV отображаются ошибки, например отсутствие даты или некорректный вес.'],
    ['legionOutputStatus','Показаны результаты формирования XLSX и путь к каталогу reports/Легион.'],
    ['legionBaseList','Нажмите на машину в списке, чтобы заполнить поля редактирования.']
  ];
  for(const [id,text] of sections)if($(id))$(id).title=text;
}

async function initLegion(){
  initLegionTooltips();
  setBusy(false);
  try{
    await Promise.all([refreshBase(),refreshReports()]);
    const history=await api('imports',undefined,'GET');
    if(history.imports?.length)await restorePreview(history.imports[0].id);
  }catch(e){notice('Ошибка загрузки раздела Легион: '+e.message,'error')}
}
initLegion();
