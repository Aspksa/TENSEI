import {randomUUID} from 'node:crypto';
import {recognizeWithFallback,CloudError} from './cloud.mjs';
import {parseModel} from './records.mjs';
import {improvePhoto,cropBox,fallbackBands} from './vision.mjs';
import {analyzePaddle,analyzeChandra,compareRowsWithChandra} from './optional-ocr.mjs';
import {templatePrompt} from './templates.mjs';
import {createMineruTask} from './mineru-tasks.mjs';

const rootPrompt='Распознай рукописный журнал перевозок или взвешиваний на фотографии. Ответ только JSON {"rows":[{"time":"","vehicle":"","driver":"","tare":null,"gross":null,"net":null,"note":"","uncertain":false,"bbox":null}]}. Все веса в кг. Каждая поездка отдельной строкой. Время в формате ЧЧ:ММ. Если не уверен, оставь поле пустым/null и uncertain=true. Если можешь точно определить прямоугольник строки, bbox=[x1,y1,x2,y2] (доли 0..1), иначе null. Не придумывай цифры и не копируй значения из соседних колонок. Кратко, без анализа и Markdown. ';
const safeName=x=>String(x||'фото').replace(/[\\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,170);
const parseText=txt=>{
  const rows=parseModel(txt);
  if(rows.length===0)throw Error('Модель вернула пустую таблицу. Попробуйте увеличить фотографию или обработать её по частям.');
  return rows;
};
function globalize(box,region){
  if(!Array.isArray(box))return null;
  const [x1,y1,x2,y2]=region;
  return [x1+box[0]*(x2-x1),y1+box[1]*(y2-y1),x1+box[2]*(x2-x1),y1+box[3]*(y2-y1)];
}
export async function processPhoto({image,name,cfg,template={},paddleUrl,chandraUrl,mineruUrl,mineruKey,progress=()=>{}}){
  const page=await improvePhoto(image,{enhance:cfg.enhance!==false});
  const id=randomUUID();
  const prompt=rootPrompt+templatePrompt(template);
  const warnings=[...page.report.warnings];
  let layout={cells:[],rows:[],available:false};
  if(cfg.paddle===true){
    progress('PaddleOCR: анализ ячеек');
    try{layout=await analyzePaddle(page.image,{width:page.report.width,height:page.report.height,url:paddleUrl});}
    catch(e){warnings.push('PaddleOCR не сработал: '+String(e.message).slice(0,130))}
  }
  progress('Cloud.ru: анализ страницы');
  let rows=[],model='',fallbackFrom='',attempts=0;
  let originalFailure='';
  try{
    const result=await recognizeWithFallback({key:cfg.key,model:cfg.model,image:page.image,prompt,fallback:cfg.fallback});
    rows=parseText(result.text);
    model=result.model;fallbackFrom=result.fallbackFrom||'';attempts=result.attempts||1;
  }catch(e){
    originalFailure=e.message;
    // Authentication, access, network and quotas are not image-quality issues.
    // Never pay for crop retries when the same request is known to be blocked.
    if(cfg.cropRecovery===false||e instanceof CloudError||
      /нет подключения|не ответил вовремя|сначала сохраните|превышен лимит|недостаточно средств|доступных резервных моделей/i.test(e.message))
      throw e;
    progress('Страница не прочиталась — распознаю увеличенные части');
    // Row crops are attempted only with geometrically plausible layout results.
    const bands=layout.rows.length>=2&&layout.rows.length<=16?layout.rows:fallbackBands(2);
    const segments=bands.slice(0,4);
    const errors=[];
    for(let i=0;i<segments.length;i++){
      try{
        const crop=await cropBox(page.image,segments[i]);
        const response=await recognizeWithFallback({key:cfg.key,model:cfg.model,image:crop,
          prompt:prompt+' Это только часть страницы '+(i+1)+' из '+segments.length+'. Сохрани все видимые строки. ',fallback:cfg.fallback});
        const part=parseText(response.text);
        rows.push(...part.map(r=>({...r,bbox:r.bbox?globalize(r.bbox,segments[i]):null,uncertain:true})));
        model=response.model;attempts+=(response.attempts||1);
      }catch(error){errors.push('Фрагмент '+(i+1)+': '+error.message)}
    }
    if(!rows.length)throw Error('Cloud.ru не смог прочитать ни страницу, ни её увеличенные части. Причина: '+
      originalFailure+(errors.length?' Дополнительно: '+errors[0]:''));
    warnings.push('Первое чтение не сработало; использованы увеличенные части, нужна ручная проверка.');
    if(errors.length)warnings.push(errors.slice(0,2).join(' | '));
  }
  if(rows.length>400)throw Error('Слишком много строк, разбейте страницу на части');
  // Never fabricate a row-to-box match. A spatial match is allowed only when
  // the independent detector and extractor returned exactly the same row count.
  if(layout.rows.length===rows.length){
    rows=rows.map((r,i)=>({...r,bbox:r.bbox||layout.rows[i]}));
  }
  rows=rows.map(r=>({...r,source:safeName(name),sourceId:id,reviewed:false}));
  let comparison=null;
  if(cfg.chandra===true){
    progress('Chandra OCR: независимое чтение');
    try{
      const secondary=await analyzeChandra(page.image,{url:chandraUrl});
      comparison=compareRowsWithChandra(rows,secondary.text);
      if(comparison.checked&&comparison.differences.length){
        for(const d of comparison.differences){
          const row=rows[d.index];
          if(row){row.uncertain=true;row.note=(row.note+' | Сравнить '+d.field+' с Chandra').slice(0,380)}
        }
        warnings.push('Chandra дала потенциальные разночтения: '+comparison.differences.length+' значений. Сверьте с исходной фотографией.');
      }
    }catch(e){warnings.push('Chandra OCR недоступна: '+String(e.message).slice(0,130))}
  }
  let mineruTask=null;
  if(cfg.mineru===true){
    try{
      progress('MinerU: создание задачи для независимого разбора');
      mineruTask=await createMineruTask({image:page.image,name:safeName(name),
        url:mineruUrl,key:mineruKey});
    }catch(e){warnings.push('MinerU Tasks недоступна: '+String(e.message).slice(0,120))}
  }
  return {rows,sourceId:id,model:model||cfg.model,fallbackFrom,attempts,format:page.format,
    quality:page.report,layout:{engine:layout.engine||null,available:layout.available,cells:layout.cells.length,rows:layout.rows.length},
    comparison,mineruTask,warnings,image:page.image};
}
