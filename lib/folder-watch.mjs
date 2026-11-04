import fs from 'node:fs/promises';
import path from 'node:path';

// Opt-in polling of a single directory; no recursive crawl and no implicit retries.
export function startFolderWatcher({directory,onFile,onEvent=()=>{},seen=new Set(),intervalMs=15000}){
  if(typeof onFile!=='function')throw TypeError('onFile required');
  const prior=new Map();
  let running=false,stopped=false;
  const scan=async()=>{
    if(stopped||running)return;
    running=true;
    try{
      const entries=await fs.readdir(directory,{withFileTypes:true});
      for(const entry of entries){
        if(!entry.isFile()||!/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(entry.name))continue;
        const file=path.join(directory,entry.name),stat=await fs.stat(file);
        if(stat.size<10||stat.size>20*1024*1024)continue;
        const key=entry.name+'|'+stat.size+'|'+stat.mtimeMs;
        if(seen.has(key))continue;
        if(prior.get(entry.name)!==key){prior.set(entry.name,key);continue}
        seen.add(key);
        // Persist attempted key before any model request; failing files require
        // an explicit operator retry/rename, not an endless paid loop.
        await onEvent({type:'attempt',key,name:entry.name});
        try{await onFile({name:entry.name,path:file,key});await onEvent({type:'done',key,name:entry.name})}
        catch(error){await onEvent({type:'error',key,name:entry.name,error:String(error?.message||error).slice(0,160)})}
      }
    }finally{running=false}
  };
  const timer=setInterval(()=>{scan().catch(error=>Promise.resolve(onEvent({type:'scanner-error',error:String(error.message)})).catch(()=>{}))},intervalMs);
  timer.unref?.();
  return {scan,stop:()=>{stopped=true;clearInterval(timer)}};
}
