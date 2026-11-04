import sharp from 'sharp';
import {prepareImage} from './images.mjs';

const BASE64_PREFIX='data:image/jpeg;base64,';
export function validBox(box){
  return Array.isArray(box)&&box.length===4&&box.every(x=>typeof x==='number'&&Number.isFinite(x))&&
    box[0]>=0&&box[1]>=0&&box[2]<=1&&box[3]<=1&&box[2]>box[0]&&box[3]>box[1];
}
export function fixBox(box){
  if(!Array.isArray(box)||box.length!==4)return null;
  const b=box.map(Number);
  if(b.some(x=>!Number.isFinite(x)))return null;
  const result=[Math.min(1,Math.max(0,b[0])),Math.min(1,Math.max(0,b[1])),
    Math.min(1,Math.max(0,b[2])),Math.min(1,Math.max(0,b[3]))];
  return validBox(result)?result:null;
}
export async function qualityReport(buffer){
  const img=sharp(buffer,{limitInputPixels:60000000});
  const meta=await img.metadata();
  const {data,info}=await img.clone().resize({width:560,height:560,fit:'inside',withoutEnlargement:true})
    .greyscale().raw().toBuffer({resolveWithObject:true});
  const {width,height,channels}=info;
  let sum=0,sumSq=0,gradient=0,count=0,clipped=0;
  const tiles=Array.from({length:16},()=>({sum:0,n:0}));
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const k=(y*width+x)*channels,v=data[k];
    sum+=v;sumSq+=v*v;count++;
    if(v>=251)clipped++;
    const tile=tiles[Math.min(3,Math.floor(y*4/height))*4+Math.min(3,Math.floor(x*4/width))];
    tile.sum+=v;tile.n++;
    const lap=4*v-data[k-channels]-data[k+channels]-data[k-width*channels]-data[k+width*channels];
    gradient+=lap*lap;
  }
  const mean=sum/Math.max(count,1);
  const contrast=Math.sqrt(Math.max(0,sumSq/Math.max(count,1)-mean*mean));
  const edge=Math.sqrt(gradient/Math.max(count,1));
  const lights=tiles.filter(t=>t.n).map(t=>t.sum/t.n);
  const unevenIllumination=Math.round(Math.max(...lights)-Math.min(...lights));
  const glareFraction=Number((clipped/Math.max(count,1)).toFixed(4));
  const notes=[];
  if((meta.width||0)<900||(meta.height||0)<900)notes.push('Низкое разрешение: мелкие цифры могут быть неразборчивы');
  if(mean<65)notes.push('Слишком тёмное фото');
  if(mean>240&&contrast<28)notes.push('Слишком светлое фото, слабый контраст');
  if(contrast<19)notes.push('Низкий контраст страницы');
  if(edge<10)notes.push('Возможна смазанность или слабая детализация');
  if(unevenIllumination>95)notes.push('Неравномерное освещение: возможны тени');
  if(glareFraction>.35&&contrast>25)notes.push('Много пересвеченных областей: проверьте блики');
  return {width:meta.width,height:meta.height,brightness:Math.round(mean),
    contrast:Math.round(contrast),detail:Math.round(edge),glareFraction,
    unevenIllumination,warnings:[...new Set(notes)]};
}
export async function improvePhoto(image,{enhance=true,compact=false}={}){
  const converted=await prepareImage(image);
  const b=Buffer.from(converted.image.slice(BASE64_PREFIX.length),'base64');
  const report=await qualityReport(b);
  let out=b;
  if(enhance&&(report.brightness<100||report.brightness>226||report.contrast<35||report.unevenIllumination>95)){
    out=await sharp(b).normalise({lower:2,upper:98}).sharpen({sigma:0.6}).jpeg({quality:90}).toBuffer();
  }
  if(compact){
    const before=(await sharp(out).metadata());
    // Downscale only oversized photos, preserve small handwritten digits.
    const target=report.detail<25?3000:2400;
    if(Math.max(before.width||0,before.height||0)>target){
      out=await sharp(out).resize({width:target,height:target,fit:'inside',withoutEnlargement:true})
        .jpeg({quality:88}).toBuffer();
      report.optimizedSize=true;
      report.optimizedLongEdge=target;
    }
  }
  return {image:BASE64_PREFIX+out.toString('base64'),report,format:converted.originalFormat};
}
export async function cropBox(image,box,{width=1600,quality=91}={}){
  const bounds=fixBox(box);
  if(!bounds)throw Error('Неверные координаты выделения');
  const buffer=Buffer.from(image.replace(/^data:image\/jpeg;base64,/,'') ,'base64');
  const meta=await sharp(buffer).metadata();
  const left=Math.floor(bounds[0]*meta.width),top=Math.floor(bounds[1]*meta.height);
  const right=Math.ceil(bounds[2]*meta.width),bottom=Math.ceil(bounds[3]*meta.height);
  const result=await sharp(buffer).extract({left,top,width:Math.max(1,Math.min(meta.width-left,right-left)),
    height:Math.max(1,Math.min(meta.height-top,bottom-top))})
    .resize({width,withoutEnlargement:false}).jpeg({quality}).toBuffer();
  return BASE64_PREFIX+result.toString('base64');
}
export function fallbackBands(count=2){
  const n=Math.max(1,Math.min(4,Number(count)||2)),out=[];
  for(let i=0;i<n;i++)out.push([0,i/n,1,(i+1)/n]);
  return out;
}
export function rowBands(boxes){
  if(!Array.isArray(boxes)||boxes.length<2)return [];
  const valid=boxes.map(fixBox).filter(Boolean).sort((a,b)=>(a[1]+a[3])-(b[1]+b[3]));
  const rows=[];
  for(const b of valid){
    const cy=(b[1]+b[3])/2;
    let row=rows.find(x=>cy>=x.top&&cy<=x.bottom);
    if(!row){row={top:b[1],bottom:b[3],count:0};rows.push(row)}
    row.top=Math.min(row.top,b[1]);row.bottom=Math.max(row.bottom,b[3]);row.count++;
  }
  return rows.filter(r=>r.count>=2).slice(0,80).map(r=>fixBox([0,Math.max(0,r.top-.008),1,Math.min(1,r.bottom+.008)])).filter(Boolean);
}
