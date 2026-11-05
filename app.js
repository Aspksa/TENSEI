import {humorCategory,createHumorRotator} from './humor-messages.js';
const $=id=>document.getElementById(id);
const state={rows:[],queue:[],busy:false,revision:0,saveTimer:null,savePending:Promise.resolve(),previewUrl:null,hasKey:false};
const columns=['tripDate','time','vehicle','driver','product','tare','gross','net','note'];
const titles={tripDate:'Дата рейса',time:'Время',vehicle:'Номер ТС',driver:'Водитель',product:'Товар',tare:'Тара',gross:'Брутто',net:'Нетто',note:'Примечание'};

async function updateRapidStatus(){
  try{
    const response=await fetch('/api/ocr-health');
    if(!response.ok)return;
    const data=await response.json(),target=$('rapidOCRStatus');
    if(target)target.textContent=data.rapid?.available?
      'RapidOCR CPU готов · локальная обработка по одному запросу':
      'RapidOCR CPU необязателен · '+(data.rapid?.reason||'используется существующий OCR');
  }catch{const target=$('rapidOCRStatus');if(target)target.textContent='RapidOCR CPU не настроен'}
}
void updateRapidStatus();
function status(message,kind='info'){
  const box=$('notice');
  box.hidden=!message;
  box.textContent=String(message||'');
  box.className='notice '+kind;
}
async function api(route,data,method='POST'){
  const options={method,headers:{}};
  if(data!==undefined){options.headers['Content-Type']='application/json';options.body=JSON.stringify(data)}
  let response;
  try{response=await fetch('/api/'+route,options)}
  catch{throw Error('Локальный сервер не отвечает. Перезапустите TENSEI.bat.')}
  if(route==='export'&&response.ok)return response.blob();
  let result;
  try{result=await response.json()}catch{throw Error('Сервер вернул некорректный ответ')}
  if(!response.ok)throw Error(result.error||'Ошибка HTTP '+response.status);
  return result;
}
const text=(v)=>String(v??'');
function asWeight(v){
  if(v===null||v===undefined||String(v).trim()==='')return null;
  let s=String(v).trim().replace(/[\s\u00a0]/g,'');
  if(/^\d{1,3}[.,]\d{3}$/.test(s))s=s.replace(/[.,]/g,'');
  else s=s.replace(',','.');
  if(!/^\d+(?:\.\d+)?$/.test(s))return NaN;
  return Number(s);
}
function inspect(items){
  const seen=new Set();
  return items.map((row,index)=>{
    const issues=[];
    if(row.uncertain&&!row.reviewed)issues.push('Модель не уверена в записи');
    if(!text(row.vehicle).trim())issues.push('Нет номера автомобиля');
    if(row.tripDate&&!/^\d{4}-\d{2}-\d{2}$/.test(row.tripDate))issues.push('Проверьте дату рейса');
    if(row.vehicleUnlisted&&!row.reviewed)issues.push('ТС нет в подтверждённом справочнике');
    if(row.time&&!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(row.time))issues.push('Проверьте время');
    const gross=asWeight(row.gross),tare=asWeight(row.tare),net=asWeight(row.net);
    if(gross===null&&net===null)issues.push('Нет данных о весе');
    for(const [label,v] of [['Тара',tare],['Брутто',gross],['Нетто',net]]){
      if(v!==null&&(!Number.isFinite(v)||v<0||v>150000))issues.push(label+': некорректное значение');
    }
    if(Number.isFinite(gross)&&Number.isFinite(tare)&&gross<tare)issues.push('Брутто меньше тары');
    if(Number.isFinite(gross)&&Number.isFinite(tare)&&Number.isFinite(net)&&Math.abs(gross-tare-net)>1)issues.push('Брутто − тара ≠ нетто');
    if(Number.isFinite(net)&&net>45000)issues.push('Нетто больше 45 т');
    if(net===0)issues.push('Нулевой вес');
    const fingerprint=[row.tripDate,row.time,row.vehicle,row.tare,row.gross,row.net].join('|');
    if(row.vehicle&&seen.has(fingerprint))issues.push('Возможная повторная запись');
    seen.add(fingerprint);
    return {row,index,issues};
  });
}
function exportReadiness(rows){
  const checks=inspect(rows);
  const reviewPending=checks.filter(x=>!x.row.reviewed).map(x=>x.index+1);
  const invalid=checks.filter(x=>x.issues.length).map(x=>({row:x.index+1,issues:x.issues}));
  return {ready:checks.length>0&&!reviewPending.length&&!invalid.length,
    reviewPending,invalid};
}
function statusLabel(task){
  if(task.status==='done')return 'Готово · '+(task.rowCount||0)+' строк';
  if(task.status==='error')return 'Ошибка · '+String(task.error||'нет подробностей').slice(0,90);
  if(task.status==='processing')return 'Обработка · '+(task.phase||'подготовка')+' · '+
    Math.min(99,Math.max(0,Number(task.progress)||0))+'%';
  return 'В очереди';
}
let lastVerifiedExcelSignature='',verifiedExcelTimer=null,exportInFlight=false;
function scheduleVerifiedExcel(){
  clearTimeout(verifiedExcelTimer);
  if(state.busy||!$('autoExcel')?.checked||state.rows.length===0)return;
  const checked=inspect(state.rows);
  if(checked.some(({row,issues})=>!row.reviewed||issues.length))return;
  const signature=JSON.stringify(state.rows);
  if(signature===lastVerifiedExcelSignature)return;
  verifiedExcelTimer=setTimeout(()=>{
    if(state.busy||!$('autoExcel').checked||state.rows.some(r=>!r.reviewed)||inspect(state.rows).some(x=>x.issues.length))return;
    void downloadExcel({verifiedOnly:true,signature});
  },850);
}
function updateSummary(){
  const examined=inspect(state.rows),numIssues=examined.filter(x=>x.issues.length||!x.row.reviewed).length;
  const kilos=state.rows.reduce((sum,row)=>{const v=asWeight(row.net);return sum+(Number.isFinite(v)?v:0)},0);
  $('metricRows').textContent=state.rows.length;
  $('metricIssues').textContent=numIssues;
  $('metricTons').textContent=(kilos/1000).toLocaleString('ru-RU',{minimumFractionDigits:3,maximumFractionDigits:3});
  $('auditCount').textContent=numIssues;
  $('download').disabled=state.rows.length===0||state.busy||exportInFlight;
  const pending=examined.filter(x=>!x.row.reviewed).length;
  const line=$('exportReadiness');
  if(line)line.textContent=state.rows.length===0?'Добавьте фотографии для формирования Excel.':
    pending===0&&numIssues===0?'Все строки подтверждены — Excel готов к автоматической выгрузке.':
    'На проверку: '+pending+' неподтверждённых строк; '+numIssues+' с замечаниями. Ручной Excel сохранит отметки проверки.';
}
function queueSave(){
  state.revision++;
  $('saveStatus').textContent='Изменения ещё не сохранены';
  clearTimeout(state.saveTimer);
  state.saveTimer=setTimeout(()=>{
    const version=state.revision;
    const copy=state.rows.map(x=>({...x}));
    state.savePending=state.savePending.catch(()=>{}).then(async()=>{
      const res=await api('draft',{rows:copy});
      if(version===state.revision)$('saveStatus').textContent='Сохранено локально';
      return res;
    }).catch(e=>{if(version===state.revision){$('saveStatus').textContent='Не удалось сохранить';status('Ошибка сохранения черновика: '+e.message,'error')}});
  },550);
}
function updateRecords(){
  updateSummary();
  scheduleVerifiedExcel();
  renderTable();
  renderAudit();
  queueSave();
}
function cell(index,key,row){
  const td=document.createElement('td');
  const input=document.createElement('input');
  input.type='text';input.value=text(row[key]);input.setAttribute('aria-label',titles[key]+'; строка '+(index+1));
  input.addEventListener('change',()=>{
    const value=input.value.trim();
    if(['tare','gross','net'].includes(key)&&value!==''&&!Number.isFinite(asWeight(value))){
      status('Неверное число в строке '+(index+1)+'. Используйте цифры, пробел и десятичную запятую.','error');
      input.value=text(row[key]);return;
    }
    const previousValue=row[key];
    row[key]=['tare','gross','net'].includes(key)?(value===''?null:asWeight(value)):value;
    if(key==='vehicle')row.vehicle=text(row.vehicle).toUpperCase();
    // A previously reviewed row needs a new manual review after any edit.
    if(previousValue!==row[key]){row.reviewed=false;
      if(key==='vehicle')row.vehicleUnlisted=true;}
    if(['tare','gross'].includes(key)&&row.net===null&&Number.isFinite(asWeight(row.gross))&&Number.isFinite(asWeight(row.tare))&&row.gross>=row.tare)row.net=row.gross-row.tare;
    updateRecords();
  });
  td.append(input);return td;
}
function renderTable(){
  const tbody=$('rowsBody');tbody.replaceChildren();
  const query=$('search').value.trim().toLowerCase(),onlyIssues=$('onlyIssues').checked;
  const selection=inspect(state.rows).filter(({row,issues})=>(!onlyIssues||issues.length||!row.reviewed)&&(!query||[row.time,row.vehicle,row.driver,row.product,row.note,row.source].some(x=>text(x).toLowerCase().includes(query))));
  const fragment=document.createDocumentFragment();
  for(const {row,index,issues} of selection){
    const tr=document.createElement('tr');
    tr.addEventListener('click',()=>showSource(row));
    tr.dataset.row=String(index);if(issues.length)tr.className='issue-row';
    const number=document.createElement('td');number.textContent=String(index+1);tr.append(number);
    for(const key of columns)tr.append(cell(index,key,row));
    const reviewed=document.createElement('td'),check=document.createElement('input');
    check.type='checkbox';check.checked=!!row.reviewed;check.setAttribute('aria-label','Строка '+(index+1)+' сверена с фотографией');
    check.onchange=()=>{row.reviewed=check.checked;updateRecords()};
    reviewed.append(check);tr.append(reviewed);
    const issue=document.createElement('td'),flag=document.createElement('span');
    flag.className='flag'+(issues.length?' issue':'');
    flag.textContent=issues.length?'⚠ '+issues.length+' замеч.':row.reviewed?'✓ Сверено':'◷ Сверить';
    flag.title=[...issues,...(!row.reviewed?['Не подтверждено по фото']:[])].join('; ');issue.append(flag);tr.append(issue);
    const control=document.createElement('td'),remove=document.createElement('button');
    remove.type='button';remove.className='row-remove';remove.textContent='×';
    remove.title='Удалить строку '+(index+1);
    remove.onclick=()=>{if(confirm('Удалить строку '+(index+1)+'?')){state.rows.splice(index,1);updateRecords()}};
    if(row.sourceId){const photo=document.createElement('button');photo.type='button';photo.className='row-photo';photo.textContent='Фото';
      photo.title='Открыть исходный снимок и увеличенный фрагмент';
      photo.onclick=event=>{event.stopPropagation();showSource(row);$('upload').scrollIntoView({behavior:'smooth',block:'start'});};
      control.append(photo);}
    control.append(remove);tr.append(control);fragment.append(tr);
  }
  tbody.append(fragment);
  $('emptyTable').hidden=selection.length>0;
  $('emptyTable').textContent=state.rows.length?'Не найдено подходящих строк. Сбросьте фильтр или поиск.':'Пока нет записей. Загрузите фотографию или добавьте строку вручную.';
  $('tableCount').textContent='Показано '+selection.length+' из '+state.rows.length+' строк';
}
function renderAudit(){
  const area=$('auditList');area.replaceChildren();
  const issues=inspect(state.rows).filter(x=>x.issues.length||!x.row.reviewed);
  if(!issues.length){
    const p=document.createElement('p');p.className='audit-empty';p.textContent=state.rows.length?'Автоматических замечаний нет. Сверьте цифры с оригиналами.':'Замечания появятся после распознавания.';area.append(p);return;
  }
  const fragment=document.createDocumentFragment();
  for(const item of issues){
    const div=document.createElement('div');div.className='audit-item';
    const desc=document.createElement('div'),title=document.createElement('strong'),p=document.createElement('p');
    title.textContent='Строка '+(item.index+1)+' · '+(item.row.vehicle||'номер не указан');
    p.textContent=[...item.issues,...(!item.row.reviewed?['Не подтверждено по фотографии']:[])].join(' · ');
    desc.append(title,p);
    const btn=document.createElement('button');btn.className='button button-outline';btn.type='button';btn.textContent='Открыть строку';
    btn.onclick=()=>{
      $('onlyIssues').checked=false;$('search').value='';renderTable();
      document.querySelector('[data-row="'+item.index+'"]')?.scrollIntoView({behavior:'smooth',block:'center'});
    };
    div.append(desc,btn);fragment.append(div);
  }
  area.append(fragment);
}
function setConnection(label,stateName='pending'){
  const box=$('connectionStatus');box.textContent=label;box.className='connection '+stateName;
}
function populateModels(models,selected){
  const select=$('model');select.replaceChildren();
  const items=Array.isArray(models)&&models.length?models:[
    {id:'qwen/qwen3-vl-235b-a22b-instruct',name:'Qwen3 VL 235B — основная'},
    {id:'qwen/qwen3-vl-30b-a3b-instruct',name:'Qwen3 VL 30B — экономичная'}
  ];
  for(const item of items){
    const opt=document.createElement('option');opt.value=item.id;opt.textContent=item.name||item.id;select.append(opt);
  }
  if(selected&&!Array.from(select.options).some(o=>o.value===selected)){
    const custom=document.createElement('option');custom.value=selected;custom.textContent=selected+' (сохранена ранее)';select.append(custom);
  }
  select.value=selected||items[0].id;
}
function diagnostic(message,kind='info'){
  const box=$('connectionDetails');box.hidden=false;box.replaceChildren();
  const p=document.createElement('p');p.textContent=message;p.style.margin='0';box.append(p);
  if(kind==='error')box.style.borderColor='#dfaea8';else box.style.borderColor='';
  return box;
}
async function checkConnection(){
  const button=$('checkConnection');button.disabled=true;
  diagnostic('Проверяю каталог моделей Cloud.ru…');
  try{
    const result=await api('connection',undefined,'GET');
    if(!result.ok)throw Error(result.reason||'Нет API-ключа');
    if(result.available?.length){
      // Add real API model IDs to the selector; do not guess what is available.
      const modelSelect=$('model');
      for(const item of result.available){
        if(![...modelSelect.options].some(option=>option.value===item.id))
          modelSelect.add(new Option(item.name,item.id));
      }
    }
    if(result.selectedAvailable){
      setConnection('Модель доступна в каталоге','ok');
      diagnostic('Текущий режим «'+(result.costMode||'auto')+'» использует '+result.effectiveModel+
        '. Модель найдена в каталоге. Проверка не отправляла фотографию.');
    }else{
      setConnection('Модель не найдена','error');
      const panel=diagnostic(result.reason||'Выбранная модель недоступна по этому ключу.');
      if(result.available?.length){
        const suggestion=result.available[0];
        const btn=document.createElement('button');btn.className='button button-outline';btn.type='button';
        btn.textContent='Выбрать доступную: '+suggestion.name;
        btn.onclick=()=>{
          $('model').value=suggestion.id;
          $('costMode').value='auto';
          diagnostic('Выбрана '+suggestion.id+'; режим переключён на «Авто» (сейчас он использует выбранную модель). Нажмите «Сохранить», затем «Проверить подключение».');
        };
        panel.append(btn);
      }else{
        const p=document.createElement('p');
        p.textContent='В доступном каталоге не найдено подходящих моделей для фотографий. Проверьте права на Foundation Models.';
        panel.append(p);
      }
    }
  }catch(e){
    setConnection('Не удалось проверить Cloud.ru','error');
    diagnostic(e.message,'error');
  }finally{button.disabled=false}
}
$('settingsForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const btn=$('saveSettings');btn.disabled=true;
  try{
    const result=await api('settings',{
      key:$('apiKey').value.trim(),model:$('model').value,fallback:$('fallback').checked,
      enhance:$('enhance').checked,cropRecovery:$('cropRecovery').checked,
      paddle:$('paddle').checked,chandra:$('chandra').checked,mineru:$('mineru').checked,
      localText:$('localText').checked,localVl:$('localVl').checked,cvPreprocess:$('cvPreprocess').checked,
      autoPipeline:$('autoPipeline').checked,digitCellOcr:$('digitCellOcr').checked,
      gridSegmentation:$('gridSegmentation').checked,
      costMode:$('costMode').value,maxCloudCalls:Number($('maxCloudCalls').value)
    });
    state.hasKey=result.hasKey;
    $('apiKey').value='';
    $('settingsHelp').textContent=result.hasKey
      ?'Ключ сохранён локально. Нажмите «Проверить подключение» — так вы увидите, доступна ли модель.'
      :'Ключ не задан. Введите API-ключ Cloud.ru и сохраните настройки.';
    setConnection(result.hasKey?'Ключ сохранён, модель не проверена':'Нужен API-ключ',result.hasKey?'pending':'error');
    status('Настройки сохранены.','success');
    if(result.hasKey)await checkConnection();
  }catch(e){status('Настройки не сохранились: '+e.message,'error');diagnostic(e.message,'error')}
  finally{btn.disabled=false}
});
$('checkConnection').onclick=checkConnection;
function queueFiles(chosen){
  const bad=[];
  for(const file of chosen){
    if(file.size>20*1024*1024){bad.push(file.name+' (больше 20 МБ)');continue}
    const allowed=/\.(jpe?g|png|webp|gif|tiff?|bmp|avif|heic|heif|svg)$/i.test(file.name)||file.type.startsWith('image/');
    if(!allowed){bad.push(file.name+' (неизвестный формат)');continue}
    if(state.queue.some(f=>f.name===file.name&&f.size===file.size&&f.lastModified===file.lastModified))continue;
    state.queue.push(file);
  }
  drawQueue();
  if(state.queue.length){
    try{showPreview(state.queue[0])}
    catch(e){status('Файл добавлен, но предпросмотр не работает: '+e.message,'error')}
    const message='Добавлено фотографий: '+state.queue.length+'. '+
      (state.hasKey?'Нажмите «Обработать автоматически» для запуска Cloud.ru.':
        'Сначала сохраните API-ключ Cloud.ru в настройках. Без ключа доступна локальная проверка.');
    $('uploadFeedback').textContent=message;
    $('progressStatus').textContent=message;
    $('recognize').focus();
    if($('autoRecognize').checked&&state.hasKey&&!state.busy){
      // Only after explicit opt-in: OCR can create paid Cloud.ru requests.
      void Promise.resolve().then(()=>$('recognize').click());
    }
  }else{$('uploadFeedback').textContent='Очередь пуста. Добавьте фотографию.'}
  if(bad.length)status('Некоторые файлы не добавлены: '+bad.join(', '),'error');
}
function drawQueue(){
  const list=$('fileQueue');list.replaceChildren();
  for(const [index,file] of state.queue.entries()){
    const div=document.createElement('div');div.className='queue-item';
    const name=document.createElement('span');name.textContent=file.name;
    const size=document.createElement('small');size.textContent=(file.size/1024/1024).toFixed(1)+' МБ';
    const del=document.createElement('button');del.type='button';del.textContent='×';del.title='Убрать файл';
    del.disabled=state.busy;
    del.onclick=()=>{state.queue.splice(index,1);drawQueue();showPreview(state.queue[0])};
    div.append(name,size,del);list.append(div);
  }
  $('queuedCount').textContent=state.queue.length?'('+state.queue.length+')':'';
  $('recognize').disabled=state.busy||state.queue.length===0;
  // Preserve the nested queuedCount span. Setting button.textContent
  // would remove it and crash the next file-upload event.
  const label=$('recognizeLabel');
  label.textContent=state.busy?'Идёт распознавание…':
    state.queue.length?'Обработать фото через Cloud.ru':'Обработать фото через Cloud.ru';
  $('clearQueue').disabled=state.busy||state.queue.length===0;
  $('autoRecognize').disabled=state.busy;
}
let gridBoxes=[];
function drawPreviewGrid(boxes=gridBoxes){
  const layer=$('gridOverlay'),img=$('previewImage');
  layer.replaceChildren();
  if(!img.naturalWidth||!img.naturalHeight||img.hidden)return;
  const area=$('previewSurface');
  const scale=Math.min(area.clientWidth/img.naturalWidth,area.clientHeight/img.naturalHeight);
  const dx=(area.clientWidth-img.naturalWidth*scale)/2;
  const dy=(area.clientHeight-img.naturalHeight*scale)/2;
  for(const b of boxes.slice(0,700)){
    if(!Array.isArray(b)||b.length!==4||b.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)||b[2]<=b[0]||b[3]<=b[1])continue;
    const el=document.createElement('div');el.className='grid-cell';
    Object.assign(el.style,{left:(dx+b[0]*img.naturalWidth*scale)+'px',
      top:(dy+b[1]*img.naturalHeight*scale)+'px',
      width:((b[2]-b[0])*img.naturalWidth*scale)+'px',
      height:((b[3]-b[1])*img.naturalHeight*scale)+'px'});
    layer.append(el);
  }
}
$('detectGrid').onclick=async()=>{
  if(state.busy||!state.queue.length)return status('Выберите фотографию в очереди.','info');
  const file=state.queue[0],button=$('detectGrid');
  button.disabled=true;
  try{
    const result=await api('layout',{image:await fileData(file)});
    gridBoxes=Array.isArray(result.cells)?result.cells:[];
    drawPreviewGrid();
    $('qualityStatus').textContent=gridBoxes.length
      ?'Локально обнаружено '+gridBoxes.length+' ячеек, '+(result.rows?.length||0)+' строк. Сверьте сетку визуально.'
      :'Локально сетка не обнаружена: попробуйте PP-StructureV3 или другое фото.';
  }catch(e){status('Локальное выделение недоступно: '+e.message+'. Проверьте запуск Paddle-сервиса и OpenCV.','error')}
  finally{button.disabled=false}
};
$('perspectivePreview').onclick=async()=>{
  if(state.busy||!state.queue.length)return status('Выберите фотографию.','info');
  const button=$('perspectivePreview'),panel=$('perspectiveResult');
  button.disabled=true;
  try{
    const file=state.queue[0];
    const result=await api('perspective-preview',{image:await fileData(file)});
    $('perspectiveNote').textContent=result.applied?
      'Исправление перспективы показано отдельно. Исходник и координаты OCR не изменены.':
      'Надёжный контур листа не найден: '+(result.reason||'оригинал сохранён');
    $('perspectiveImage').hidden=!result.applied;
    if(result.applied)$('perspectiveImage').src=result.image;
    panel.hidden=false;
  }catch(e){status('Не удалось построить предпросмотр: '+e.message,'error')}
  finally{button.disabled=false}
};
$('localRead').onclick=async()=>{
  if(state.busy||!state.queue.length)return status('Выберите фотографию для локального чтения.','info');
  const file=state.queue[0],button=$('localRead'),out=$('localReadResults');
  button.disabled=true;
  try{
    const result=await api('local-recognize',{image:await fileData(file)});
    const cells=result.digitCells?.cells||[];
    const lines=result.localText||[];
    out.replaceChildren();
    const header=document.createElement('p');
    header.textContent='Локально: '+cells.length+' ячеек, '+lines.length+' строк текста. Cloud.ru: 0 запросов. Данные не подтверждены.';
    out.append(header);
    for(const cell of cells.slice(0,36)){
      const item=document.createElement('div');
      item.textContent=(cell.text||'не прочитано')+' · '+(cell.cached?'кэш':'OCR')+
        ' · '+(cell.numericCandidate?'числовой кандидат':'нужна проверка');
      out.append(item);
    }
    if(!cells.length){for(const line of lines.slice(0,35)){
      const item=document.createElement('div');item.textContent=String(line.text||'');out.append(item);
    }}
    if(result.errors?.length){
      const err=document.createElement('p');
      err.textContent=result.errors.join(' · ');out.append(err);
    }
    out.hidden=false;
    gridBoxes=(result.layout?.cells||[]).slice(0,700);
    drawPreviewGrid();
  }catch(e){status('Локальное чтение: '+e.message,'error')}
  finally{button.disabled=false}
};
function showPreview(file){
  ++cropRequest;$('cropReview').hidden=true;$('cellReviewToolbar').hidden=true;
  gridBoxes=[];$('gridOverlay').replaceChildren();$('localReadResults').hidden=true;
  $('perspectiveResult').hidden=true;
  if(state.previewUrl)URL.revokeObjectURL(state.previewUrl);
  state.previewUrl=null;
  const img=$('previewImage');img.hidden=true;$('previewEmpty').hidden=false;
  $('highlightBox').hidden=true;
  $('previewFilename').textContent='';
  if(!file)return;
  $('previewFilename').textContent=file.name;
  let ticket;
  try{ticket=URL.createObjectURL(file);state.previewUrl=ticket}
  catch{
    // Some browser/privacy modes do not expose object URLs for local files.
    const fallback=fileData(file).then(data=>{
      if(state.queue.includes(file)){$('previewImage').src=data;
        $('previewFilename').textContent=file.name}
    }).catch(e=>status('Не удалось открыть фотографию: '+e.message,'error'));
    void fallback;
    $('qualityStatus').textContent='Файл добавлен; проверяю доступность просмотра…';
    return;
  }
  $('qualityStatus').textContent='Проверяю разрешение и качество фотографии локально…';
  fileData(file).then(image=>api('quality',{image}))
    .then(result=>{
      if(state.previewUrl!==ticket)return;
      $('qualityStatus').textContent=result.quality.warnings?.length?
        'Качество: '+result.quality.warnings.join(' · '):
        'Качество: '+result.quality.width+' × '+result.quality.height+
        ' пикселей; явных проблем не обнаружено.';
    }).catch(e=>{if(state.previewUrl===ticket)$('qualityStatus').textContent='Проверка качества не удалась: '+e.message});
  img.onload=()=>{img.hidden=false;$('previewEmpty').hidden=true;drawPreviewGrid()};
  img.onerror=()=>{img.hidden=true;$('previewEmpty').hidden=false;$('previewEmpty').textContent='Предпросмотр этого формата недоступен'};
  img.src=state.previewUrl;
}
function fileData(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(Error('Не удалось прочитать файл '+file.name));
    reader.readAsDataURL(file);
  });
}
const drop=$('dropzone');
drop.onclick=()=>$('photoFiles').click();
drop.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('photoFiles').click()}};
$('photoFiles').onchange=e=>{queueFiles([...e.target.files]);e.target.value=''};
for(const ev of ['dragenter','dragover'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.add('dragging')});
for(const ev of ['drop','dragleave'])drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('dragging')});
drop.addEventListener('drop',e=>queueFiles([...e.dataTransfer.files]));
$('runDiagnostics').onclick=async()=>{
  const button=$('runDiagnostics'),target=$('diagnosticsResults');
  button.disabled=true;target.textContent='Проверка локального сервера и сохранённых данных…';
  try{
    const report=await api('diagnostics',undefined,'GET');
    const lines=[
      report.checks.cloudKeyConfigured?'Cloud.ru: ключ сохранён':'Cloud.ru: ключ не настроен',
      'Сохранённых строк фото: '+(report.checks.savedPhotoRows??'ошибка'),
      'История заданий: '+(report.checks.photoTasks??'ошибка'),
      'Импортов «Легиона»: '+(report.checks.legionImports??'ошибка'),
      'RapidOCR: '+(report.checks.rapidOCR==='ready'?'работает':'необязательный модуль не запущен')
    ];
    if(report.checks.lastTask?.error)lines.push('Последняя ошибка фото: '+report.checks.lastTask.error);
    lines.push(...(report.warnings||[]).slice(0,8));
    target.replaceChildren();
    for(const line of lines){const p=document.createElement('p');p.textContent=line;target.append(p)}
  }catch(e){target.textContent='Диагностика недоступна: '+e.message}
  finally{button.disabled=false}
};
$('clearQueue').onclick=()=>{if(state.busy)return;state.queue=[];drawQueue();showPreview(null)};
$('recognize').onclick=async()=>{
  if(state.busy||!state.queue.length)return;
  if(!state.hasKey){
    $('uploadFeedback').textContent='Обработка не началась: требуется API-ключ Cloud.ru. Откройте настройки, сохраните ключ и повторите запуск.';
    $('settingsDetails').open=true;
    $('settings').scrollIntoView({behavior:'smooth',block:'start'});
    return status('Сначала введите API-ключ и сохраните настройки Cloud.ru.','error');
  }
  $('uploadFeedback').textContent='Обработка запущена. Прогресс и ошибки появятся ниже; не закрывайте вкладку.';
  state.busy=true;drawQueue();$('addRow').disabled=true;$('clearData').disabled=true;$('download').disabled=true;
  const batch=[...state.queue];state.queue=[];
  const batchStates=batch.map(file=>({file,status:'В очереди',kind:'queued'}));
  const batchBox=$('batchStatus');
  const updateBatch=(index,phase,kind)=>{
    batchStates[index].status=phase;batchStates[index].kind=kind;
    batchBox.replaceChildren();
    batchStates.forEach(entry=>{
      const node=document.createElement('div');node.className='batch-status-item '+entry.kind;node.setAttribute('role','listitem');
      const name=document.createElement('strong');name.textContent=entry.file.name;
      const label=document.createElement('span');label.textContent=entry.status;
      node.append(name,label);batchBox.append(node);
    });
  };
  if(batch.length)updateBatch(0,'Ожидает обработки','queued');
  const failed=[],failures=new Set();
  let done=0,usedModel='',activeIndex=0;
  let activePhase='Обработка';
  const nextJoke=createHumorRotator();
  const drawJoke=()=>{
    const output=$('humorCaption');
    if(!$('humorEnabled').checked){output.hidden=true;return}
    output.textContent=nextJoke(humorCategory(activePhase));
    output.hidden=false;
  };
  drawJoke();
  const jokeTimer=setInterval(drawJoke,4500);
  const updateSteps=step=>{const nodes=[...$('photoStatusSteps').children];nodes.forEach((node,i)=>{node.classList.toggle('active',i===step);node.classList.toggle('completed',i<step)});};
  updateSteps(0);
  const poll=setInterval(async()=>{try{const response=await api('tasks',undefined,'GET');const active=(response.tasks||[]).find(t=>t.status==='processing');if(active){activePhase=active.phase||'Обработка';if(activeIndex<batchStates.length)updateBatch(activeIndex,activePhase,'active');const phase=activePhase.toLowerCase();updateSteps(/формирован|провер|chandra|сомнител/.test(phase)?3:/cloud|ocr|распозн|строк/.test(phase)?2:/подготов|opencv|paddle|изображ/.test(phase)?1:0);const percent=Math.min(95,Math.round((activeIndex+(active.progress||10)/100)*100/batch.length));$('progressBar').style.width=percent+'%';$('progressStatus').textContent='Фото '+(activeIndex+1)+' из '+batch.length+' · '+(active.phase||'Обработка')+' · '+(active.model||'модель уточняется');}}catch{}},1200);
  try{
    for(const [index,file] of batch.entries()){
      activeIndex=index;
      $('progressStatus').textContent='Читаю '+(index+1)+' из '+batch.length+': '+file.name;
      $('progressBar').style.width=Math.round(index*100/batch.length)+'%';
      showPreview(file);
      updateBatch(index,'Подготовка фотографии','active');
      activePhase='Подготовка фотографии';drawJoke();
      try{
        const result=await api('recognize',{image:await fileData(file),name:file.name,
          templateId:$('templateSelect').value,force:$('forceReprocess')?.checked===true});
        if(!state.rows.some(x=>x.sourceId&&x.sourceId===result.sourceId))
          state.rows.push(...result.rows);
        usedModel=result.model||usedModel;
        const warnings=[...(result.warnings||[])];
        if(result.cached)warnings.unshift('Страница взята из кэша, повторная плата за распознавание не требуется.');
        if(result.quality?.warnings?.length||warnings.length)
          $('qualityStatus').textContent=[...new Set(warnings)].slice(0,4).join(' · ');
        else $('qualityStatus').textContent='Основные показатели качества фото без автоматических замечаний.';
        if(result.comparison?.raw){
          $('comparisonDetails').hidden=false;
          $('comparisonText').textContent=result.comparison.raw;
        }
        done++;
        updateBatch(index,result.cached?'Готово · из кэша':'Готово · '+(result.rows?.length||0)+' строк','done');
        updateSteps(4);
        updateRecords();
        await refreshTasks().catch(()=>{});
      }catch(e){failed.push(file);failures.add(e.message);updateBatch(index,'Ошибка · '+e.message.slice(0,100),'error');await refreshTasks().catch(()=>{})}
    }
    state.queue.push(...failed);
    $('progressBar').style.width='100%';
    updateSteps(failed.length?3:4);
    $('progressStatus').textContent='Готово: '+done+' из '+batch.length+' фото'+(usedModel?'. Модель: '+usedModel:'');
    $('uploadFeedback').textContent=failed.length?
      'Обработано '+done+' из '+batch.length+'. Ошибочные файлы остались в очереди — подробности ниже.':
      'Готово: '+done+' фото. Проверьте строки в таблице, затем скачайте Excel.';
    if(failed.length)status('Не обработано: '+failed.length+' фото. '+[...failures].slice(0,2).join(' | ')+' Неудачные файлы остались в очереди.','error');
    else status('Распознавание завершено. Проверьте записи в таблице и сохраните Excel.','success');
  }finally{
    clearInterval(poll);
    clearInterval(jokeTimer);
    $('humorCaption').hidden=true;
    state.busy=false;$('addRow').disabled=false;$('clearData').disabled=false;drawQueue();updateSummary();if(state.rows.length)queueSave();
  }
};
$('search').oninput=renderTable;
$('onlyIssues').onchange=renderTable;
$('reviewIssues').onclick=()=>{$('onlyIssues').checked=true;renderTable();$('results').scrollIntoView({behavior:'smooth',block:'start'});};
$('autoExcel').onchange=()=>{if($('autoExcel').checked)scheduleVerifiedExcel();};
$('navSettings').onclick=()=>{$('navPhoto').click();$('settingsDetails').open=true;};
document.querySelector('.toplink')?.addEventListener('click',()=>{$('settingsDetails').open=true;});
$('navReview').onclick=()=>{$('navPhoto').click();$('onlyIssues').checked=true;renderTable();};
$('addRow').onclick=()=>{
  if(state.busy)return;
  state.rows.push({time:'',vehicle:'',driver:'',product:'',tare:null,gross:null,net:null,note:'',source:'Вручную',uncertain:false,reviewed:false});
  updateRecords();$('results').scrollIntoView({behavior:'smooth',block:'start'});
};
async function downloadExcel({verifiedOnly=false,signature=null}={}){
  if(state.busy||!state.rows.length||exportInFlight)return;
  const readiness=exportReadiness(state.rows);
  if(verifiedOnly&&!readiness.ready)return;
  if(!verifiedOnly&&!readiness.ready){
    const ok=confirm('В реестре '+readiness.reviewPending.length+' неподтверждённых строк и '+
      readiness.invalid.length+' строк с замечаниями. Выгрузить Excel с пометками «Проверить»?');
    if(!ok)return;
  }
  exportInFlight=true;updateSummary();
  try{
    const blob=await api('export',{rows:state.rows.map(r=>({...r})),verifiedOnly});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;
    link.download=verifiedOnly?'TENSEI-проверено.xlsx':'TENSEI-черновик.xlsx';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    if(verifiedOnly)lastVerifiedExcelSignature=signature||JSON.stringify(state.rows);
    status(verifiedOnly?'Проверенный Excel подготовлен.':'Черновой Excel подготовлен с отметками замечаний.','success');
  }catch(e){status('Excel не выгружен: '+e.message,'error')}
  finally{exportInFlight=false;updateSummary()}
}
$('download').onclick=()=>{void downloadExcel()};

