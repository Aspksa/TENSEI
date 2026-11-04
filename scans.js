// Vector (SVG) progress display + accessible contextual explanations.
const $=id=>document.getElementById(id);
function seconds(start){
  const ms=Date.now()-Date.parse(start||new Date().toISOString());
  return Math.max(0,Math.floor(ms/1000));
}
const time=v=>String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');
function progress(scan){
  const panel=$('scanConsole');if(!panel||!scan)return;
  panel.hidden=false;
  const stage=scan.stage||'Обработка фотографии';
  const elapsed=seconds(scan.startedAt||scan.createdAt);
  panel.className='scan-console '+(
    scan.status==='error'||scan.status==='interrupted'?'is-error':
      scan.status==='done'?'is-done':'is-running');
  $('scanStage').textContent=stage;
  $('scanElapsed').textContent=time(elapsed)+' · '+({
    queued:'В очереди',processing:'Выполняется',done:'Завершено',
    error:'Ошибка',interrupted:'Прервано'
  }[scan.status]||scan.status);
  const p=Math.max(0,Math.min(100,Number(scan.progress)||0));
  $('scanRing').setAttribute('stroke-dashoffset',String(232.5*(1-p/100)));
  $('progressBar').style.width=p+'%';
  const tip=scan.status==='done'
    ?'Файл сохранён в библиотеке. Откройте таблицу и сверьте значения с фотографией.'
    :scan.status==='error'
    ?'Ошибка распознавания не удалила оригинал. Нажмите «Повторить» в библиотеке сканов.'
    :scan.status==='interrupted'
    ?'Обработка прервалась после закрытия TENSEI. Оригинал сохранён; используйте повтор.'
    :scan.step==='cloud'&&elapsed>65
    ?'Cloud.ru пока не ответил. Один запрос может длиться до 125 секунд; при включённом резерве модель может повторить вызов.'
    :scan.step==='cloud'
    ?'Изображение передано Cloud.ru. Время зависит от модели и нагрузки сервиса. Таймер показывает фактическое ожидание.'
    :scan.step==='crop'
    ?'Основное чтение не удалось. TENSEI проверяет увеличенные участки фотографии; это отдельные платные запросы.'
    :scan.step==='prepare'
    ?'Оригинал уже записан на диск. Сейчас выполняются локальные проверки и подготовка изображения.'
    :scan.step==='queued'
    ?'Скан надёжно сохранён. Он ожидает свободную очередь распознавания.'
    :'Следите за этапом. Пустой экран не означает потерю фотографии.';
  $('scanStateHint').textContent=scan.error||tip;
  const step=scan.step||'queued';
  const sequence=['queued','prepare','cloud','crop','complete'];
  const active=['layout'].includes(step)?'prepare':['compare','mineru'].includes(step)?'cloud':step;
  const pos=sequence.indexOf(active);
  for(const span of $('scanStages').children){
    const index=sequence.indexOf(span.dataset.phase);
    span.className=scan.status==='done'?'is-done':
      scan.status==='error'&&index===pos?'is-active':
      index===pos?'is-active':index<pos?'is-done':'';
  }
}
window.TENSEIScanVisual={update:progress};
const hints={
  apiKey:'Источник: ключ Foundation Models из вашего аккаунта Cloud.ru. Ключ сохраняется в data/settings.json без шифрования; не храните его в синхронизируемой или общей папке.',
  model:'Выбирается ID мультимодальной модели из вашего каталога Cloud.ru. Наличие в каталоге не гарантирует успешное чтение рукописного фото.',
  fallback:'При некоторых ошибках Cloud.ru можно попробовать другую доступную модель; могут списаться дополнительные токены.',
  enhance:'Локально повысить контраст и яркость при необходимости. Оригинал скана всегда сохраняется без изменений.',
  cropRecovery:'Если полный лист не прочитан, попробовать увеличенные части. Дополнительные запросы могут стоить денег.',
  paddle:'Необязательный сервис PP-StructureV3 на 127.0.0.1:8765; не установлен в базовой версии.',
  chandra:'Необязательное второе распознавание через локальную Chandra. Требуются собственные модель и сервер.',
  mineru:'Необязательная независимая задача MinerU. Базовое чтение Qwen от неё не зависит.',
  templateSelect:'Шаблон задаёт ожидаемые колонки в подсказке модели. Это не жёсткая геометрическая разметка листа.',
  recognize:'Создаёт отдельный архивный скан для каждого фото. Оригинал сохраняется до платного OCR и доступен после ошибки.',
  photoFiles:'Выберите фото; поддерживаются JPEG/PNG/WebP/TIFF/BMP и другие форматы с поддерживаемым кодеком.',
  download:'Экспортирует только текущую рабочую таблицу в Excel. Каждый отдельный скан остаётся в библиотеке.',
  clearData:'Очищает видимый рабочий лист. Фотографии и результаты в библиотеке не удаляются.',
  metricRows:'Количество строк в текущем скане, а не во всех импортированных фотографиях.',
  metricIssues:'Проверка веса, госномера, арифметики и уверенности OCR. Замечания нужно подтвердить по оригиналу.',
  metricTons:'Сумма нетто / 1000 для строк текущей таблицы.',
  refreshScans:'Перезагрузить список сканов из локальной базы. Фотографии не отправляются в интернет.',
  forceReprocess:'Повторная обработка уже сохранённой фотографии означает новые вызовы Cloud.ru и может увеличить расходы.',
  settingsHelp:'Смена модели не меняет прежние сканы. Новая настройка применяется к новым задачам.',
  saveSettings:'Сохраняет модель, ключ и режимы в файлы локальной папки data.',
  checkConnection:'Проверяет список моделей в Cloud.ru. Для полноценного теста зрения нужно отправить фото.',
  addRow:'Добавляет строку в текущую таблицу. Сведения распознавания автоматически не заполняются.',
  search:'Ищет по текущей таблице; на все архивные фото поиск не распространяется.',
  onlyIssues:'Оставляет на экране только строки с замечаниями, но не удаляет остальных.'
};
function installHints(){
  for(const [id,help] of Object.entries(hints)){
    const element=$(id);if(!element)continue;
    element.title=help;
    const heading=element.closest('.card-heading-text');
    if(heading&&heading.querySelector('.help-dot'))continue;
  }
  const group=[
    ['settingsDetails','Настройки Cloud.ru: токены используются только при распознавании. Ключ не надо публиковать.'],
    ['upload','Фото сохраняется в data/scans до вызова Cloud.ru; для каждого создаётся отдельный ID.'],
    ['results','Текущая таблица относится к одному выбранному скану; можно открыть любой сохранённый скан.'],
    ['scanLibrary','Локальная база сканов: оригиналы, обработанные JPG, статусы, заметки и распознанные строки.']
  ];
  for(const [id,help] of group){
    const container=$(id);if(!container)continue;
    const heading=container.querySelector('.card-heading-text strong, .scan-library-heading h2');
    if(!heading)continue;
    const b=document.createElement('span');b.className='help-dot';b.title=help;
    b.setAttribute('role','img');b.setAttribute('aria-label','Подсказка: '+help);b.textContent='?';
    heading.after(b);
  }
}
installHints();
