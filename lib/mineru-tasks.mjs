// Optional MinerU 4.1 Tasks API adapter. Never used unless the operator enables it.
const safeBase=value=>{
  const url=new URL(String(value||'http://127.0.0.1:8766').replace(/\/+$/,''));
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/')
    throw Error('MinerU должен работать на локальном адресе с корневым API');
  return url.origin;
};
const headers=key=>key?{Authorization:'Bearer '+key}:{};
async function request(url,options={},timeout=30000,fetcher=fetch){
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),timeout);
  try{
    const r=await fetcher(url,{...options,signal:ac.signal,redirect:'manual'});
    if(!r.ok)throw Error('MinerU HTTP '+r.status+': '+(await r.text()).slice(0,130));
    return r;
  }catch(e){if(e.name==='AbortError')throw Error('MinerU: превышено время ожидания');throw e}
  finally{clearTimeout(timer)}
}
export async function createMineruTask({url='http://127.0.0.1:8766',key='',image,name='page.jpg',fetcher=fetch}={}){
  const origin=safeBase(url);
  const match=/^data:image\/jpeg;base64,([a-zA-Z0-9+/=]+)$/.exec(String(image||''));
  if(!match)throw Error('MinerU принимает подготовленный JPEG');
  const buffer=Buffer.from(match[1],'base64');
  if(!buffer.length||buffer.length>8*1024*1024)throw Error('Размер JPEG для MinerU превышает 8 МБ');
  const filename=String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/\.[^.]+$/,'')+'.jpg';
  // Per MinerU 4.1: server generates task_id and file_id; creation must not be retried.
  const created=await request(origin+'/v1/tasks',{
    method:'POST',headers:{...headers(key),'Content-Type':'application/json'},
    body:JSON.stringify({files:[{file_name:filename,bytes:buffer.length}],tier:'basic',output_formats:['default']})
  },60000,fetcher);
  const receipt=await created.json();
  const taskId=String(receipt.task_id||''),file=receipt.files?.[0];
  if(!/^[a-zA-Z0-9_-]{5,160}$/.test(taskId)||!file)throw Error('MinerU: в ответе нет корректного task_id или files');
  const upload=file.upload;
  if(upload?.url){
    const target=new URL(String(upload.url),origin);
    // Do not send image or credentials to an unexpected URL.
    if(target.origin!==origin||!target.pathname.startsWith('/v1/tasks/'))
      throw Error('MinerU: загрузочный адрес не совпадает с локальным API');
    const extra=upload.headers&&typeof upload.headers==='object'?upload.headers:{};
    const response=await request(target.href,{method:'PUT',headers:{...headers(key),...extra},body:buffer},60000,fetcher);
    await response.arrayBuffer();
  }
  return {taskId,fileId:String(file.file_id||''),status:String(file.status||'pending'),engine:'MinerU Tasks 4.1'};
}
export async function getMineruTask(taskId,{url='http://127.0.0.1:8766',key='',fetcher=fetch}={}){
  if(!/^[a-zA-Z0-9_-]{5,160}$/.test(taskId))throw Error('Неверный идентификатор задачи MinerU');
  const origin=safeBase(url);
  const r=await request(origin+'/v1/tasks/'+encodeURIComponent(taskId),{headers:headers(key)},25000,fetcher);
  const body=await r.json();
  return {taskId,status:String(body.status||'unknown'),files:Array.isArray(body.files)?
    body.files.map(x=>({fileId:String(x.file_id||''),status:String(x.status||'unknown'),
      // Do not return signed URLs or credentials through TENSEI UI.
      hasResult:typeof x.result_url==='string'})):[]};
}
export async function cancelMineruTask(taskId,options={}){
  if(!/^[a-zA-Z0-9_-]{5,160}$/.test(taskId))throw Error('Неверный идентификатор задачи MinerU');
  const origin=safeBase(options.url),key=options.key||'';
  const r=await request(origin+'/v1/tasks/'+encodeURIComponent(taskId)+'/cancel',{method:'POST',headers:headers(key)},25000,options.fetcher||fetch);
  return r.json();
}
