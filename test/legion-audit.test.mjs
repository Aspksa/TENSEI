import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {parseLegionCsv} from '../lib/legion.mjs';
import {inspectLegionTrips,crossFileDuplicates,totalReconciliation,suggestVehicle,tripIdentity} from '../lib/legion-audit.mjs';
import {groupByDateAndProduct,makeLegionOverview} from '../lib/legion-excel.mjs';

const csv='Гос номер ТС;Вид материала;Дата рейса;Нетто кг;Номер ТН\nА905УО;Скала;01.11.2026 12:00;20000;101\nС301СВ;СКАЛА +;02.11.2026 13:30;30000;102\n';
const parsed=()=>parseLegionCsv(Buffer.from(csv,'utf8'));
const base=[{plate:'А905УО',model:'FAW',driver:'Иванов'},{plate:'С301СВ',model:'КамАЗ',driver:'Петров'}];
test('additional header aliases import without losing product + distinction',()=>{
  const result=parsed();
  assert.equal(result.rows.length,2);
  assert.equal(result.rows[1].product,'СКАЛА +');
  assert.equal(result.rows[1].netKg,30000);
});
test('duplicate checker never removes repeated trips and distinguishes weights',()=>{
  const rows=parsed().rows,copy={...rows[0]};
  const repeated=[...rows,copy];
  const audit=inspectLegionTrips(repeated,base);
  assert.equal(audit.count,3);
  assert.equal(audit.duplicates.length,1);
  assert.equal(audit.ready,false);
  assert.equal(crossFileDuplicates([{name:'new.csv',rows:[copy]}],[{name:'old.csv',rows:[rows[0]]}]).length,1);
  assert.notEqual(tripIdentity({...copy,netKg:20100}),tripIdentity(copy));
});
test('critical missing base records and weight discrepancies cannot pass audit',()=>{
  const rows=parsed().rows;
  assert.equal(inspectLegionTrips(rows,base).ready,true);
  assert.equal(inspectLegionTrips(rows,[]).ready,false);
  const modified=[{...rows[0],grossKg:44000,tareKg:18000},rows[1]];
  assert.ok(inspectLegionTrips(modified,base).critical.some(x=>x.kind==='weight'));
  assert.equal(suggestVehicle('A 905 YO 125',base).model,'FAW');
  assert.equal(suggestVehicle('X123ZZ',base).source,'unknown-needs-review');
});
test('aggregate tonnes must match originals without rounding away discrepancies',()=>{
  const rows=parsed().rows;
  const groups=groupByDateAndProduct(rows);
  assert.equal(totalReconciliation(rows,groups).matches,true);
  assert.equal(totalReconciliation(rows,[groups[0]]).matches,false);
});
test('overview workbook includes monthly, daily, vehicles, products, parameter and version deltas',async()=>{
  const rows=parsed().rows;
  const file=await makeLegionOverview(rows,base,{coefficient:1.55,previous:[rows[0]]});
  const book=new ExcelJS.Workbook();await book.xlsx.load(file.buffer);
  assert.equal(book.getWorksheet('По дням').getCell('D4').value,50);
  assert.equal(book.getWorksheet('По месяцам').getCell('D3').value,50);
  assert.equal(book.getWorksheet('Параметры').getCell('B2').value,1.55);
  assert.equal(book.getWorksheet('Сравнение версий').getCell('A7').value,'Добавлен');
  assert.equal(book.getWorksheet('Сравнение версий').getCell('C3').value,50000);
  assert.equal(file.totalKg,50000);
});
