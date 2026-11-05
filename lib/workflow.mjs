import {randomUUID} from 'node:crypto';
import {recognizeWithFallback} from './cloud.mjs';
import {parseModel} from './records.mjs';
import {improvePhoto,cropBox,fallbackBands} from './vision.mjs';
import {analyzePaddle,analyzeChandra,compareRowsWithChandra,analyzeLocalText,analyzeLocalVL,previewPerspective,analyzeLocalGrid,analyzeDigitCells,analyzeCrossouts} from './optional-ocr.mjs';
import {templatePrompt,BUILTIN_TEMPLATES} from './templates.mjs';
import {createMineruTask} from './mineru-tasks.mjs';
import {selectedModels,validateWeights,perceptualHash} from './vision-optimizer.mjs';
import {alignRowsByGeometry,completeRecoveryBands} from './table-layout.mjs';
import {localOcrConsensus,missingRowEvidence,classifyFromLayout} from './local-intelligence.mjs';
import {analyzeRapidOCR,rapidHealth} from './rapidocr.mjs';
import {detectUnruledColumns,detectEditMarks,handwritingCandidates,reconcileRows,tentativeCellsFromInk} from './photo-review-intelligence.mjs';

const rootPrompt='Распознай рукописный журнал перевозок или взвешиваний на фотографии. Ответ только JSON {"rows":[{"time":"","vehicle":"","driver":"","product":"","tare":null,"gross":null,"net":null,"note":"","uncertain":false,"bbox":null}]}. Все веса в кг. Каждая поездка отдельной строкой. Время в формате ЧЧ:ММ. Товар указывай только если он явно написан в строке, различай «Скала» и «СКАЛА +»; иначе product="". Если не уверен, оставь поле пустым/null и uncertain=true. Если можешь точно определить прямоугольник строки, bbox=[x1,y1,x2,y2] (доли 0..1), иначе null. Не придумывай цифры и не копируй значения из соседних колонок. Кратко, без анализа и Markdown. ';
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
  let prompt=(smart?'Прочитай все строки таблицы. Верни только короткий JSON {"rows":[{"time":"","vehicle":"","driver":"","tare":null,"gross":null,"net":null,"uncertain":false,"bbox":null}]}. Вес в кг, время ЧЧ:ММ. Не угадывай значения. ':rootPrompt)+templatePrompt(template);
  const warnings=[...page.report.warnings];
  let layout={cells:[],rows:[],columns:[],available:false};
  if(cfg.paddle===true){
    progress('PaddleOCR + OpenCV: выделение строк и ячеек');
    try{layout=await analyzePaddle(page.image,{width:page.report.width,height:page.report.height,url:paddleUrl});}
    catch(e){warnings.push('PP-StructureV3 недоступна: '+String(e.message).slice(0,130))}
  }
  // OpenCV needs no expensive vision model. It can still provide grid geometry
  // if PP-StructureV3 is missing, unavailable or unable to find a table.
  if((cfg.gridSegmentation===true||cfg.autoPipeline===true)&&!layout.available){
    progress('OpenCV: локальная сегментация таблицы');
    try{layout=await analyzeLocalGrid(page.image,{width:page.report.width,height:page.report.height,url:paddleUrl});}
    catch(e){warnings.push('Локальная сегментация не сработала: '+String(e.message).slice(0,130))}
  }
  let localOcr=null,localVl=null,perspective=null;
  if(cfg.cvPreprocess===true){
    progress('OpenCV: предварительная коррекция геометрии');
    try{const p=await previewPerspective(page.image,{url:paddleUrl});
      perspective={available:p.applied,reason:p.reason||null};
      if(p.applied)warnings.push('OpenCV подготовил вариант исправленного фото; оригинал сохранён без геометрической замены.');
    }catch(e){warnings.push('OpenCV недоступен: '+String(e.message).slice(0,120))}
  }
  if(cfg.localText===true||cfg.autoPipeline===true){
    // On a laptop prefer the explicitly installed small CPU engine.
    // Never start or install heavyweight OCR automatically.
    const rapidAddress=process.env.TENSEI_RAPIDOCR_URL||'http://127.0.0.1:8767';
    const rapid=await rapidHealth(rapidAddress);
    if(rapid.available){
      progress('RapidOCR CPU: локальный предварительный просмотр');
      try{localOcr=await analyzeRapidOCR(page.image,{url:rapidAddress});}
      catch(e){warnings.push('RapidOCR не смог прочитать фото: '+String(e.message).slice(0,120))}
    }
    if(!localOcr){
      progress('PP-OCRv6: локальное чтение');
      try{const output=await analyzeLocalText(page.image,{url:paddleUrl});
        localOcr={engine:output.engine,lines:output.lines.slice(0,150),
          recognizedCells:(output.recognizedCells||[]).slice(0,300),verified:false};
      }catch(e){warnings.push('Локальный PP-OCRv6 недоступен: '+String(e.message).slice(0,120))}
    }
  }
  let visualCorrections=null;
  if(cfg.autoPipeline===true){
    try{visualCorrections=await analyzeCrossouts(page.image,{url:paddleUrl});}
    catch(e){warnings.push('Детектор исправлений недоступен: '+String(e.message).slice(0,90))}
  }
  let digitCells=null;
  if(cfg.digitCellOcr===true||(cfg.autoPipeline===true&&layout.cells.length>0)){
    progress('Локальный OCR: рукописные цифры по ячейкам');
    try{digitCells=await analyzeDigitCells(page.image,{url:paddleUrl});}
    catch(e){warnings.push('Локальный OCR цифр недоступен: '+String(e.message).slice(0,130))}
  }
  if(cfg.localVl===true){
    progress('PaddleOCR-VL: локальный анализ');
    try{const output=await analyzeLocalVL(page.image,{url:paddleUrl});
      localVl={engine:output.engine,preview:output.preview.slice(0,3000),verified:false};
    }catch(e){warnings.push('Локальный PaddleOCR-VL недоступен: '+String(e.message).slice(0,120))}
  }
  const preReadHint=classifyFromLayout(layout,localOcr,BUILTIN_TEMPLATES);
  if(cfg.autoPipeline===true&&template?.id==='generic'&&preReadHint.suggestedTemplate==='weights'){
    prompt=(smart?'Прочитай все строки рукописной таблицы. Верни только JSON rows. Не угадывай цифры. ':rootPrompt)+
      templatePrompt(BUILTIN_TEMPLATES[0]);
    warnings.push('Локально обнаружены признаки весового журнала: выбран соответствующий ориентир колонок.');
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
    const segments=layout.rows.length>=2?completeRecoveryBands(layout.rows):fallbackBands(2);
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
  // A row count match does not prove correspondence. Only attach grid
  // geometry where OCR returned coordinates that agree spatially.
  rows=alignRowsByGeometry(rows,layout.rows);
  const missingRows=missingRowEvidence(rows,layout);
  if(layout.method!=='ink-projection'&&missingRows.incomplete){
    warnings.push('Сетка содержит '+missingRows.unmatched.length+
      ' строк без подтверждённой координатной связи: проверьте пропущенные рейсы.');
  }
  const documentHint=preReadHint;
  const unruledColumns=detectUnruledColumns(localOcr?.lines||[]);
  const tentativeCells=layout.cells.length===0?
    tentativeCellsFromInk(layout.rows,unruledColumns):{boxes:[],verified:false,reason:'ruled-grid-preferred'};
  const suspectedCorrections=detectEditMarks(localOcr?.lines||[]);
  const rowCoverage=reconcileRows(rows,layout.rows);
  const localDigitCandidates=handwritingCandidates((digitCells?.cells||[]).map(x=>({...x,engine:'PP-OCRv6'})));
  if(suspectedCorrections.length)warnings.push('Встречены текстовые признаки исправлений: '+suspectedCorrections.length+'; требуется сверка.');
  const cellConsensus=localOcrConsensus(localOcr,{
    recognizedCells:(digitCells?.cells||[]).map(x=>({
      bbox:x.bbox,text:x.text,confidence:x.score
    }))
  });
  if(digitCells?.cells?.length){
    const disagreements=cellConsensus.filter(c=>c.readers===2&&!c.agree).length;
    if(disagreements)warnings.push('Локальные модели разошлись в '+disagreements+
      ' ячейках; значения остаются на ручную проверку.');
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
  const ocrComparison={
    availableEngines:[
      ...(localOcr?['PP-OCRv6 full-page']:[]),
      ...(digitCells?['PP-OCRv6 isolated cells']:[]),
      ...(comparison?.checked?['Chandra text presence']:[]),
      ...(localVl?['PaddleOCR-VL document understanding']:[])
    ],
    spatialComparisons:cellConsensus.filter(x=>x.readers>=2).length,
    spatialDisagreements:cellConsensus.filter(x=>x.readers>=2&&!x.agree).length,
    pageLevelChandraOnly:Boolean(comparison?.checked),
    verified:false,
    limitations:'PaddleOCR cell and page paths share a model; Chandra/VL lack verified cell coordinates. OCR agreement does not prove correctness.'
  };
  progress('Формирование результата');
  return {rows,sourceId:id,model:model||cfg.model,fallbackFrom,attempts,cloudCalls:calls,
    imageHash,costMode:cfg.costMode||'off',usage:usageAvailable?usage:null,modelUsage,format:page.format,
    quality:page.report,layout:{engine:layout.engine||null,available:layout.available,
      method:layout.method||null,confidence:layout.confidence??null,
      cells:layout.cells.length,rows:layout.rows.length,
      cellBoxes:layout.cells.slice(0,1200),rowBoxes:layout.rows.slice(0,150),
      columnBoxes:(layout.columns||[]).slice(0,40)},
    comparison,mineruTask,localOcr,localVl,digitCells,
    missingRows,documentHint,cellConsensus,ocrComparison,perspective,
    unruledColumns,tentativeCells,suspectedCorrections,visualCorrections,rowCoverage,localDigitCandidates,warnings,image:page.image};
}
