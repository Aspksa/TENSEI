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
  let calls=0,tokens=0,reported=0,photos=0;
  for(const t of tasks||[]){
    if(t.status!=='done')continue;
    photos++;
    calls+=Number(t.cloudCalls)||0;
    if(Number.isFinite(Number(t.usage?.total_tokens))){tokens+=Number(t.usage.total_tokens);reported++}
  }
  return {photos,cloudCalls:calls,reportedPhotos:reported,totalReportedTokens:tokens,
    tokenCoverage:photos?Number((reported/photos).toFixed(3)):null,
    estimatedCostRub:null};
}
