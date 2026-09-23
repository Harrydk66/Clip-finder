// Keep the durable replay cache/transcript snapshot on the server, not in each poll.
export function publicJob(job) {
  if (!job?.result?.v9) return job;
  const {snapshot,cache,...state} = job.result.v9;
  const {v9History,...result} = job.result;
  return {...job,result:{...result,v9:{...state,
    done:Object.keys(cache || {}).length,total:snapshot?.candidates?.length || 0,
    baselineTop10:snapshot?.baselineTop10 || [],vodUrl:snapshot?.vodUrl || job.vod_url}}};
}
