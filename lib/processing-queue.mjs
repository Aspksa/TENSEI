// In-memory single-server scheduler. Tasks persist separately in data/tasks.json.
export class SerialQueue{
  #tail=Promise.resolve();
  #pending=0;
  enqueue(work){
    if(typeof work!=='function')throw new TypeError('Work must be a function');
    this.#pending++;
    const promise=this.#tail.then(work);
    this.#tail=promise.catch(()=>{}).finally(()=>{this.#pending--});
    return promise;
  }
  get pending(){return this.#pending}
}
export function summarizeUsage(tasks){
  let calls=0,tokens=0,reported=0,photos=0,failed=0;
  let promptTokens=0,completionTokens=0;
  for(const t of tasks||[]){
    if(t.status!=='done'&&t.status!=='error')continue;
    if(t.status==='done')photos++;else failed++;
    calls+=Number(t.cloudCalls)||0;
    const value=t.usage?.total_tokens;
    if(value!==undefined&&value!==null&&Number.isFinite(Number(value))){
      tokens+=Number(value);reported++;
    }
    if(Number.isFinite(Number(t.usage?.prompt_tokens))&&t.usage?.prompt_tokens!=null)
      promptTokens+=Number(t.usage.prompt_tokens);
    if(Number.isFinite(Number(t.usage?.completion_tokens))&&t.usage?.completion_tokens!=null)
      completionTokens+=Number(t.usage.completion_tokens);
  }
  const counted=photos+failed;
  return {photos,failedPhotos:failed,cloudCalls:calls,reportedPhotos:reported,
    totalReportedTokens:tokens,promptTokens,completionTokens,
    tokenCoverage:counted?Number((reported/counted).toFixed(3)):null,
    estimatedCostRub:null};
}
