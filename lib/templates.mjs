export const BUILTIN_TEMPLATES=[
{id:'weights',name:'Журнал весовой',columns:['№','Время','Пункт / Регион','Тара','Брутто','Нетто','Водитель','Госномер'],custom:false},
{id:'generic',name:'Универсальная таблица',columns:['№','Дата','Время','Описание','Значение','Примечание'],custom:false}
];
export function templateFields(fields){
  const columns=typeof fields==='string'?fields.split(/[,;\n]+/):fields;
  if(!Array.isArray(columns))throw Error('Нужно перечислить колонки');
  const clean=columns.map(v=>String(v||'').trim().slice(0,42)).filter(Boolean);
  if(clean.length<2||clean.length>16)throw Error('В шаблоне должно быть от 2 до 16 колонок');
  if(new Set(clean.map(x=>x.toLowerCase())).size!==clean.length)throw Error('Колонки должны иметь разные имена');
  return clean;
}
export function createTemplate(data,list=[]){
  const name=String(data?.name||'').trim().slice(0,60);
  if(name.length<3)throw Error('Название шаблона должно содержать не менее 3 символов');
  const id='user-'+name.toLowerCase().replace(/[^a-zа-яё0-9]+/gi,'-').replace(/^-|-$/g,'').slice(0,48);
  if(id.length<6)throw Error('Укажите другое название шаблона');
  const columns=templateFields(data.columns);
  return {id,name,columns,custom:true};
}
export function templatePrompt(template){
  const t=template&&typeof template==='object'?template:BUILTIN_TEMPLATES[0];
  return 'Порядок колонок в журнале (ориентир, если соответствует снимку): '+templateFields(t.columns).join(' | ')+'. Не переносите значения между колонками. ';
}
