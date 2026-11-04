import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rapidUrl,rapidHealth,analyzeRapidOCR} from '../lib/rapidocr.mjs';

test('RapidOCR adapter disallows remote network endpoints',()=>{
  for(const url of ['https://example.org','http://192.168.1.5:8767',
    'http://localhost:8767/path','http://user:pass@localhost:8767'])
    assert.throws(()=>rapidUrl(url));
});
test('RapidOCR service health and text are bounded, local and never verified',async()=>{
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health'){res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ok:true,installed:true,keepWarm:false}));return}
    let payload='';for await(const chunk of req)payload+=chunk.toString();
    assert.equal(JSON.parse(payload).image,'data:image/jpeg;base64,abcd');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({lines:[{text:'27000',bbox:[.1,.1,.3,.2],score:.8,verified:true},
      {text:'bad',bbox:[1,1,0,0]}],engine:'RapidOCR CPU ONNX'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url='http://127.0.0.1:'+server.address().port;
    assert.equal((await rapidHealth(url)).available,true);
    const out=await analyzeRapidOCR('data:image/jpeg;base64,abcd',{url});
    assert.equal(out.lines.length,1);
    assert.equal(out.verified,false);
    assert.equal(out.lines[0].verified,false);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