$('clearData').onclick=async()=>{
  if(state.busy)return;
  if(!confirm('Удалить все строки и сохранённый черновик?'))return;
  clearTimeout(state.saveTimer);
  const control=$('clearData');control.disabled=true;
  try{
    await state.savePending;
    await api('draft',undefined,'DELETE');
    state.rows=[];state.revision++;updateSummary();renderTable();renderAudit();
    $('saveStatus').textContent='Черновик очищен';
    status('Таблица очищена.','success');
  }catch(e){status('Не удалось очистить черновик: '+e.message,'error')}
  finally{control.disabled=false}
};
async function refreshTasks(){
  const result=await api('tasks',undefined,'GET');
  const tasks=(result.tasks||[]).slice(0,35);
  const box=$('taskHistory');box.replaceChildren();
  $('taskCount').textContent=tasks.length?'('+tasks.length+')':'';
  for(const task of tasks){
    const item=document.createElement('div');item.className='task-item';
    const name=document.createElement('strong');name.textContent=task.name||'Фото';
    const meta=document.createElement('small');
    meta.textContent=statusLabel(task);
    item.append(name,meta);
    if(task.status==='done'&&task.reportId){
      const view=document.createElement('button');view.type='button';view.className='button button-outline';
      view.textContent='Посмотреть ячейки';
      view.onclick=async()=>{try{await showReportCells(task)}
        catch(e){status('Не удалось показать ячейки: '+e.message,'error')}};
      item.append(view);
    }
    if(task.status==='done'&&task.reportId){
      const importBtn=document.createElement('button');importBtn.type='button';
      importBtn.className='button button-outline';importBtn.textContent='Добавить строки';
      importBtn.onclick=async()=>{
        if(state.busy)return;
        try{
          const report=await api('photo-report/'+task.reportId,undefined,'GET');
          if(!Array.isArray(report.rows)||!report.rows.length)throw Error('В отчёте нет строк');
          if(state.rows.some(r=>r.sourceId===report.sourceId))
            return status('Эта фотография уже добавлена в реестр.','info');
          if(!confirm('Добавить '+report.rows.length+' строк из '+(task.name||'фото')+' в черновик? Все значения необходимо сверить.'))return;
          state.rows.push(...report.rows.map(r=>({...r,reviewed:false})));
          updateRecords();
          status('Строки добавлены. Проверьте веса и номера ТС по оригиналу.','success');
        }catch(e){status('Не удалось добавить строки: '+e.message,'error')}
      };
      item.append(importBtn);
    }
    if(task.status==='done'&&task.reportId){
      const report=document.createElement('button');report.type='button';report.className='button button-outline';
      report.textContent='Отчёт JSON';report.onclick=async()=>{
        try{const record=await api('photo-report/'+task.reportId,undefined,'GET');
          const blob=new Blob([JSON.stringify(record,null,2)],{type:'application/json'});
          const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;
          a.download='TENSEI-photo-'+task.reportId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
        }catch(e){status('Не удалось загрузить отчёт: '+e.message,'error')}
      };item.append(report);
    }
    if(task.mineruTask?.taskId){
      const action=document.createElement('button');action.className='button button-outline';
      action.type='button';action.textContent='Статус MinerU';
      action.onclick=async()=>{
        action.disabled=true;
        try{
          const state=await api('mineru/'+encodeURIComponent(task.mineruTask.taskId),undefined,'GET');
          meta.textContent=(meta.textContent||'')+' · MinerU: '+state.status;
          action.textContent='Обновить MinerU';
        }catch(e){meta.textContent=(meta.textContent||'')+' · MinerU: '+e.message}
        finally{action.disabled=false}
      };
      item.append(action);
    }
    box.append(item);
  }
}
async function refreshTemplates(selected){
  const result=await api('templates',undefined,'GET');
  const target=$('templateSelect'),old=selected||target.value||'weights';
  target.replaceChildren();
  for(const template of result.templates||[]){
    const option=document.createElement('option');
    option.value=template.id;option.textContent=template.name;target.append(option);
  }
  if(Array.from(target.options).some(o=>o.value===old))target.value=old;
}
$('saveTemplate').onclick=async()=>{
  const button=$('saveTemplate');button.disabled=true;
  try{
    const result=await api('templates',{name:$('templateName').value,columns:$('templateColumns').value});
    await refreshTemplates(result.template.id);
    status('Шаблон «'+result.template.name+'» сохранён.','success');
  }catch(e){status('Шаблон не сохранился: '+e.message,'error')}
  finally{button.disabled=false}
};
let reviewCells=[],reviewSourceId='',cropRequest=0;
async function showRowCrop(sourceId,bbox,label='Строка'){
  const crop=$('cropReview'),note=$('cropStatus'),img=$('cropPreview'),side=$('reviewSideCrop');
  const request=++cropRequest;
  if(!sourceId||!Array.isArray(bbox)||bbox.length!==4){
    crop.hidden=true;return;
  }
  crop.hidden=false;img.hidden=true;note.textContent='Увеличиваю фрагмент: '+label+'…';
  try{
    const result=await api('row-crop',{sourceId,bbox});
    if(request!==cropRequest)return;
    img.src=result.image;img.hidden=false;
    side.src=result.image;side.hidden=false;
    note.textContent=label+' · координаты приблизительные, OCR не подтверждён. Сверьте с целой страницей.';
  }catch(e){if(request===cropRequest)note.textContent='Увеличение недоступно: '+e.message}
}
$('reviewAngleLocal').onclick=async()=>{
  const bbox=reviewCells[Number($('cellPicker').value)];
  if(!bbox||!reviewSourceId)return status('Выберите ячейку на фото.','error');
  const button=$('reviewAngleLocal'),target=$('cloudCellReading');
  button.disabled=true;target.textContent='RapidOCR CPU: читаю 0° / -8° / +8° без Cloud.ru…';
  try{
    const answer=await api('review-angle',{sourceId:reviewSourceId,bbox});
    target.textContent=answer.variants.map(v=>v.rotationDegrees+'°: '+
      (v.readings.join(' / ')||'непрочитано')).join(' · ')+
      '. Это неподтверждённые варианты; сверьте с исходником.';
  }catch(e){target.textContent='Локальная проверка недоступна: '+e.message}
  finally{button.disabled=false}
};
$('reviewCellCloud').onclick=async()=>{
  const bbox=reviewCells[Number($('cellPicker').value)];
  if(!bbox||!reviewSourceId)return status('Сначала выберите ячейку на исходном фото.','error');
  if(!confirm('Отправить только выбранную ячейку в Cloud.ru? Это 1 платный запрос; ответ не заменит данные автоматически.'))return;
  const button=$('reviewCellCloud'),label=$('cloudCellReading');button.disabled=true;
  label.textContent='Cloud.ru перепроверяет отдельный фрагмент…';
  try{
    const result=await api('review-cell',{sourceId:reviewSourceId,bbox,
      field:$('cellReviewField').value});
    label.textContent='Другое чтение: '+result.candidateText+
      ' · '+result.model+' · '+result.cloudCalls+' запрос. Не подтверждено. Сверьте с фото.';
  }catch(e){label.textContent='Перепроверка не выполнена: '+e.message}
  finally{button.disabled=false}
};
$('cellPicker').onchange=()=>{
  const i=Number($('cellPicker').value),box=reviewCells[i];
  if(box)void showRowCrop(reviewSourceId,box,'Ячейка '+(i+1));
};
async function showReportCells(task){
  const report=await api('photo-report/'+task.reportId,undefined,'GET');
  if(!report.sourceId)throw Error('У отчёта нет исходной фотографии');
  showSource({sourceId:report.sourceId,source:task.name,bbox:null});
  const tentative=!(report.layout?.cellBoxes||[]).length;
  const candidates=tentative?report.tentativeCells?.boxes:(report.layout?.cellBoxes||[]);
  reviewCells=(candidates||[]).filter(b=>
    Array.isArray(b)&&b.length===4&&b.every(v=>typeof v==='number'&&v>=0&&v<=1)&&b[2]>b[0]&&b[3]>b[1]).slice(0,700);
  reviewSourceId=report.sourceId;
  $('cloudCellReading').textContent='Выберите ячейку. Облачная проверка требует отдельного подтверждения.';
  const issues=[
    'Разночтения OCR: '+(report.ocrComparison?.spatialDisagreements||0),
    'Возможные пропущенные строки: '+(report.missingRows?.unmatched?.length||0),
    'Подозрительные исправления: '+(report.visualCorrections?.candidates?.length||0),
    'Возможные дубли: '+(report.duplicateCandidates?.length||0)];
  $('reviewEvidence').textContent=issues.join(' · ')+'. Это подсказки, не подтверждённая точность.';
  $('cellReviewToolbar').hidden=reviewCells.length===0;
  const picker=$('cellPicker');picker.replaceChildren();
  for(let i=0;i<reviewCells.length;i++){
    const option=document.createElement('option');option.value=String(i);
    option.textContent=(tentative?'Предположительная область ':'Ячейка ')+(i+1);picker.append(option);
  }
  gridBoxes=reviewCells;
  drawPreviewGrid();
  if(reviewCells.length)void showRowCrop(reviewSourceId,reviewCells[0],
    tentative?'Предположительная область 1':'Ячейка 1');
  else $('cropStatus').textContent='У этого фото нет надёжно обнаруженных ячеек.';
  $('upload').scrollIntoView({behavior:'smooth',block:'start'});
}
function showSource(row){
  gridBoxes=[];$('gridOverlay').replaceChildren();
  reviewCells=[];reviewSourceId='';$('cellReviewToolbar').hidden=true;
  $('cropReview').hidden=true;++cropRequest;
  $('reviewSideCrop').hidden=true;
  if(!row.sourceId){$('qualityStatus').textContent='У этой строки нет сохранённой фотографии.';
    $('reviewSideImage').hidden=true;$('reviewSideCrop').hidden=true;
    $('reviewSideStatus').textContent='Для строки нет исходного снимка.';return}
  const src='/api/source/'+row.sourceId;
  $('reviewSideImage').src=src;$('reviewSideImage').hidden=false;
  $('reviewSideStatus').textContent=(row.source||'Сохранённый снимок')+
    ' · '+(row.bbox?'выделена строка OCR':'геометрия строки не определена');
  const img=$('previewImage'),overlay=$('highlightBox');
  $('previewFilename').textContent=row.source||'Сохранённый снимок';
  $('previewEmpty').hidden=true;
  img.hidden=false;overlay.hidden=true;
  const update=()=>{
    overlay.hidden=true;
    drawPreviewGrid();
    if(!Array.isArray(row.bbox)||row.bbox.length!==4||!img.naturalWidth||!img.naturalHeight)return;
    const area=$('previewSurface');
    const displayWidth=area.clientWidth,displayHeight=area.clientHeight;
    const scale=Math.min(displayWidth/img.naturalWidth,displayHeight/img.naturalHeight);
    const x0=(displayWidth-img.naturalWidth*scale)/2;
    const y0=(displayHeight-img.naturalHeight*scale)/2;
    const [x1,y1,x2,y2]=row.bbox;
    if(![x1,y1,x2,y2].every(v=>Number.isFinite(v)&&v>=0&&v<=1))return;
    Object.assign(overlay.style,{
      left:(x0+x1*img.naturalWidth*scale)+'px',
      top:(y0+y1*img.naturalHeight*scale)+'px',
      width:((x2-x1)*img.naturalWidth*scale)+'px',
      height:((y2-y1)*img.naturalHeight*scale)+'px'
    });
    overlay.hidden=false;
    drawPreviewGrid();
  };
  img.onload=update;img.onerror=()=>{img.hidden=true;$('previewEmpty').hidden=false;overlay.hidden=true};
  if(img.getAttribute('src')!==src)img.src=src;
  else if(img.complete)update();
  $('qualityStatus').textContent=row.bbox?'Подсвеченная область приблизительная: сверьте с фото.':'Для строки не получены точные координаты. Открыта исходная фотография.';
  if(row.bbox)void showRowCrop(row.sourceId,row.bbox,'Строка');
}

