import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {parseLegionCsv,plateKey,classifyTrips,reportSummary,splitCsv} from '../lib/legion.mjs';
import {readVehicleWorkbook,mergeVehicles,exportVehicleMaster,groupByDateAndProduct,
  makeLegionReport,safeFilePart} from '../lib/legion-excel.mjs';

const sampleBase64='uTvE4PLgIO707vDs6+Xt6P870tE70u7i4PA7zeXy8u470uDw4DvB8PPy8u4KMTswMS4xMS4yMDI2IDEyOjAwO+A5MDXz7jvR6uDr4DsyNzI0MDsxMjAwMDszOTI0MAoyOzAxLjExLjIwMjYgMTI6MzA74DkwNfPuO9Hq4OvgOzI4MDAwOzEyMDAwOzQwMDAwCjM7MDEuMTEuMjAyNiAxMzowMDvxMzAx8eI70crAy8AgKzszMDAwMDsxMjAwMDs0MjAwMAo=';
const parsed=()=>parseLegionCsv(Buffer.from(sampleBase64,'base64'));
test('CP1251 CSV preserved all trips and separated Скала and СКАЛА +',()=>{
  const data=parsed();
  assert.equal(data.rows.length,3);
  assert.equal(data.groups.length,2);
  assert.equal(data.groups[0].product,'Скала');
  assert.equal(data.groups[0].count,2);
  assert.equal(data.groups[0].tonnes,55.24);
  assert.equal(data.groups[1].product,'СКАЛА +');
  assert.equal(data.groups[1].tonnes,30);
  assert.equal(data.totalTonnes,85.24);
  assert.equal(data.rows[0].date,'2026-11-01');
  assert.equal(data.rows[0].plate,'А905УО');
  assert.equal(data.rows[1].plate,'А905УО');
  assert.equal(data.rows[2].plate,'С301СВ');
});
test('quoted semicolons/newlines survive and CSV corruption is noticed',()=>{
  assert.deepEqual(splitCsv('a;b\n"c;d";"hello\nworld"\n'),[['a','b'],['c;d','hello\nworld']]);
  assert.throws(()=>splitCsv('a;b\n"unterminated'),/кавычки/);
});
test('Latin lookalikes and region suffix normalize without guessing unknown car',()=>{
  assert.equal(plateKey('H 508 KO 125'),'Н508КО');
  assert.equal(plateKey('А 905 УО 125'),'А905УО');
  assert.equal(plateKey('С301СВ'),'С301СВ');
  const rows=classifyTrips(parsed().rows,[]);
  assert.equal(rows[0].model,'НЕТ В БАЗЕ');
  assert.deepEqual(reportSummary(rows).unknownVehicles,['А905УО','С301СВ']);
});
test('import vehicles from actual База ТС worksheet and preserve duplicate trips',async()=>{
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('База ТС');
  sheet.addRow(['Госномер','Марка/модель','Водитель']);
  sheet.addRow(['А 905 УО 125','Scania','Иванов И.И.']);
  const result=await readVehicleWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.equal(result.vehicles.length,1);
  assert.equal(result.vehicles[0].plate,'А905УО');
  assert.equal(result.vehicles[0].driver,'Иванов И.И.');
  const trips=classifyTrips(parsed().rows,result.vehicles);
  assert.equal(trips.length,3);
  assert.equal(trips.filter(x=>x.plate==='А905УО').length,2);
  assert.equal(trips[2].model,'НЕТ В БАЗЕ');
});
test('import known vehicle models from legacy one-sheet report when База ТС missing',async()=>{
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('Скала');
  sheet.getCell('D3').value='Транспортное средство';
  sheet.getCell('E4').value='Гос. Номер';
  sheet.getCell('D5').value='Самосвал FAW';
  sheet.getCell('E5').value='Н 508 КО 125';
  sheet.getCell('F5').value='Водитель А';
  const result=await readVehicleWorkbook(Buffer.from(await book.xlsx.writeBuffer()));
  assert.match(result.source,/отчёта/);
  assert.equal(result.vehicles[0].model,'Самосвал FAW');
});
test('create master Excel and readable formula-based report for each product',async()=>{
  const v=mergeVehicles([], [{plate:'А905УО',displayPlate:'А 905 УО 125',model:'FAW',driver:'Водитель А'}]);
  const master=await exportVehicleMaster(v);
  const imported=await readVehicleWorkbook(master);
  assert.equal(imported.vehicles.length,1);
  const group=groupByDateAndProduct(parsed().rows);
  assert.equal(group.length,2);
  const report=await makeLegionReport(group[0],v,{coefficient:1.55});
  const book=new ExcelJS.Workbook();await book.xlsx.load(report.buffer);
  assert.equal(book.worksheets[0].name,'Отчёт');
  assert.equal(book.worksheets[1].name,'Контроль');
  const sheet=book.getWorksheet('Отчёт');
  assert.equal(sheet.getCell('E5').value,'А 905 УО 125');
  assert.equal(sheet.getCell('F5').value,'Водитель А');
  assert.equal(sheet.getCell('H5').value,27.24);
  assert.equal(sheet.getCell('I5').value,1.55);
  assert.equal(sheet.getCell('J5').value.formula,'H5/I5');
  assert.ok(Math.abs(sheet.getCell('J5').value.result-27.24/1.55)<1e-8);
  assert.equal(sheet.getCell('J6').value.formula,'H6/I6');
  assert.equal(sheet.getCell('H7').value.formula,'SUM(H5:H6)');
  assert.equal(sheet.getCell('H7').value.result,55.24);
  assert.equal(sheet.getCell('J7').value.formula,'SUM(J5:J6)');
  const unknown=await makeLegionReport(group[1],v,{coefficient:1.55});
  const out=new ExcelJS.Workbook();await out.xlsx.load(unknown.buffer);
  assert.equal(out.getWorksheet('Отчёт').getCell('D5').value,'НЕТ В БАЗЕ');
  assert.equal(out.getWorksheet('Отчёт').getCell('F5').value,'НЕТ В БАЗЕ');
  assert.equal(report.summary.count,2);
  assert.equal(unknown.summary.count,1);
});
test('formula injection is escaped and file name is Windows-safe',async()=>{
  assert.equal(safeFilePart('Скала + : / \\ | 2026'),'Скала + _ _ _ _ 2026');
  const p=parsed();p.rows[0].product='=HYPERLINK("x")';
  const group=groupByDateAndProduct(p.rows)[0];
  const result=await makeLegionReport(group,[],{coefficient:1.55});
  const book=new ExcelJS.Workbook();await book.xlsx.load(result.buffer);
  assert.equal(book.getWorksheet('Отчёт').getCell('G5').value.startsWith("'="),true);
});
test('invalid kg, dates and missing required fields are not silently dropped',()=>{
  assert.throws(()=>parseLegionCsv(Buffer.from('ТС;Товар\nX;Скала','utf8')),/колонок/);
  const value='ТС;Товар;Дата оформления;Нетто\nА905УО;Скала;32.11.2026;12300\n';
  assert.throws(()=>parseLegionCsv(Buffer.from(value,'utf8')),/ни одного рейса/);
});
