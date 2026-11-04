import sharp from 'sharp';
import bmp from 'bmp-js';
const MAX_FILE=20*1024*1024;
const MAX_PIXELS=60000000;
export const FORMATS='JPG, JPEG, PNG, WebP, GIF, TIFF, TIF, AVIF, BMP, SVG; HEIC/HEIF — если поддерживает кодек';
export async function prepareImage(dataUrl){
  if(typeof dataUrl!=='string')throw Error('Файл не является изображением');
  const match=/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if(!match||!(match[1].startsWith('image/')||match[1]==='application/octet-stream'))throw Error('Не удалось прочитать формат изображения');
  if(match[2].length>Math.ceil(MAX_FILE*4/3)+8)throw Error('Файл больше 20 МБ');
  const buffer=Buffer.from(match[2],'base64');
  if(buffer.length===0||buffer.length>MAX_FILE)throw Error('Файл пуст или превышает 20 МБ');
  let input=buffer,description='Изображение';
  if(buffer.subarray(0,2).toString('ascii')==='BM'){
    if(buffer.length<54)throw Error('Повреждённый BMP');
    const width=Math.abs(buffer.readInt32LE(18)),height=Math.abs(buffer.readInt32LE(22));
    if(!width||!height||width*height>MAX_PIXELS)throw Error('Слишком большое BMP-изображение');
    try{const decoded=bmp.decode(buffer);input={create:null,raw:{width:decoded.width,height:decoded.height,channels:4},data:Buffer.from(decoded.data)};description='BMP'}catch{throw Error('BMP повреждён или не поддерживается')}
  }
  if(/<svg[\s>]/i.test(buffer.toString('utf8',0,Math.min(buffer.length,1024)))){
    const xml=buffer.toString('utf8');
    if(/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|(?:href|src)\s*=\s*["'](?:https?:|file:|\/\/|data:)/i.test(xml))
      throw Error('В SVG обнаружены небезопасные внешние элементы');
    description='SVG';
  }
  let pipeline;
  try{
    pipeline=input&&input.raw
      ?sharp(input.data,{raw:input.raw,limitInputPixels:MAX_PIXELS})
      :sharp(input,{limitInputPixels:MAX_PIXELS,pages:1});
    const meta=await pipeline.metadata();
    if(meta.width&&meta.height&&meta.width*meta.height>MAX_PIXELS)throw Error('Изображение слишком большое');
    const converted=await pipeline.rotate().flatten({background:'#ffffff'})
      .resize({width:3400,height:3400,fit:'inside',withoutEnlargement:true})
      .jpeg({quality:89,mozjpeg:true}).toBuffer();
    if(converted.length>8*1024*1024)throw Error('После преобразования файл больше 8 МБ');
    return {image:'data:image/jpeg;base64,'+converted.toString('base64'),originalFormat:description==='Изображение'?(meta.format||'неизвестно'):description,
      width:meta.width||null,height:meta.height||null};
  }catch(error){
    if(/heic|heif/i.test(match[1])||/heif/i.test(String(error.message)))
      throw Error('HEIC/HEIF не поддерживается установленным кодеком. Сохраните фото в JPG или PNG.');
    if(error.message.includes('Слишком')||error.message.includes('больше'))throw error;
    throw Error('Не удалось преобразовать изображение: '+String(error.message).slice(0,160));
  }
}
