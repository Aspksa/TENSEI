import {safeRows} from './records.mjs';

// A completed OCR task is not the same as an operator-approved record.
export function exportReadiness(rows){
  const checked=safeRows(rows);
  const reviewPending=checked.filter(r=>!r.reviewed).map(r=>r.index+1);
  const invalid=checked.filter(r=>r.issues.length).map(r=>({row:r.index+1,issues:r.issues}));
  return {ready:checked.length>0&&reviewPending.length===0&&invalid.length===0,
    total:checked.length,reviewPending,invalid};
}
export function statusLabel(task){
  if(task?.status==='done')return 'Готово · '+Math.max(0,Number(task.rowCount)||0)+' строк';
  if(task?.status==='error')return 'Ошибка · '+String(task.error||'нет подробностей').slice(0,90);
  if(task?.status==='processing')return 'Обработка · '+String(task.phase||'подготовка')+' · '+Math.min(99,Math.max(0,Number(task.progress)||0))+'%';
  return 'В очереди';
}
