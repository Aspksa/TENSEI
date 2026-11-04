import ExcelJS from 'exceljs';
import {plateKey,reportSummary} from './legion.mjs';

const s=x=>String(x??'').trim();
const noFormula=x=>typeof x==='string'&&/^[=+\-@]/.test(x)?"'"+x:x;
const normalizedHead=x=>s(x).toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[\s._\-()/]/g,'');
const cellText=c=>{
  const v=c?.value;
  if(v==null)return '';
  if(typeof v==='string'||typeof v==='number')return s(v);
  if(v instanceof Date)return v.toISOString().slice(0,10);
  if(typeof v==='object')return s(v.text||v.result||v.richText?.map(z=>z.text).join('')||'');
  return s(v);
};
function validateVehicle(item){
  const plate=plateKey(item.plate||item.displayPlate);
  if(!/^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}$/.test(plate))
    throw Error('Некорректный госномер: '+s(item.plate||item.displayPlate).slice(0,32));
  const model=s(item.model).slice(0,110),driver=s(item.driver).slice(0,110);
  const displayPlate=s(item.displayPlate||item.plate).slice(0,40);
  return {plate,displayPlate,model,driver};
}
export function mergeVehicles(original,newItems){
  const map=new Map((original||[]).map(v=>[plateKey(v.plate),validateVehicle(v)]));
  for(const v of newItems){
    const item=validateVehicle(v),old=map.get(item.plate);
    map.set(item.plate,{plate:item.plate,displayPlate:item.displayPlate||old?.displayPlate||item.plate,
      model:item.model||old?.model||'',driver:item.driver||old?.driver||''});
  }
  return [...map.values()].sort((a,b)=>a.plate.localeCompare(b.plate,'ru'));
}
function parseVehicleSheet(sheet){
  let headerRow=0,vehicle=-1,model=-1,driver=-1;
  for(let i=1;i<=Math.min(sheet.rowCount,15);i++){
    const cells=sheet.getRow(i);
    const values=[];for(let c=1;c<=Math.min(16,sheet.columnCount||16);c++)values.push(normalizedHead(cellText(cells.getCell(c))));
    const find=keys=>values.findIndex(v=>keys.some(k=>v===normalizedHead(k)));
    vehicle=find(['госномер','госномерТС','гос. номер','ТС','регистрационный номер','номер ТС']);
    model=find(['марка/модель','марка модель','модель','марка','автомобиль']);
    driver=find(['водитель','ФИО водителя','Ф.И.О. водителя']);
    if(vehicle>=0&&model>=0&&driver>=0){headerRow=i;break}
  }
  if(!headerRow)throw Error('На листе «База ТС» нет заголовков: Госномер, Марка/модель, Водитель');
  const list=[],errors=[];
  for(let r=headerRow+1;r<=Math.min(sheet.rowCount,10000);r++){
    const row=sheet.getRow(r),plate=cellText(row.getCell(vehicle+1));
    if(!plate)continue;
    try{list.push(validateVehicle({plate,displayPlate:plate,model:cellText(row.getCell(model+1)),driver:cellText(row.getCell(driver+1))}))}
    catch(e){errors.push('Строка '+r+': '+e.message)}
  }
  return {vehicles:mergeVehicles([],list),errors,source:'База ТС'};
}
function parseLegacyReport(sheet){
  const list=[],errors=[];
  for(let r=5;r<=Math.min(sheet.rowCount,10000);r++){
    const row=sheet.getRow(r),plate=cellText(row.getCell(5)),model=cellText(row.getCell(4)),
      driver=cellText(row.getCell(6));
    if(!plate||!model||/итого|подпись/i.test(plate))continue;
    try{list.push(validateVehicle({plate,displayPlate:plate,model,driver}))}
    catch(e){errors.push('Строка '+r+': '+e.message)}
  }
  return {vehicles:mergeVehicles([],list),errors,
    source:sheet.name+' (из готового отчёта, а не листа «База ТС»)'};
}
export async function readVehicleWorkbook(buffer){
  const book=new ExcelJS.Workbook();
  try{await book.xlsx.load(buffer)}
  catch{throw Error('Не удалось открыть XLSX — проверьте, что это файл Excel, а не CSV')}
  let sheet=book.worksheets.find(x=>normalizedHead(x.name)==='базатс');
  if(sheet)return parseVehicleSheet(sheet);
  sheet=book.worksheets.find(x=>x.getRow(3).getCell(4).value&&
    normalizedHead(cellText(x.getRow(4).getCell(5))).includes('госномер'));
  if(!sheet)sheet=book.worksheets.find(x=>x.name.toLowerCase().includes('скала'));
  if(!sheet)throw Error('В Excel нет листа «База ТС» или подходящего готового отчёта (столбцы D/E/F)');
  return parseLegacyReport(sheet);
}
const border={top:{style:'thin',color:{argb:'FFCBD5E1'}},left:{style:'thin',color:{argb:'FFCBD5E1'}},
  bottom:{style:'thin',color:{argb:'FFCBD5E1'}},right:{style:'thin',color:{argb:'FFCBD5E1'}}};
