import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {auditStorage} from '../lib/system-audit.mjs';

test('read-only audit finds unindexed CSV files, missing images, interrupted tasks and invalid draft',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tensei-audit-'));
  try{
    await mkdir(path.join(dir,'legion','imports'),{recursive:true});
    await mkdir(path.join(dir,'sources'));
    const indexed='11111111-1111-1111-1111-111111111111';
    const orphan='22222222-2222-2222-2222-222222222222';
    await writeFile(path.join(dir,'legion','imports-index.json'),JSON.stringify([{id:indexed}]));
    await writeFile(path.join(dir,'legion','imports',indexed+'.json'),JSON.stringify({rows:[{netKg:27000}]}));
    await writeFile(path.join(dir,'legion','imports',orphan+'.json'),JSON.stringify({rows:[]}));
    await writeFile(path.join(dir,'draft.json'),'{invalid JSON');
    await writeFile(path.join(dir,'tasks.json'),JSON.stringify([
      {id:'a',status:'processing'},
      {id:'b',status:'done',sourceId:indexed}
    ]));
    const first=await auditStorage(dir);
    assert.equal(first.ok,false);
    assert.equal(first.counts.orphanImports,1);
    assert.equal(first.counts.missingTaskImages,1);
    assert.equal(first.counts.interruptedTasks,1);
    assert.equal(first.counts.importRows,1);
    for(const id of ['CSV_ORPHAN_IMPORTS','PHOTO_DRAFT_INVALID','PHOTO_SOURCES_MISSING'])
      assert.ok(first.findings.some(x=>x.code===id),id);
    assert.equal(JSON.stringify(first).includes(indexed),false,'must not leak source identifiers');
    const second=await auditStorage(dir);
    assert.equal(second.counts.orphanImports,first.counts.orphanImports);
  }finally{await rm(dir,{recursive:true,force:true})}
});
test('clean empty data folder passes integrity audit without creating files',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'tensei-audit-empty-'));
  try{
    const out=await auditStorage(dir);
    assert.equal(out.ok,true);
    assert.equal(out.counts.indexedImports,0);
    assert.equal(out.counts.photoDraftRows,0);
  }finally{await rm(dir,{recursive:true,force:true})}
});
