import sharp from 'sharp';
import {createHash} from 'node:crypto';

// Similarity hints are advisory: two visually similar pages may contain different weights.
export async function perceptualHash(dataUrl){
  const bytes=Buffer.from(String(dataUrl).split(',').at(-1),'base64');
  const {data}=await sharp(bytes).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  let bits=0n;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits=(bits<<1n)|BigInt(data[y*9+x]>data[y*9+x+1]?1:0);
  return bits.toString(16).padStart(16,'0');
}
export function hashDistance(a,b){
  if(!/^[0-9a-f]{16}$/.test(a)||!/^[0-9a-f]{16}$/.test(b))return 64;
  let n=BigInt('0x'+a)^BigInt('0x'+b),sum=0;
  while(n){sum+=Number(n&1n);n>>=1n}
  return sum;
}
export function validateWeights(rows){
  let flagged=0;
  for(const r of rows){
    const tare=Number(r.tare),gross=Number(r.gross),net=Number(r.net);
    const present=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
    const bad=Boolean(r.uncertain||!String(r.vehicle||'').trim()||
      !present(r.net)||Number(r.net)<0||Number(r.net)>45000||
      (present(r.gross)&&present(r.tare)&&gross<tare)||
      (present(r.gross)&&present(r.tare)&&present(r.net)&&Math.abs(gross-tare-net)>1)||
      (r.time&&!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(r.time)));
    if(bad){r.uncertain=true;flagged++}
  }
  return {flagged,total:rows.length};
}
export function selectedModels(mode,requested){
  const small='qwen/qwen3-vl-8b-instruct',medium='qwen/qwen3-vl-30b-a3b-instruct';
  const large='qwen/qwen3-vl-235b-a22b-instruct';
  if(mode==='economy')return {primary:small,review:medium};
  if(mode==='auto')return {primary:requested||large,review:large};
  if(mode==='balanced')return {primary:medium,review:large};
  return {primary:requested||large,review:large};
}
export function resultFingerprint(rows){
  return createHash('sha256').update(JSON.stringify(rows.map(r=>[r.time,r.vehicle,r.tare,r.gross,r.net]))).digest('hex');
}
