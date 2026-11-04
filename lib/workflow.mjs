import {randomUUID} from 'node:crypto';
import {recognizeWithFallback} from './cloud.mjs';
import {parseModel} from './records.mjs';
import {improvePhoto,cropBox,fallbackBands} from './vision.mjs';
import {analyzePaddle,analyzeChandra,compareRowsWithChandra,analyzeLocalText,analyzeLocalVL,previewPerspective} from './optional-ocr.mjs';
import {templatePrompt} from './templates.mjs';
import {createMineruTask} from './mineru-tasks.mjs';
import {selectedModels,validateWeights,perceptualHash} from './vision-optimizer.mjs';

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
export async function processPhoto({image,name,cfg,template={},paddleUrl,chandraUrl,mineruUrl,mineruKey,progress=()=>{},telemetry=()=>{}}){
  progress('Подготовка изображения');
  const smart=cfg.costMode&&cfg.costMode!=='off';
  const page=await improvePhoto(image,{enhance:cfg.enhance!==false,compact:smart});
  const imageHash=await perceptualHash(page.image);
  const models=selectedModels(cfg.costMode,cfg.model);
  const budget=Math.max(1,Math.min(6,Number(cfg.maxCloudCalls)||3));
  let calls=0;
  const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0};
  const modelUsage=[];
  let usageAvailable=false;
  const onCall=({model,attempt})=>{
    if(smart&&calls>=budget)throw Error('Лимит облачных запросов на фото исчерпан');
    calls++;
    telemetry({cloudCalls:calls,usage:usageAvailable?{...usage}:null,modelUsage:[...modelUsage]});
    progress('Cloud.ru: запрос '+calls+' · '+model);
  };
  const onUsage=({model,attempt,usage:part,finishReason})=>{
    usageAvailable=true;
    const numeric={};
    for(const key of ['prompt_tokens','completion_tokens','total_tokens']){
      if(Number.isFinite(Number(part?.[key]))&&part?.[key]!=null){
        numeric[key]=Number(part[key]);usage[key]+=numeric[key];
      }
    }
    modelUsage.push({model,attempt,finishReason,...numeric});
    telemetry({cloudCalls:calls,usage:{...usage},modelUsage:[...modelUsage]});
  };
  const invoke=async (model,photo,query)=>{
    // Actual HTTP calls, including retries and fallbacks, are counted individually.
    return recognizeWithFallback({key:cfg.key,model,image:photo,prompt:query,
      fallback:!smart&&cfg.fallback,maxTokens:smart?3500:8000,retryEmpty:!smart,onCall,onUsage});
  };
  const id=randomUUID();
  const prompt=(smart?'Прочитай все строки таблицы. Верни только короткий JSON {"rows":[{"time":"","vehicle":"","driver":"","tare":null,"gross":null,"net":null,"uncertain":false,"bbox":null}]}. Вес в кг, время ЧЧ:ММ. Не угадывай значения. ':rootPrompt)+templatePrompt(template);
  const warnings=[...page.report.warnings];
  let layout={cells:[],rows:[],available:false};
  if(cfg.paddle===true){
    progress('PaddleOCR: анализ ячеек');
    try{layout=await analyzePaddle(page.image,{width:page.report.width,height:page.report.height,url:paddleUrl});}
    catch(e){warnings.push('PaddleOCR не сработал: '+String(e.message).slice(0,130))}
  }
  let localOcr=null,localVl=null,perspective=null;
  if(cfg.cvPreprocess===true){
    progress('OpenCV: предварительная коррекция геометрии');
    try{const p=await previewPerspective(page.image,{url:paddleUrl});
      perspective={available:p.applied,reason:p.reason||null};
      if(p.applied)warnings.push('OpenCV подготовил вариант исправленного фото; оригинал сохранён без геометрической замены.');
    }catch(e){warnings.push('OpenCV недоступен: '+String(e.message).slice(0,120))}
  }
  if(cfg.localText===true){
    progress('PP-OCRv6: локальное чтение');
    try{const output=await analyzeLocalText(page.image,{url:paddleUrl});
      localOcr={engine:output.engine,lines:output.lines.slice(0,150),verified:false};
    }catch(e){warnings.push('Локальный PP-OCRv6 недоступен: '+String(e.message).slice(0,120))}
  }
  if(cfg.localVl===true){
    progress('PaddleOCR-VL: локальный анализ');
    try{const output=await analyzeLocalVL(page.image,{url:paddleUrl});
      localVl={engine:output.engine,preview:output.preview.slice(0,3000),verified:false};
    }catch(e){warnings.push('Локальный PaddleOCR-VL недоступен: '+String(e.message).slice(0,120))}
  }
  progress('Cloud.ru: анализ страницы');
  let rows=[],model='',fallbackFrom='',attempts=0;
  let originalFailure='';
  try{
    const result=await invoke(smart?models.primary:cfg.model,page.image,prompt);
    rows=parseText(result.text);
    model=result.model;fallbackFrom=result.fallbackFrom||'';attempts=result.attempts||1;
  }catch(e){
    originalFailure=e.message;
    if(cfg.cropRecovery===false)throw e;
    progress('Страница не прочиталась — распознаю увеличенные части');
    // Row crops are attempted only with geometrically plausible layout results.
    const bands=layout.rows.length>=2&&layout.rows.length<=16?layout.rows:fallbackBands(2);
    const segments=bands.slice(0,4);
    const errors=[];
    for(let i=0;i<segments.length;i++){
      try{
        const crop=await cropBox(page.image,segments[i]);
        const response=await invoke(smart?models.primary:cfg.model,crop,
          prompt+' Это часть страницы '+(i+1)+' из '+segments.length+'. Сохрани все видимые строки. ');
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
  const validation=validateWeights(rows);
  if(smart&&validation.flagged){
    progress('Локальная проверка сомнительных строк');
    warnings.push('Проверить вручную '+validation.flagged+' строк: локальные правила нашли неопределённые значения.');
    // Never overwrite the primary extraction based on a single crop read.
    // Only cropped rows with actual model-provided coordinates may be checked.
    const candidates=rows.filter(r=>r.uncertain&&Array.isArray(r.bbox)&&r.bbox.length===4).slice(0,2);
    for(const candidate of candidates){
      if(calls>=budget)break;
      try{
        const crop=await cropBox(page.image,candidate.bbox,{width:1300});
        progress('Cloud.ru: проверка проблемной строки');
        const check=await invoke(models.review,crop,
          'Перепроверь только одну строку рукописной таблицы. Только JSON rows; пустые значения вместо догадок.');
        attempts+=check.attempts||1;
        candidate.reviewHint=String(check.text||'').slice(0,900);
        candidate.uncertain=true;
      }catch(e){warnings.push('Проверка фрагмента не завершена: '+String(e.message).slice(0,100))}
    }
  }
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
  progress('Формирование результата');
  return {rows,sourceId:id,model:model||cfg.model,fallbackFrom,attempts,cloudCalls:calls,
    imageHash,costMode:cfg.costMode||'off',usage:usageAvailable?usage:null,modelUsage,format:page.format,
    quality:page.report,layout:{engine:layout.engine||null,available:layout.available,cells:layout.cells.length,rows:layout.rows.length},
    comparison,mineruTask,localOcr,localVl,perspective,warnings,image:page.image};
}