const headerStyle={font:{bold:true,color:{argb:'FFFFFFFF'},size:10},
  fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF1E4367'}},
  alignment:{vertical:'middle',horizontal:'center',wrapText:true},border};
const highlight={type:'pattern',pattern:'solid',fgColor:{argb:'FFFFEDD5'}};
const dateObject=iso=>{
  const [y,m,d]=iso.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d,12,0,0));
};
export async function exportVehicleMaster(vehicles,{coefficient=1.55,organization='ООО "Легион Е" (пгт. Хороль)'}={}){
  const book=new ExcelJS.Workbook();book.creator='TENSEI · Легион';
  const base=book.addWorksheet('База ТС');
  base.columns=[
    {header:'Госномер',key:'displayPlate',width:24},
    {header:'Марка/модель',key:'model',width:32},
    {header:'Водитель',key:'driver',width:34}
  ];
  for(const v of vehicles)base.addRow([noFormula(v.displayPlate||v.plate),noFormula(v.model),noFormula(v.driver)]);
  base.getRow(1).height=28;base.getRow(1).eachCell(c=>Object.assign(c,headerStyle));
  base.autoFilter={from:'A1',to:'C'+Math.max(2,base.rowCount)};
  base.views=[{state:'frozen',ySplit:1}];
  const settings=book.addWorksheet('Настройки');
  settings.getCell('A1').value='Товарно-транспортные отчёты · Легион';
  settings.getCell('A1').font={bold:true,size:16,color:{argb:'FF1E4367'}};
  settings.getCell('A3').value='Наименование организации';
  settings.getCell('B3').value=organization;
  settings.getCell('A4').value='Коэффициент / расстояние (формула: т / значение)';
  settings.getCell('B4').value=coefficient;
  settings.getCell('B4').numFmt='0.00';
  settings.getCell('A6').value='Отчёт использует указанную формулу: тонны / 1,55.';
  settings.getCell('A7').value='Название «тонно-километры» сохранено по инструкции; обычные т·км считаются умножением.';
  settings.getColumn(1).width=60;settings.getColumn(2).width=46;
  return Buffer.from(await book.xlsx.writeBuffer());
}
export function groupByDateAndProduct(rows){
  const groups=new Map();
  for(const r of rows){
    const key=r.date+'\u0000'+r.product;
    if(!groups.has(key))groups.set(key,{date:r.date,product:r.product,rows:[]});
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}
export function safeFilePart(x){
  return s(x).replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/\s+/g,' ').replace(/[. ]+$/,'').slice(0,65)||'Отчёт';
}
function dailyReportSheet(book,group,rows,coefficient,organization){
  const sheet=book.addWorksheet('Отчёт');
  sheet.columns=[
    {width:8},{width:18},{width:13},{width:26},{width:19},
    {width:26},{width:30},{width:17},{width:18},{width:19}
  ];
  sheet.mergeCells('A1:J1');sheet.getCell('A1').value=organization;
  sheet.getCell('A1').font={bold:true,size:15,color:{argb:'FF1D446C'}};
  sheet.getCell('A1').alignment={vertical:'middle'};
  sheet.getRow(1).height=32;
  sheet.mergeCells('A2:J2');
  sheet.getCell('A2').value='Дата доставки '+group.date.split('-').reverse().join('.')+'   ·   '+group.product;
  sheet.getCell('A2').font={bold:true,size:12,color:{argb:'FF4A6785'}};
  sheet.getRow(2).height=25;
  sheet.getRow(3).values=['№ п/п','Дата доставки','№ ТН','Транспортное средство','','ФИО водителя',
    'Наименование товара','Кол-во тонн','Коэфф. / расстояние','Тонно-км*'];
  sheet.getRow(4).values=['','','','Модель','Гос. номер','','','','',''];
  for(const rowNo of [3,4]){
    sheet.getRow(rowNo).height=rowNo===3?36:27;
    sheet.getRow(rowNo).eachCell({includeEmpty:true},c=>Object.assign(c,structuredClone(headerStyle)));
  }
  for(const col of [1,2,3,6,7,8,9,10])sheet.mergeCells(3,col,4,col);
  sheet.mergeCells('D3:E3');
  for(let i=0;i<rows.length;i++){
    const trip=rows[i],rowNo=5+i;
    const row=sheet.getRow(rowNo);
    row.values=[
      i+1,dateObject(trip.date),noFormula(trip.id),
      noFormula(trip.model),noFormula(trip.plateDisplay),noFormula(trip.driver),
      noFormula(trip.product),trip.netKg/1000,coefficient,
      {formula:'H'+rowNo+'/I'+rowNo,result:trip.netKg/1000/coefficient}
    ];
    row.height=25;
    row.getCell(2).numFmt='dd.mm.yyyy';
    row.getCell(8).numFmt='#,##0.000';
    row.getCell(9).numFmt='0.00';
    row.getCell(10).numFmt='#,##0.000';
    row.eachCell({includeEmpty:true},c=>{
      c.border=border;c.alignment={vertical:'middle',horizontal:[4,5,6,7].includes(c.col)?'left':'center',wrapText:true};
      if(i%2===1)c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF3F7FB'}};
    });
    if(trip.issues.length)for(const ix of [4,5,6])row.getCell(ix).fill=highlight;
  }
  const last=4+rows.length,summary=reportSummary(rows),sumRow=last+1;
  const total=sheet.getRow(sumRow);total.getCell(1).value='Итого:';
  total.getCell(8).value={formula:'SUM(H5:H'+last+')',result:summary.tonnes};
  total.getCell(10).value={formula:'SUM(J5:J'+last+')',result:summary.tonnes/coefficient};
  total.height=29;total.font={bold:true};
  total.getCell(8).numFmt='#,##0.000';total.getCell(10).numFmt='#,##0.000';
  total.eachCell({includeEmpty:true},c=>{c.border=border;c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE9F2FA'}}});
  sheet.mergeCells(sumRow+2,1,sumRow+2,10);
  sheet.getCell('A'+(sumRow+2)).value='* Расчёт по заданной формуле: тонны / '+coefficient+'. Это не стандартное физическое вычисление тонно-километров.';
  sheet.getCell('A'+(sumRow+2)).font={italic:true,color:{argb:'FF64748B'},size:10};
  sheet.getCell('A'+(sumRow+2)).alignment={wrapText:true};
  sheet.getRow(sumRow+2).height=32;
  sheet.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1};
  sheet.views=[{state:'frozen',ySplit:4}];
  return summary;
}
function controlSheet(book,group,rows,summary){
  const sheet=book.addWorksheet('Контроль');
  sheet.columns=[{width:26},{width:32},{width:20},{width:26},{width:55}];
  const d=group.date.split('-').reverse().join('.');
  sheet.addRows([
    ['Легион — проверка выгрузки',''],
    ['Дата',d],
    ['Товар',group.product],
    ['Рейсов',summary.count],
    ['Тонн (нетто)',summary.tonnes],
    ['Разных автомобилей',summary.uniqueVehicles],
    ['Нет модели / водителя',summary.unknownVehicles.length],
    ['Строк с замечаниями',summary.warnings],
    [],
    ['№ ТН','Госномер','Модель','Водитель','Замечания']
  ]);
  sheet.getRow(1).font={bold:true,size:15,color:{argb:'FF1E4367'}};
  sheet.getCell('B5').numFmt='0.000';
  sheet.getRow(10).eachCell(c=>Object.assign(c,structuredClone(headerStyle)));
  let rowIdx=11;
  for(const r of rows.filter(x=>x.issues.length)){
    const row=sheet.getRow(rowIdx++);
    row.values=[noFormula(r.id),noFormula(r.plateDisplay),noFormula(r.model),noFormula(r.driver),
      noFormula(r.issues.join('; '))];
    row.alignment={vertical:'middle',wrapText:true};row.height=27;
    row.eachCell(c=>{c.border=border;c.fill=highlight});
  }
  sheet.views=[{state:'frozen',ySplit:10}];
}
export async function makeLegionReport(group,vehicles,{coefficient=1.55,
  organization='ООО "Легион Е" (пгт. Хороль)'}={}){
  if(!Number.isFinite(coefficient)||coefficient<=0||coefficient>10000)
    throw Error('Коэффициент должен быть положительным числом');
  const rows=group.rows.map(r=>{
    const v=(vehicles||[]).find(x=>plateKey(x.plate)===r.plate);
    const model=s(v?.model)||'НЕТ В БАЗЕ',driver=s(v?.driver)||'НЕТ В БАЗЕ';
    const issues=[...r.issues];
    if(!v)issues.push('Нет автомобиля в базе');
    else if(!s(v.model)||!s(v.driver))issues.push('У машины не заполнена модель или водитель');
    return {...r,model,driver,plateDisplay:v?.displayPlate||r.plate,issues,known:!!v};
  });
  const book=new ExcelJS.Workbook();book.creator='TENSEI — Легион';book.calcProperties.fullCalcOnLoad=true;
  const summary=dailyReportSheet(book,group,rows,coefficient,organization);
  controlSheet(book,group,rows,summary);
  return {buffer:Buffer.from(await book.xlsx.writeBuffer()),summary};
}

/** Additional workbook: does not replace the existing per-date/product layout. */
export async function makeLegionOverview(rows,vehicles,{coefficient=1.55,previous=[]}={}){
  const classified=rows.map(r=>{
    const v=(vehicles||[]).find(x=>plateKey(x.plate)===plateKey(r.plate));
    return {...r,model:s(v?.model)||'НЕТ В БАЗЕ',driver:s(v?.driver)||'НЕТ В БАЗЕ'};
  });
  const book=new ExcelJS.Workbook();book.creator='TENSEI — Легион';
  const sources=[['По дням',r=>r.date],['По месяцам',r=>r.date.slice(0,7)],
    ['По автомобилям',r=>r.plate],['По товарам',r=>r.product]];
  const totalKg=classified.reduce((a,r)=>a+r.netKg,0);
  for(const [name,keyFn] of sources){
    const sheet=book.addWorksheet(name);
    sheet.addRow(['Группа','Рейсов','Нетто, кг','Нетто, т','Средний рейс, т','Коэффициент','Тонны / коэффициент']);
    const groups=new Map();
    for(const r of classified){
      const key=keyFn(r),v=groups.get(key)||{count:0,kg:0};
      v.count++;v.kg+=r.netKg;groups.set(key,v);
    }
    let pos=2;
    for(const [key,v] of [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0],'ru'))){
      const row=sheet.getRow(pos++);
      row.values=[noFormula(key),v.count,v.kg,v.kg/1000,v.kg/1000/v.count,coefficient,
        {formula:'D'+row.number+'/F'+row.number,result:v.kg/1000/coefficient}];
    }
    const total=sheet.getRow(pos);total.values=['Итого',classified.length,totalKg,totalKg/1000,
      classified.length?totalKg/1000/classified.length:0,coefficient,
      {formula:'D'+pos+'/F'+pos,result:totalKg/1000/coefficient}];
    total.font={bold:true};
    sheet.columns=[{width:30},{width:13},{width:19},{width:17},{width:22},{width:17},{width:25}];
    sheet.getRow(1).height=28;sheet.getRow(1).eachCell(c=>Object.assign(c,structuredClone(headerStyle)));
    for(const row of sheet.getRows(2,pos-1)||[])for(const i of [4,5,7])row.getCell(i).numFmt='#,##0.000';
    sheet.views=[{state:'frozen',ySplit:1}];
    sheet.autoFilter={from:{row:1,column:1},to:{row:pos-1,column:7}};
  }
  const control=book.addWorksheet('Контроль ошибок');
  control.columns=[{width:18},{width:19},{width:20},{width:25},{width:22},{width:48}];
  control.addRow(['Дата','ТН','Госномер','Товар','Нетто, кг','Проверка']);
  for(const r of classified){
    const issues=[...(r.issues||[])];
    if(r.model==='НЕТ В БАЗЕ'||r.driver==='НЕТ В БАЗЕ')issues.push('ТС требует заполнения справочника');
    if(issues.length)control.addRow([r.date,noFormula(r.id),noFormula(r.plate),
      noFormula(r.product),r.netKg,noFormula(issues.join('; '))]);
  }
  control.getRow(1).eachCell(c=>Object.assign(c,structuredClone(headerStyle)));
  control.views=[{state:'frozen',ySplit:1}];
  const params=book.addWorksheet('Параметры');
  params.addRows([['Параметр','Значение'],['Коэффициент / расстояние',coefficient],
    ['Формула','Нетто, т / коэффициент'],['Источник','CSV импорта в TENSEI'],
    ['Всего рейсов',classified.length],['Всего нетто, кг',totalKg],
    ['Сравнение предыдущей версии','Только по явным идентификаторам/полям']]);
  params.columns=[{width:44},{width:48}];
  const diff=book.addWorksheet('Сравнение версий');
  diff.columns=[{width:32},{width:20},{width:20},{width:26}];
  diff.addRow(['Показатель','Предыдущий CSV','Текущий CSV','Разница']);
  const oldKg=previous.reduce((s,r)=>s+r.netKg,0);
  diff.addRow(['Рейсов',previous.length,rows.length,rows.length-previous.length]);
  diff.addRow(['Нетто, кг',oldKg,totalKg,totalKg-oldKg]);
  diff.getRow(1).eachCell(c=>Object.assign(c,structuredClone(headerStyle)));
  diff.getCell('A4').value='Изменение сумм не доказывает совпадение составов рейсов.';
  return {buffer:Buffer.from(await book.xlsx.writeBuffer()),totalKg,count:rows.length};
}
