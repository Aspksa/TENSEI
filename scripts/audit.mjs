import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditStorage} from '../lib/system-audit.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=process.env.TENSEI_DATA_DIR?path.resolve(process.env.TENSEI_DATA_DIR):path.join(project,'data');
try{
  const result=await auditStorage(dir);
  console.log('TENSEI_STORAGE_AUDIT');
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=2;
}catch(e){
  console.error('TENSEI_AUDIT_ERROR: '+e.message);
  process.exitCode=1;
}
