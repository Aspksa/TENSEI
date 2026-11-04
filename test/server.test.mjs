import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function start(){
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',TENSEI_NO_BROWSER:'1'},stdio:['ignore','pipe','pipe']});
  let output='',err='';
  child.stderr.on('data',chunk=>{err+=chunk});
  return await new Promise((resolve,reject)=>{
    let ready=false;
    const timer=setTimeout(()=>{child.kill();reject(Error('Server startup timed out: '+output+' '+err))},18000);
    child.once('exit',code=>{if(!ready){clearTimeout(timer);reject(Error('Server quit '+code+': '+output+' '+err))}});
    child.stdout.on('data',chunk=>{
      output+=chunk.toString();
      const match=/TENSEI_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if(match&&!ready){ready=true;clearTimeout(timer);resolve({child,url:match[1]})}
    });
  });
}
test('локальный HTTP сервер, черновик и Excel',async()=>{
  const {child,url}=await start();
  try{
    let r=await fetch(url+'/');
    assert.equal(r.status,200);
    assert.match(await r.text(),/TENSEI/);
    for(const file of ['app.js','styles.css']){r=await fetch(url+'/'+file);assert.equal(r.status,200);assert.ok((await r.text()).length>100)}
    r=await fetch(url+'/api/settings');
    assert.equal(r.status,200);
    const settings=await r.json();
    assert.equal(settings.model,'qwen/qwen3-vl-235b-a22b-instruct');
    assert.equal(settings.models.length,5);
    r=await fetch(url+'/api/draft',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rows:[{vehicle:'A123BC',time:'08:20',tare:12000,gross:40000,net:28000}]})});
    assert.equal(r.status,200);
    r=await fetch(url+'/api/draft');
    assert.equal((await r.json()).rows[0].net,28000);
    r=await fetch(url+'/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:[{vehicle:'A123BC',time:'08:20',tare:12000,gross:40000,net:28000}]})});
    assert.equal(r.status,200);
    const bytes=Buffer.from(await r.arrayBuffer());
    assert.ok(bytes.length>3000);
    assert.equal(bytes.subarray(0,2).toString(),'PK');
    r=await fetch(url+'/api/draft',{method:'DELETE'});
    assert.equal(r.status,200);
  }finally{child.kill()}
});
test('запрос со стороннего Origin отклоняется',async()=>{
  const {child,url}=await start();
  try{
    const r=await fetch(url+'/api/draft',{headers:{Origin:'https://example.org'}});
    assert.equal(r.status,403);
  }finally{child.kill()}
});
