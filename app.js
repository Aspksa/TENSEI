const el=id=>document.getElementById(id);
const labels={workspace:'Распознавание фотографий',journal:'Реестр взвешиваний',audit:'Проверка ошибок',settings:'Подключение Cloud.ru'};
let records=[],files=[],busy=false,saveTimer=null,rev=0,previewUrl=null;
const fields=['time','vehicle','driver','tare','gross','net','note'];
const n=x=>x===null||x===undefined||String(x).trim()===''?null:Number(String(x).trim().replace(/\s/g,'').replace(',','.'));
function setNotice(message,type='info'){el('notice').hidden=!message;el('notice').textContent=message||'';el('notice').dataset.type=type}
async function request(route,body,method='POST'){
  const opt={method,headers:{}};
  if(body!==undefined){opt.headers['Content-Type']='application/json';opt.body=JSON.stringify(body)}
  const res=await fetch('/api/'+route,opt);
  if(route==='export'&&res.ok)return res.blob();
  let json;try{json=await res.json()}catch{throw Error('Сервер вернул неожиданный ответ')}
  if(!res.ok)throw Error(json.error||'Ошибка запроса');
  return json;
}
function section(id){
  document.querySelectorAll('.page').forEach(x=>x.hidden=x.id!==id);
  document.querySelectorAll('.nav').forEach(x=>x.classList.toggle('active',x.dataset.page===id));
  el('pageTitle').textContent=labels[id];
  if(id==='journal')renderTable();
  if(id==='audit')renderAudit();
}
document.querySelectorAll('.nav').forEach(x=>x.addEventListener('click',()=>section(x.dataset.page)));
el('showJournal').onclick=()=>section('journal');
function analyze(items){
  const seen=new Set();
  return items.map((raw,i)=>{
    const row={...raw};
    const issues=[];
    if(row.uncertain)issues.push('Неуверенное распознавание');
    if(!String(row.vehicle||'').trim())issues.push('Не указан номер ТС');
    if(row.time&&!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(row.time))issues.push('Некорректное время');
    if(n(row.gross)===null&&n(row.net)===null)issues.push('Нет веса');
    for(const [name,key] of [['Тара','tare'],['Брутто','gross'],['Нетто','net']]){
      const v=n(row[key]);if(v!==null&&(!Number.isFinite(v)||v<0||v>150000))issues.push(name+': необычное значение');
    }
    if(n(row.tare)!==null&&n(row.gross)!==null&&n(row.gross)<n(row.tare))issues.push('Брутто меньше тары');
    if(n(row.tare)!==null&&n(row.gross)!==null&&n(row.net)!==null&&Math.abs(n(row.gross)-n(row.tare)-n(row.net))>1)issues.push('Не совпадает расчёт нетто');
    if(n(row.net)!==null&&n(row.net)>45000)issues.push('Нетто больше 45 тонн');
    if(n(row.net)===0)issues.push('Нулевой вес');
    const fingerprint=[row.time,row.vehicle,row.tare,row.gross,row.net].join('|');
    if(row.vehicle&&seen.has(fingerprint))issues.push('Возможный повтор записи');
    seen.add(fingerprint);
    return {row,issues,i};
  });
}
function updateStats(){
  const all=analyze(records),issueCount=all.filter(x=>x.issues.length).length;
  const mass=records.reduce((acc,x)=>{const v=n(x.net);return acc+(Number.isFinite(v)?v:0)},0)/1000;
  el('statRows').textContent=records.length;
  el('statIssues').textContent=issueCount;
  el('statTons').innerHTML=mass.toLocaleString('ru-RU',{minimumFractionDigits:3,maximumFractionDigits:3})+' <i>т</i>';
  el('sideCount').textContent=records.length;
  el('sideIssues').textContent=issueCount;
  el('auditBadge').textContent=issueCount+' строк';
}
function changed(){rev++;updateStats();scheduleSave()}
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(async()=>{
    if(busy)return scheduleSave();
    const version=rev;
    try{await request('draft',{rows:records});if(version!==rev)scheduleSave()}
    catch(e){setNotice('Не удалось сохранить черновик: '+e.message)}
  },650);
}
function makeCell(r,i,key){
  const td=document.createElement('td'),inp=document.createElement('input');
  inp.type='text';inp.value=r[key]??'';
  inp.setAttribute('aria-label',key+' строка '+(i+1));
  inp.addEventListener('change',()=>{
    const value=inp.value.trim();
    r[key]=['tare','gross','net'].includes(key)?value===''?null:Number(value.replace(',','.')):value;
    if(['tare','gross'].includes(key)&&r.tare!==null&&r.gross!==null&&r.net===null&&r.gross>=r.tare)r.net=Number(r.gross)-Number(r.tare);
    changed();renderTable();
  });
  td.appendChild(inp);return td;
}
function renderTable(){
  const query=el('search').value.trim().toLowerCase(),only=el('onlyIssues').checked,body=el('tableBody');
  body.replaceChildren();
  const analyzed=analyze(records).filter(({row,issues})=>(!only||issues.length)&&(!query||[row.time,row.vehicle,row.driver,row.source,row.note].some(v=>String(v||'').toLowerCase().includes(query))));
  const chunk=document.createDocumentFragment();
  for(const {row:r,issues,i} of analyzed){
    const tr=document.createElement('tr');if(issues.length)tr.className='issue-row';
    let cell=document.createElement('td');cell.textContent=i+1;tr.append(cell);
    fields.forEach(k=>tr.append(makeCell(r,i,k)));
    cell=document.createElement('td');cell.textContent=String(r.source||'');tr.append(cell);
    cell=document.createElement('td');const check=document.createElement('input');check.type='checkbox';check.checked=!r.uncertain;check.title='Подтвердить ручную сверку с фотографией';check.setAttribute('aria-label','Строка '+(i+1)+' проверена');check.onchange=()=>{r.uncertain=!check.checked;changed();renderTable()};cell.append(check);tr.append(cell);
    cell=document.createElement('td');cell.title=issues.join('; ');
    const status=document.createElement('span');status.className='flag';status.textContent=issues.length?'⚠ '+issues.length+' замеч.':'✓ OK';cell.append(status);tr.append(cell);
    cell=document.createElement('td');const remove=document.createElement('button');remove.className='row-remove';remove.textContent='×';remove.title='Удалить строку';remove.onclick=()=>{if(confirm('Удалить строку '+(i+1)+'?')){records.splice(i,1);changed();renderTable()}};cell.append(remove);tr.append(cell);chunk.append(tr);
  }
  body.append(chunk);
  el('tableSummary').textContent='Показано '+analyzed.length+' из '+records.length+' записей';
}
function renderAudit(){
  const area=el('auditList');area.replaceChildren();
  const issues=analyze(records).filter(x=>x.issues.length);
  if(!issues.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=records.length?'Автоматических замечаний нет. Проверьте исходные фотографии.':'Сначала распознайте фотографии или добавьте строки.';area.append(empty);return}
  const fragment=document.createDocumentFragment();
  for(const item of issues){
    const div=document.createElement('div');div.className='audit-item';
    const info=document.createElement('div'),heading=document.createElement('strong'),detail=document.createElement('p');
    heading.textContent='Строка '+(item.i+1)+' · '+(item.row.vehicle||'ТС не указан');
    detail.textContent=item.issues.join(' · ');info.append(heading,detail);
    const btn=document.createElement('button');btn.className='secondary';btn.textContent='Исправить';btn.onclick=()=>{el('search').value=String(item.row.vehicle||'');el('onlyIssues').checked=true;section('journal')};
    div.append(info,btn);fragment.append(div);
  }
  area.append(fragment);
}
el('search').oninput=()=>renderTable();el('onlyIssues').onchange=()=>renderTable();
el('addRow').onclick=()=>{records.push({time:'',vehicle:'',driver:'',tare:null,gross:null,net:null,source:'Вручную',note:'',uncertain:false});changed();renderTable()};
el('clear').onclick=async()=>{if(busy)return setNotice('Дождитесь завершения распознавания перед очисткой.');if(!confirm('Удалить все строки реестра и сохранённый черновик?'))return;records=[];clearTimeout(saveTimer);rev++;updateStats();renderTable();renderAudit();try{await request('draft',undefined,'DELETE')}catch(e){setNotice(e.message)}};
el('download').onclick=async()=>{if(!records.length)return setNotice('В реестре пока нет строк');try{const blob=await request('export',{rows:records}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='TENSEI.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),6000)}catch(e){setNotice('Excel: '+e.message)}};
const fileAllowed=name=>/\.(jpe?g|png|webp|gif|tiff?|bmp|avif|heic|heif|svg)$/i.test(name);
function addFiles(add){
  for(const f of add){if(f.size>20*1024*1024){setNotice('Пропущен '+f.name+': размер больше 20 МБ');continue}if(!fileAllowed(f.name)&&!f.type.startsWith('image/')){setNotice('Неизвестный формат: '+f.name);continue}files.push(f)}
  drawFiles();showPreview(files[0]);
}
function drawFiles(){
  el('fileList').replaceChildren();
  files.forEach((f,i)=>{const line=document.createElement('div');line.className='file-item';const span=document.createElement('span');span.textContent=f.name;const small=document.createElement('small');small.textContent=(f.size/1024/1024).toFixed(1)+' МБ';const btn=document.createElement('button');btn.textContent='×';btn.title='Убрать файл';btn.onclick=()=>{files.splice(i,1);drawFiles();showPreview(files[0])};line.append(span,small,btn);el('fileList').append(line)});
}
function showPreview(f){
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
  const img=el('preview');img.hidden=true;el('previewEmpty').hidden=false;
  if(!f)return;
  previewUrl=URL.createObjectURL(f);img.src=previewUrl;
  img.onload=()=>{img.hidden=false;el('previewEmpty').hidden=true};
  img.onerror=()=>{img.hidden=true;el('previewEmpty').hidden=false;el('previewEmpty').textContent='Предпросмотр этого формата недоступен. Файл всё равно можно распознать.'};
}
el('dropzone').onclick=()=>el('photos').click();
el('dropzone').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el('photos').click()}};
el('photos').onchange=e=>{addFiles([...e.target.files]);e.target.value=''};
for(const event of ['dragover','dragenter'])el('dropzone').addEventListener(event,e=>{e.preventDefault();el('dropzone').classList.add('drag')});
for(const event of ['dragleave','drop'])el('dropzone').addEventListener(event,e=>{e.preventDefault();el('dropzone').classList.remove('drag')});
el('dropzone').addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));
function fileData(f){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не удалось прочитать '+f.name));reader.readAsDataURL(f)})}
el('run').onclick=async()=>{
  if(busy)return;if(!files.length)return setNotice('Сначала загрузите фотографии.');
  busy=true;el('run').disabled=true;const count=files.length,errors=[];
  try{
    const pending=files.slice();files=[];drawFiles();
    for(let i=0;i<pending.length;i++){
      const f=pending[i];el('progressText').textContent='Обработка '+(i+1)+'/'+count+': '+f.name;
      el('progressBar').style.width=Math.round(100*i/count)+'%';showPreview(f);
      try{const image=await fileData(f);const result=await request('recognize',{image,name:f.name});records.push(...result.rows);changed()}
      catch(e){errors.push(f.name+': '+e.message);files.push(f)}
    }
    drawFiles();el('progressBar').style.width='100%';
    el('progressText').textContent='Обработано '+(count-errors.length)+'/'+count+' изображений. Строк в реестре: '+records.length;
    if(errors.length)setNotice('Некоторые фотографии не обработаны (остались в очереди):\n'+errors.join('\n'));
    else setNotice('Распознавание завершено. Проверьте замечания и экспортируйте Excel.');
  }finally{busy=false;el('run').disabled=false;if(records.length)scheduleSave()}
};
el('save').onclick=async()=>{
  try{const r=await request('settings',{key:el('key').value,model:el('model').value});el('key').value='';el('saved').textContent=r.hasKey?'Ключ сохранён на диске':'Ключ не задан';el('connection').textContent=r.hasKey?'● Модель настроена':'○ Нужен API-ключ';el('connection').className='state '+(r.hasKey?'ok':'off');setNotice('Настройки сохранены')}
  catch(e){setNotice(e.message)}
};
async function init(){
  try{
    const [cfg,draft]=await Promise.all([fetch('/api/settings').then(r=>r.json()),fetch('/api/draft').then(r=>r.json())]);
    const selector=el('model');selector.replaceChildren();
    for(const m of cfg.models||[]){const option=document.createElement('option');option.value=m.id;option.textContent=m.name;selector.append(option)}
    if(cfg.model&&!Array.from(selector.options).some(x=>x.value===cfg.model)){const option=document.createElement('option');option.value=cfg.model;option.textContent=cfg.model;selector.append(option)}
    selector.value=cfg.model;
    el('saved').textContent=cfg.hasKey?'Ключ сохранён в папке data':'Укажите ключ для начала';
    el('connection').textContent=cfg.hasKey?'● Cloud.ru настроен':'○ Требуется ключ';
    el('connection').className='state '+(cfg.hasKey?'ok':'off');
    records=Array.isArray(draft.rows)?draft.rows:[];
    updateStats();
    if(records.length)setNotice('Черновик восстановлен: '+records.length+' записей.');
  }catch(e){setNotice('Ошибка инициализации: '+e.message)}
}
init();
