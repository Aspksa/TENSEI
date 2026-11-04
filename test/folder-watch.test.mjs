import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startFolderWatcher} from '../lib/folder-watch.mjs';

test('watcher requires stable image and never retries the same bytes',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'tensei-watch-'));
  const actions=[],events=[],seen=new Set();
  const watcher=startFolderWatcher({directory,seen,intervalMs:60000,
    onFile:async ({name})=>actions.push(name),
    onEvent:async event=>events.push(event)});
  try{
    await writeFile(path.join(directory,'journal.jpg'),Buffer.alloc(100));
    await watcher.scan();
    assert.equal(actions.length,0);
    await watcher.scan();
    assert.deepEqual(actions,['journal.jpg']);
    await watcher.scan();
    assert.equal(actions.length,1);
    assert.equal(events.some(x=>x.type==='attempt'),true);
    assert.equal(events.some(x=>x.type==='done'),true);
  }finally{watcher.stop();await rm(directory,{recursive:true,force:true})}
});
