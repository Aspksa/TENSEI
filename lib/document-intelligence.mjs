// Deterministic, auditable document-level validation, never invent OCR data.
import {examine} from './records.mjs';
import {plateKey} from './legion.mjs';

export function classifyDocument(rows, template={}){
  const columns=Array.isArray(template.columns)?template.columns.join(' ').toLowerCase():'';
  const weightTerms=/тара|брутто|нетто|вес/.test(columns);
  const hasWeights=rows.some(r=>r.net!=null||r.gross!=null||r.tare!=null);
  return {type:weightTerms||hasWeights?'weighbridge_journal':'unclassified_table',
    source:weightTerms?'template':hasWeights?'content':'unknown',
    templateId:template.id||null};
}
export function confidenceReport(rows){
  const checks=examine(rows);
  return checks.map(r=>{
    const problems=[...r.issues];
    const missing=['vehicle','time','net'].filter(k=>r[k]===null||r[k]==='');
    const score=Math.max(0,Math.min(1,1-problems.length*.18-missing.length*.1));
    return {index:r.index,score:Number(score.toFixed(2)),
      level:score>=.85?'high':score>=.55?'medium':'low',
      issues:problems,requiresReview:problems.length>0||missing.length>0};
  });
}
export function approvedHints(rows,lexicon){
  const vehicles=new Set((lexicon?.vehicles||[]).map(plateKey));
  const drivers=new Set((lexicon?.drivers||[]).map(x=>String(x).toLowerCase()));
  return rows.map(r=>({vehicleKnown:vehicles.has(plateKey(r.vehicle||'')),
    driverKnown:drivers.has(String(r.driver||'').toLowerCase())}));
}
export function normalizeMemory(input){
  const clean=(a,max)=>Array.isArray(a)?[...new Set(a.filter(x=>typeof x==='string').map(x=>x.trim()).filter(Boolean).map(x=>x.slice(0,max)))].slice(0,1500):[];
  return {vehicles:clean(input?.vehicles,50).map(x=>x.toUpperCase()),
    drivers:clean(input?.drivers,100),updatedAt:new Date().toISOString()};
}

// Only flag a missing registry match when an approved vehicle registry exists.
// A human-reviewed line can be accepted without silently rewriting its plate.
export function markUnknownVehicles(rows,lexicon){
  const lookup=approvedHints(rows,lexicon);
  const hasRegistry=Array.isArray(lexicon?.vehicles)&&lexicon.vehicles.length>0;
  return rows.map((row,i)=>({...row,
    vehicleUnlisted:Boolean(hasRegistry&&String(row.vehicle||'').trim()&&!lookup[i].vehicleKnown)}));
}
