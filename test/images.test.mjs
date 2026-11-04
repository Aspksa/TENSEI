import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import bmp from 'bmp-js';
import {prepareImage} from '../lib/images.mjs';
const uri=(m,b)=>'data:'+m+';base64,'+Buffer.from(b).toString('base64');
async function sample(format){
  return sharp({create:{width:24,height:16,channels:3,background:'#fff2b0'}}).toFormat(format).toBuffer();
}
for(const [format,mime] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp'],['tiff','image/tiff'],['gif','image/gif']]){
  test('конвертация '+format+' в JPEG',async()=>{
    const original=await sample(format);
    const converted=await prepareImage(uri(mime,original));
    assert.match(converted.image,/^data:image\/jpeg;base64,/);
    const out=Buffer.from(converted.image.split(',')[1],'base64');
    assert.equal((await sharp(out).metadata()).format,'jpeg');
  });
}
test('конвертация BMP',async()=>{
  const pixels=Buffer.alloc(24*16*4,255);
  const encoded=bmp.encode({data:pixels,width:24,height:16}).data;
  const result=await prepareImage(uri('image/bmp',encoded));
  assert.equal(result.originalFormat,'BMP');
});
test('конвертация безопасного SVG',async()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="white"/></svg>';
  const result=await prepareImage(uri('image/svg+xml',Buffer.from(svg)));
  assert.match(result.image,/^data:image\/jpeg;base64,/);
});
test('опасный SVG отвергается',async()=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///C:/private.txt"/></svg>';
  await assert.rejects(()=>prepareImage(uri('image/svg+xml',Buffer.from(svg))),/небезопасные/);
});
test('неправильный файл отвергается',async()=>{
  await assert.rejects(()=>prepareImage('data:image/png;base64,'+Buffer.from('abc').toString('base64')),/Не удалось преобразовать/);
  await assert.rejects(()=>prepareImage('hi'),/не является изображением|Не удалось прочитать/);
});
