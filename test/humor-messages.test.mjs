import test from 'node:test';
import assert from 'node:assert/strict';
import {HUMOR_MESSAGES,humorCategory,createHumorRotator} from '../humor-messages.js';

test('exactly 309 unique original humor lines in three categories',()=>{
  assert.equal(HUMOR_MESSAGES.length,309);
  assert.equal(new Set(HUMOR_MESSAGES.map(x=>x.text)).size,309);
  for(const category of ['handwriting','photo','processing'])
    assert.equal(HUMOR_MESSAGES.filter(x=>x.category===category).length,103);
});
test('processing stages choose sensible caption category',()=>{
  assert.equal(humorCategory('Подготовка изображения'),'photo');
  assert.equal(humorCategory('PaddleOCR: анализ ячеек'),'handwriting');
  assert.equal(humorCategory('Cloud.ru: анализ страницы'),'handwriting');
  assert.equal(humorCategory('Формирование результата'),'processing');
});
test('rotator visits each message once before reuse and avoids immediate repeats',()=>{
  const next=createHumorRotator(()=>0.45);
  for(const category of ['photo','handwriting','processing']){
    const values=Array.from({length:103},()=>next(category));
    assert.equal(new Set(values).size,103);
    assert.notEqual(next(category),values.at(-1));
  }
});
