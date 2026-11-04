import ExcelJS from 'exceljs';
import {fleetFiltered} from './fleet-statistics.mjs';

const clean=x=>{
  const s=String(x??'');
  return /^[=+@\-]/.test(s)?"'"+s:s;
};
const header=sheet=>{
  const row=sheet.getRow(1);row.height=30;
  row.eachCell(c=>{c.font={bold:true,color:{argb:'FFFFFFFF'}};
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF22476C'}};
    c.alignment={vertical:'middle',wrapText:true}});
  sheet.views=[{state:'frozen',ySplit:1}];
};
const addTable=(book,name,columns,data)=>{
  const s=book.addWorksheet(name);
  s.columns=columns.map(([label,key,width])=>({header:label,key,width}));
  for(const item of data)s.addRow(Object.fromEntries(columns.map(([,key])=>[key,
    typeof item[key]==='string'?clean(item[key]):item[key]??''])));
  header(s);
  if(data.length)s.autoFilter={from:{row:1,column:1},to:{row:data.length+1,column:columns.length}};
  return s;
};
export async function fleetStatisticsXlsx(fleet,options={}){
  const filtered=fleetFiltered(fleet,options);
  const wb=new ExcelJS.Workbook();wb.creator='TENSEI / Легион';
  wb.calcProperties.fullCalcOnLoad=true;
  const grouped=arr=>arr.map(x=>({...x,tonnes:x.netKg/1000,
    avgTonnes:x.trips?x.netKg/1000/x.trips:null}));
  addTable(wb,'Автомобили',[
    ['Госномер','plate',19],['Модель','model',25],['Водитель','driver',24],
    ['Рейсов','trips',12],['Нетто, кг','netKg',18],
    ['Нетто, т','tonnes',17],['Средний рейс, т','avgTonnes',21]
  ],grouped(filtered.vehicles));
  addTable(wb,'Рейсы',[
    ['Дата','date',16],['Время','time',12],['Госномер','plate',18],
    ['Товар','product',24],['Нетто, кг','netKg',18],['Источник','from',14],
    ['Исходный файл','source',29],['Фото-свидетельства','photoEvidence',20],
    ['Импорт CSV','importId',40]
  ],filtered.rows.map(r=>({...r,importId:r.importId||'',source:r.source||''})));
  addTable(wb,'Товары',[
    ['Товар','name',30],['Нетто, кг','netKg',20],['Нетто, т','tonnes',18]
  ],filtered.products.map(x=>({...x,tonnes:x.netKg/1000})));
  addTable(wb,'По дням',[
    ['Дата','date',18],['Нетто, кг','netKg',19],['Нетто, т','tonnes',20]
  ],filtered.daily.map(x=>({...x,tonnes:x.netKg/1000})));
  addTable(wb,'На проверку',[
    ['Источник','from',16],['Дата','date',16],['Время','time',13],
    ['Госномер','plate',19],['Нетто, кг','netKg',18],['Статус','status',22],
    ['Причина','reason',65]
  ],(fleet.review||[]).slice(0,3000));
  const control=wb.addWorksheet('Контроль');
  control.addRows([['Параметр','Значение'],['Режим источников',fleet.sourcePolicy],
    ['Правило','CSV приоритетен; совпадающее фото не добавляет рейс'],
    ['Конфликты','Из спорных рейсов не формируется подтверждённый итог'],
    ['Рейсов в отборе',filtered.totals.trips],
    ['Нетто, кг',filtered.totals.netKg],
    ['Нетто, т',filtered.totals.tonnes],
    ['Строк на проверку (весь набор)',fleet.totals.excluded],
    ['Повторных копий CSV',fleet.totals.copyDuplicates],
    ['Фотографий, привязанных к CSV',fleet.totals.matchedPhotos],
    ['Фильтр ТС',options.vehicle||'all'],['Фильтр товара',options.product||'all'],
    ['От даты',options.from||''],['До даты',options.to||''],
    ['Важно','Совпадение по ключу не доказывает правильность OCR'],
    ['Полнота данных',fleet.partial?'НЕПОЛНАЯ — есть недоступные источники':'Все доступные источники прочитаны'],
    ['Диагностика источников',(fleet.warnings||[]).join(' | ')||'Нет предупреждений']]);
  control.columns=[{width:40},{width:80}];header(control);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
