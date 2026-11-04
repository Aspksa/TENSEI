import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {qualityReport,improvePhoto} from '../lib/vision.mjs';

test('illumination metrics report shadows and clipped highlights without OCR accuracy claims',async()=>{
  const black=await sharp({create:{width:600,height:500,channels:3,background:'#101010'}}).png().toBuffer();
  const image=await sharp({create:{width:1200,height:1000,channels:3,background:'#ffffff'}})
    .composite([{input:black,left:0,top:0}]).jpeg().toBuffer();
  const report=await qualityReport(image);
  assert.ok(report.unevenIllumination>95);
  assert.ok(report.glareFraction>.1);
  assert.ok(report.warnings.some(x=>x.includes('тени')));
  const result=await improvePhoto('data:image/jpeg;base64,'+image.toString('base64'),
    {enhance:true,compact:true});
  assert.match(result.image,/^data:image\/jpeg;base64,/);
  assert.equal(result.report.unevenIllumination,report.unevenIllumination);
});
