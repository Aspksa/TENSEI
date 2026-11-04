import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function start(){
  const dataDir=await mkdtemp(path.join(tmpdir(),'tensei-test-'));
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',TENSEI_NO_BROWSER:'1',TENSEI_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
  let output='',err='';
  child.stderr.on('data',chunk=>{err+=chunk});
  return await new Promise((resolve,reject)=>{
    let ready=false;
    const timer=setTimeout(()=>{child.kill();reject(Error('Server startup timed out: '+output+' '+err))},18000);
    child.once('exit',code=>{if(!ready){clearTimeout(timer);reject(Error('Server quit '+code+': '+output+' '+err))}});
    child.stdout.on('data',chunk=>{
      output+=chunk.toString();
      const match=/TENSEI_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if(match&&!ready){ready=true;clearTimeout(timer);resolve({child,url:match[1],dataDir})}
    });
  });
}
test('локальный HTTP сервер, черновик и Excel',async()=>{
  const {child,url,dataDir}=await start();
  try{
    let r=await fetch(url+'/');
    assert.equal(r.status,200);
    const home=await r.text();
    assert.match(home,/TENSEI/);
    assert.match(home,/Проверка и реестр/);
    assert.match(home,/photoStatusSteps/);
    assert.match(home,/humorCaption/);
    assert.match(home,/autoExcel/);
    assert.match(home,/cropPreview/);
    assert.match(home,/cellPicker/);
    assert.match(home,/exportReadiness/);
    assert.match(home,/autoPipeline/);
    assert.match(home,/Авто — локально/);
    for(const file of ['app.js','styles.css','humor-messages.js']){r=await fetch(url+'/'+file);assert.equal(r.status,200);assert.ok((await r.text()).length>100)}
    r=await fetch(url+'/api/settings');
    assert.equal(r.status,200);
    const settings=await r.json();
    assert.equal(settings.model,'qwen/qwen3-vl-235b-a22b-instruct');
    assert.equal(settings.models.length,5);
    assert.equal(settings.costMode,'auto');
    assert.equal(settings.autoPipeline,true);
    assert.equal(settings.digitCellOcr,false);
    r=await fetch(url+'/api/photo-groups');assert.equal(r.status,200);
    assert.deepEqual((await r.json()).groups,[]);
    r=await fetch(url+'/api/local-recognize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    assert.equal(r.status,400);
    r=await fetch(url+'/api/templates');assert.equal(r.status,200);
    assert.ok((await r.json()).templates.length>=2);
    r=await fetch(url+'/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'Мой журнал',columns:'Время, Автомобиль, Тара, Брутто, Нетто'})});
    assert.equal(r.status,200);
    const added=await r.json();assert.ok(added.template.id.startsWith('user-'));
    r=await fetch(url+'/api/templates');assert.ok((await r.json()).templates.some(x=>x.id===added.template.id));
    r=await fetch(url+'/api/tasks');assert.equal(r.status,200);assert.deepEqual((await r.json()).tasks,[]);
    r=await fetch(url+'/api/ai-monitor');assert.equal(r.status,200);
    const aiMonitor=await r.json();
    assert.equal(aiMonitor.estimatedCostRub,null);
    assert.equal(aiMonitor.watchEnabled,false);
    assert.ok(Array.isArray(aiMonitor.recentWatchEvents));
    r=await fetch(url+'/api/approved-memory');assert.equal(r.status,200);
    assert.deepEqual((await r.json()).vehicles,[]);
    r=await fetch(url+'/api/approved-memory',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({vehicles:['А123'],drivers:['Иван']})});
    assert.equal(r.status,400);
    r=await fetch(url+'/api/approved-memory',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({confirmed:true,vehicles:['А123'],drivers:['Иван']})});
    assert.equal(r.status,200);
    r=await fetch(url+'/api/approved-memory');assert.equal(r.status,200);
    assert.deepEqual((await r.json()).vehicles,['А123']);
    r=await fetch(url+'/analytics');assert.equal(r.status,200);assert.match(await r.text(),/Аналитика перевозок/);
    r=await fetch(url+'/analytics.js');assert.equal(r.status,200);
    r=await fetch(url+'/api/photo-report/0123456789abcdef01234567');assert.equal(r.status,404);

    r=await fetch(url+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key:'test-api-key-not-real',model:'Qwen/Qwen3.5-397B-A17B',fallback:true})});
    assert.equal(r.status,200);
    r=await fetch(url+'/api/settings');
    const updatedSettings=await r.json();
    assert.equal(updatedSettings.hasKey,true);
    assert.equal(updatedSettings.model,'Qwen/Qwen3.5-397B-A17B');
    assert.ok(!JSON.stringify(updatedSettings).includes('test-api-key-not-real'));

    r=await fetch(url+'/api/draft',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rows:[{vehicle:'A123BC',time:'08:20',tare:12000,gross:40000,net:28000}]})});
    assert.equal(r.status,200);
    r=await fetch(url+'/api/draft');
    assert.equal((await r.json()).rows[0].net,28000);
    r=await fetch(url+'/api/export',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({verifiedOnly:true,rows:[{vehicle:'A123BC',time:'08:20',
        tare:12000,gross:40000,net:28000,reviewed:false}]})});
    assert.equal(r.status,409,'server must reject unreviewed rows for automatic Excel');
    r=await fetch(url+'/api/export',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({verifiedOnly:true,rows:[{vehicle:'A123BC',time:'08:20',
        tare:12000,gross:40000,net:29000,reviewed:true}]})});
    assert.equal(r.status,409,'server must reject inconsistent weights');
    r=await fetch(url+'/api/export',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({verifiedOnly:true,rows:[{vehicle:'A123BC',time:'08:20',
        tare:12000,gross:40000,net:28000,reviewed:true}]})});
    assert.equal(r.status,200,'verified rows can be exported');
    assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0,2).toString(),'PK');
    const sourceId='11111111-1111-4111-8111-111111111111';
    await mkdir(path.join(dataDir,'sources'),{recursive:true});
    await writeFile(path.join(dataDir,'sources',sourceId+'.jpg'),
      await sharp({create:{width:800,height:1000,channels:3,background:'#fff'}}).jpeg().toBuffer());
    r=await fetch(url+'/api/row-crop',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sourceId,bbox:[.2,.2,.8,.3]})});
    assert.equal(r.status,200);
    const crop=await r.json();
    assert.equal(crop.verified,false);
    assert.match(crop.image,/^data:image\/jpeg;base64,/);
    const size=await sharp(Buffer.from(crop.image.split(',')[1],'base64')).metadata();
    assert.ok(size.width>400&&size.height>30);
    r=await fetch(url+'/api/row-crop',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sourceId,bbox:[.8,.8,.2,.1]})});
    assert.equal(r.status,400);
    r=await fetch(url+'/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:[{vehicle:'A123BC',time:'08:20',tare:12000,gross:40000,net:28000}]})});
    assert.equal(r.status,200);
    const bytes=Buffer.from(await r.arrayBuffer());
    assert.ok(bytes.length>3000);
    assert.equal(bytes.subarray(0,2).toString(),'PK');
    r=await fetch(url+'/api/draft',{method:'DELETE'});
    assert.equal(r.status,200);
  }finally{child.kill();await rm(dataDir,{recursive:true,force:true})}
});
test('запрос со стороннего Origin отклоняется',async()=>{
  const {child,url}=await start();
  try{
    const r=await fetch(url+'/api/draft',{headers:{Origin:'https://example.org'}});
    assert.equal(r.status,403);
  }finally{child.kill()}
});