$('approveMemory').onclick=async()=>{
  const confirmed=state.rows.filter(r=>r.reviewed===true);
  if(!confirmed.length)return status('Сначала сверьте строки с фотографиями и отметьте «Сверено».','error');
  if(!confirm('Добавить номера ТС и водителей только из '+confirmed.length+' подтверждённых строк в локальный справочник?'))return;
  const button=$('approveMemory');button.disabled=true;
  try{
    const existing=await api('approved-memory',undefined,'GET');
    const vehicles=[...new Set([...(existing.vehicles||[]),...confirmed.map(r=>String(r.vehicle||'').trim()).filter(Boolean)])];
    const drivers=[...new Set([...(existing.drivers||[]),...confirmed.map(r=>String(r.driver||'').trim()).filter(Boolean)])];
    const result=await api('approved-memory',{confirmed:true,vehicles,drivers});
    status('Подтверждённый справочник сохранён: '+result.vehicles+' ТС, '+result.drivers+' водителей.','success');
  }catch(e){status('Ошибка справочника: '+e.message,'error')}
  finally{button.disabled=false}
};
async function initialize(){
  updateSummary();renderTable();renderAudit();drawQueue();
  await Promise.all([refreshTemplates().catch(()=>{}),refreshTasks().catch(()=>{})]);
  try{
    const cfg=await api('settings',undefined,'GET');
    populateModels(cfg.models,cfg.model);
    $('fallback').checked=cfg.fallback!==false;
    $('enhance').checked=cfg.enhance!==false;
    $('cropRecovery').checked=cfg.cropRecovery!==false;
    $('paddle').checked=cfg.paddle===true;
    $('chandra').checked=cfg.chandra===true;
    $('mineru').checked=cfg.mineru===true;
    $('localText').checked=cfg.localText===true;
    $('localVl').checked=cfg.localVl===true;
    $('cvPreprocess').checked=cfg.cvPreprocess===true;
    $('gridSegmentation').checked=cfg.gridSegmentation===true;
    $('autoPipeline').checked=cfg.autoPipeline!==false;
    $('digitCellOcr').checked=cfg.digitCellOcr===true;
    $('costMode').value=cfg.costMode||'auto';
    $('maxCloudCalls').value=String(cfg.maxCloudCalls||3);
    state.hasKey=Boolean(cfg.hasKey);
    if(!state.hasKey)$('settingsDetails').open=true;
    if(state.queue.length)drawQueue();
    setConnection(cfg.hasKey?'Ключ сохранён · не проверен':'Нужен API-ключ',cfg.hasKey?'pending':'error');
    $('settingsHelp').textContent=cfg.hasKey
      ?'Ключ уже сохранён на диске. Для замены введите новый, затем нажмите «Сохранить».'
      :'Введите ключ один раз. Он сохранится в папке data на этом компьютере.';
  }catch(e){
    setConnection('Ошибка локального сервера','error');
    status('Настройки не загрузились: '+e.message,'error');
    $('settingsDetails').open=true;
  }
  try{
    const draft=await api('draft',undefined,'GET');
    state.rows=Array.isArray(draft.rows)?draft.rows:[];
    updateSummary();renderTable();renderAudit();
    if(state.rows.length)$('saveStatus').textContent='Восстановлен черновик ('+state.rows.length+')';
  }catch(e){status('Не удалось открыть сохранённый журнал: '+e.message,'error')}
}

// Surface unexpected UI failures rather than silently leaving dead buttons.
window.addEventListener('error',event=>{
  const message=String(event.message||'Неизвестная ошибка интерфейса').slice(0,240);
  status('Ошибка интерфейса: '+message+'. Перезагрузите страницу; если повторится, откройте диагностику.','error');
});
window.addEventListener('unhandledrejection',event=>{
  status('Ошибка операции: '+String(event.reason?.message||event.reason||'Неизвестно').slice(0,240),'error');
});
initialize();
