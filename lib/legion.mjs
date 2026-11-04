// TENSEI Legion CSV -> structured journal. No model inference for vehicle records.
const PLATE_MAP={A:'А',B:'В',E:'Е',K:'К',M:'М',H:'Н',O:'О',P:'Р',C:'С',T:'Т',Y:'У',X:'Х'};
export function plateKey(value){
  let s=String(value??'').normalize('NFKC').toUpperCase().replace(/[\s\-_.]/g,'');
  s=s.replace(/[ABEKMHOPCTYX]/g,x=>PLATE_MAP[x]||x);
  const match=/^([АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2})(\d{2,3})?$/.exec(s);
  return match?match[1]:s.slice(0,22);
}
const clean=x=>String(x??'').trim();
const toKg=(value,label,row)=>{
  const s=clean(value).replace(/[\s\u00a0]/g,'').replace(',','.');
  if(!s)return null;
  if(!/^\d+(?:\.\d{1,3})?$/.test(s))throw Error('Строка '+row+': некорректное число в «'+label+'»: '+clean(value).slice(0,32));
  const n=Number(s);
  if(!Number.isFinite(n)||n<0||n>200000)throw Error('Строка '+row+': вес «'+label+'» вне допустимого диапазона');
  return n;
};
export function decodeCsv(buffer){
  if(!Buffer.isBuffer(buffer))buffer=Buffer.from(buffer);
  if(buffer.byteLength>15*1024*1024)throw Error('CSV больше 15 МБ');
  if(buffer[0]===0xff&&buffer[1]===0xfe)return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if(buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf)return new TextDecoder('utf-8').decode(buffer.subarray(3));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer)}
  catch{return new TextDecoder('windows-1251').decode(buffer)}
}
export function splitCsv(text,delimiter=';'){
  const result=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){
      if(quoted&&text[i+1]==='"'){value+='"';i++}
      else if(!quoted&&value.trim()==='')quoted=true;
      else if(quoted)quoted=false;
      else value+=c;
    }else if(!quoted&&c===delimiter){row.push(value);value=''}
    else if(!quoted&&(c==='\n'||c==='\r')){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(value);value='';
      if(row.some(x=>x.trim()!==''))result.push(row);
      row=[];
    }else{value+=c}
  }
  if(quoted)throw Error('Некорректный CSV: не закрыты кавычки');
  row.push(value);
  if(row.some(x=>x.trim()!==''))result.push(row);
  return result;
}
export function columns(row){
  const canonical=s=>clean(s).replace(/^\ufeff/,'').toLowerCase().replace(/ё/g,'е').replace(/[\s_().]/g,'');
  const norm=row.map(canonical);
  const find=names=>{
    for(const x of names){const pos=norm.indexOf(canonical(x));if(pos>=0)return pos}
    return -1;
  };
  return {
    id:find(['№','Номер','№ талона']),
    plate:find(['ТС','Госномер','Гос. Номер','Регномер','Автомобиль']),
    product:find(['Товар','Наименование товара','Материал','Груз']),
    net:find(['Нетто','Вес нетто','Вес (кг)','Масса нетто']),
    gross:find(['Брутто','Вес брутто']),
    tare:find(['Тара','Вес тара']),
    date:find(['Дата оформления','Дата (брутто)','Дата создания','Дата','Дата доставки']),
    driver:find(['Водитель','ФИО Водителя'])
  };
}
function dateParts(value,row){
  const text=clean(value);
  const m=/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if(!m)throw Error('Строка '+row+': не распознана дата «'+text.slice(0,25)+'»');
  const day=Number(m[1]),month=Number(m[2]),year=Number(m[3]);
  const check=new Date(Date.UTC(year,month-1,day));
  if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==day)
    throw Error('Строка '+row+': некорректная дата');
  const date=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
  return {date,display:m[1].padStart(2,'0')+'.'+m[2].padStart(2,'0')+'.'+m[3],time:m[4]?m[4].padStart(2,'0')+':'+m[5]:''};
}
function readRow(row,pos,line){
  const cell=key=>pos[key]<0?'':clean(row[pos[key]]);
  const sourcePlate=cell('plate'),plate=plateKey(sourcePlate),product=cell('product');
  if(!sourcePlate)throw Error('Строка '+line+': нет госномера');
  if(!product)throw Error('Строка '+line+': пустой товар');
  const date=dateParts(cell('date'),line);
  const gross=toKg(cell('gross'),'Брутто',line),tare=toKg(cell('tare'),'Тара',line),rawNet=toKg(cell('net'),'Нетто',line);
  if(rawNet===null&&!(gross!==null&&tare!==null&&gross>=tare))throw Error('Строка '+line+': невозможно определить нетто');
  const net=rawNet??gross-tare;
  if(net<=0)throw Error('Строка '+line+': масса нетто должна быть больше нуля');
  const issues=[];
  if(rawNet===null)issues.push('Нетто рассчитано по брутто − тара');
  if(gross!==null&&tare!==null&&Math.abs(gross-tare-net)>1)
    issues.push('Нетто не совпадает с брутто − тара');
  if(net>45000)issues.push('Нетто превышает 45 000 кг');
  if(!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/.test(plate))
    issues.push('Нестандартный госномер — проверить вручную');
  return {id:cell('id')||String(line-1),date:date.date,dateDisplay:date.display,time:date.time,
    plate,plateRaw:sourcePlate,product,tareKg:tare,grossKg:gross,netKg:net,
    driverCsv:cell('driver'),line,issues};
}
export function parseLegionCsv(buffer){
  const raw=decodeCsv(buffer).replace(/^\ufeff/,'');
  const sample=raw.split(/\r?\n/,1)[0];
  const delimiters=[';',',','\t'];
  const delimiter=delimiters.map(d=>({d,count:sample.split(d).length})).sort((a,b)=>b.count-a.count)[0].d;
  const rows=splitCsv(raw,delimiter);
  if(rows.length<2)throw Error('CSV не содержит записей');
  const headers=rows[0].map(clean),pos=columns(headers);
  if(pos.plate<0||pos.product<0||pos.date<0||(pos.net<0&&(pos.gross<0||pos.tare<0)))
    throw Error('В CSV нет обязательных колонок: ТС, Товар, Дата, Нетто (или Брутто + Тара)');
  const data=[],errors=[];
  for(let i=1;i<rows.length;i++){
    try{data.push(readRow(rows[i],pos,i+1))}
    catch(e){errors.push(e.message)}
  }
  if(!data.length)throw Error('Не удалось прочитать ни одного рейса: '+errors.slice(0,3).join(' | '));
  const groups=new Map();
  for(const r of data){
    // Preserve product spelling/case and + suffix exactly; never merge distinct products.
    if(!groups.has(r.product))groups.set(r.product,{product:r.product,count:0,kilos:0,plates:new Set(),dates:new Set()});
    const g=groups.get(r.product);g.count++;g.kilos+=r.netKg;g.plates.add(r.plate);g.dates.add(r.date);
  }
  return {rows:data,groups:[...groups.values()].map(g=>({product:g.product,count:g.count,
    tonnes:Math.round(g.kilos)/1000,uniqueVehicles:g.plates.size,dates:[...g.dates].sort()})),
    errors,headers,encoding:Buffer.isBuffer(buffer)?(buffer[0]===0xef?'utf-8 BOM':'utf-8 / windows-1251'):'unknown',
    totalTonnes:Math.round(data.reduce((a,b)=>a+b.netKg,0))/1000};
}
export function classifyTrips(trips,vehicles){
  const base=new Map((vehicles||[]).map(v=>[plateKey(v.plate),v]));
  return trips.map(r=>{
    const known=base.get(r.plate);
    const issues=[...r.issues];
    if(!known)issues.push('Автомобиль не найден в базе ТС');
    else if(!clean(known.model)||!clean(known.driver))issues.push('В базе ТС не заполнена модель или водитель');
    return {...r,model:clean(known?.model)||'НЕТ В БАЗЕ',
      driver:clean(known?.driver)||'НЕТ В БАЗЕ',
      plateDisplay:clean(known?.displayPlate)||r.plate,issues,known:!!known};
  });
}
export function reportSummary(rows){
  const plates=new Set(rows.map(x=>x.plate));
  return {count:rows.length,tonnes:Math.round(rows.reduce((s,x)=>s+x.netKg,0))/1000,
    uniqueVehicles:plates.size,unknownVehicles:[...new Set(rows.filter(x=>!x.known||x.model==='НЕТ В БАЗЕ'||x.driver==='НЕТ В БАЗЕ').map(x=>x.plate))],
    warnings:rows.filter(x=>x.issues.length).length};
}
