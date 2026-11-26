/** Phase 3.5: read-only data-quality and prospective forward-validation research.
 * Reads existing checkpoint data; never places orders, changes predictions, or writes DB rows.
 */
'use strict';
module.exports = function createResearchQuality({axios,officialOutcomes,supabaseUrl,supabaseKey,forwardStartUtc}) {
  const root=String(supabaseUrl||'').trim().replace(/\/+$/,'');
  const key=String(supabaseKey||'').trim();
  const configured=Boolean(root&&key);
  const startString=String(forwardStartUtc||'').trim();
  const forwardStart=startString && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(startString) ? Date.parse(startString):NaN;
  const forwardConfigured=Number.isFinite(forwardStart);
  const MINUTES=[3,5,7,9,11], LIMIT=5000, PAGE=500;
  let cached=null,lastRun=0, inflight=null;
  function endpoint(){
    const u=new URL(root);
    if(u.protocol!=='https:'||!/^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname))throw Error('Invalid Supabase URL');
    return u.origin+'/rest/v1/kalshibot_checkpoint_signals';
  }
  async function readPage(offset){
    const r=await axios.get(endpoint(),{params:{select:'ticker,checkpoint_minute,payload',order:'ticker.asc,checkpoint_minute.asc',limit:PAGE,offset},timeout:12000,headers:{apikey:key,Authorization:'Bearer '+key,Accept:'application/json'}});
    return Array.isArray(r.data)?r.data:[];
  }
  const round=(v)=>Math.round(v*10)/10;
  function wilson(correct,n){if(!n)return {lower:null,upper:null};const z=1.96,p=correct/n,d=1+z*z/n,mid=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return {lower:round(100*(mid-half)),upper:round(100*(mid+half))};}
  function stats(rows){
    const captured=rows.filter(r=>r.captured),directional=captured.filter(r=>r.action==='UP'||r.action==='DOWN');
    const scored=directional.filter(r=>r.result);
    const correct=scored.filter(r=>r.action===(r.result==='yes'?'UP':'DOWN')).length;
    return {recorded:rows.length,captured:captured.length,missed:rows.filter(r=>r.reason==='MISSED_CHECKPOINT').length,
      abstentions:captured.filter(r=>r.action==='NONE').length,directional:directional.length,
      graded:scored.length,correct,incorrect:scored.length-correct,ungraded:directional.length-scored.length,
      accuracyPct:scored.length?round(100*correct/scored.length):null,
      signalRatePct:captured.length?round(100*directional.length/captured.length):null,
      wilson95:wilson(correct,scored.length),distinctGradedMarkets:new Set(scored.map(r=>r.ticker)).size};
  }
  function classify(item,now){
    const p=item&&typeof item.payload==='object'&&item.payload!==null?item.payload:{};
    const ticker=String(item?.ticker||'');const minute=Number(item?.checkpoint_minute);
    const reasons=[];
    if(!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker))reasons.push('BAD_TICKER');
    if(!MINUTES.includes(minute))reasons.push('BAD_MINUTE');
    if(p.ticker!=null&&p.ticker!==ticker)reasons.push('TICKER_MISMATCH');
    if(p.checkpointMinute!=null&&Number(p.checkpointMinute)!==minute)reasons.push('MINUTE_MISMATCH');
    const close=Number(p.closeTime),observed=Date.parse(p.observedAt),scheduled=Date.parse(p.scheduledAt);
    if(!Number.isFinite(close)||close<=0)reasons.push('BAD_CLOSE_TIME');
    const action=String(p.action||'').toUpperCase();
    if(!['UP','DOWN','NONE'].includes(action))reasons.push('BAD_ACTION');
    if(p.observedAt!=null&&(!Number.isFinite(observed)||observed>=close))reasons.push('BAD_OBSERVED_TIME');
    if(p.observedAt==null&&p.reasonCode!=='MISSED_CHECKPOINT')reasons.push('MISSING_OBSERVATION');
    if(p.reasonCode==='MISSED_CHECKPOINT'&&p.observedAt!=null)reasons.push('MISSED_HAS_OBSERVATION');
    // An otherwise valid observation can be unfinished, not invalid.
    const pending=reasons.length===0&&close>now;
    return {ticker,minute,close,observed,scheduled,action,reason:String(p.reasonCode||''),
      captured:reasons.length===0&&p.observedAt!=null&&p.reasonCode!=='MISSED_CHECKPOINT',
      problems:reasons,pending};
  }
  async function calculate(){
    const base={mode:'paper-only',tradingEnabled:false,qualificationActivatesTrading:false,status:'ready',
      forwardStartUtc:forwardConfigured?new Date(forwardStart).toISOString():null,
      forwardConfigured,generatedAt:new Date().toISOString(),rowCap:LIMIT};
    if(!configured)return {...base,status:'unconfigured',error:'Supabase credentials not configured'};
    const raw=[];let truncated=false;
    for(let offset=0;offset<LIMIT;offset+=PAGE){const page=await readPage(offset);raw.push(...page);if(page.length<PAGE)break;if(offset+PAGE>=LIMIT)truncated=true;}
    const verified=new Map(officialOutcomes.verifiedForResearch().map(x=>[x.ticker,x.result]));
    const seen=new Set(),invalid=[],pending=[],valid=[];
    const now=Date.now();
    for(const row of raw){const r=classify(row,now);const id=r.ticker+'|'+r.minute;
      if(seen.has(id))r.problems.push('DUPLICATE_CHECKPOINT');else seen.add(id);
      if(r.problems.length){invalid.push({ticker:r.ticker,minute:r.minute,reasons:r.problems});continue;}
      if(r.pending){pending.push({ticker:r.ticker,minute:r.minute,closeTime:new Date(r.close).toISOString()});continue;}
      r.result=verified.get(r.ticker)||null;
      valid.push(r);
    }
    const reasonCounts={};for(const r of invalid)for(const reason of r.reasons)reasonCounts[reason]=(reasonCounts[reason]||0)+1;
    // The cohort boundary is required and explicit. Never claim old rows are prospective.
    const forward=forwardConfigured?valid.filter(r=>r.captured&&Number.isFinite(r.scheduled)&&r.scheduled>=forwardStart&&r.observed>=forwardStart&&r.close>forwardStart):[];
    const dates=[...new Set(forward.map(r=>new Date(r.close).toISOString().slice(0,10)))].sort().reverse();
    const daily=dates.slice(0,30).map(date=>({date,markets:new Set(forward.filter(r=>new Date(r.close).toISOString().startsWith(date)).map(r=>r.ticker)).size,
      checkpoints:MINUTES.map(minute=>({minute,...stats(forward.filter(r=>r.minute===minute&&new Date(r.close).toISOString().startsWith(date)))}))}));
    const preForward=forwardConfigured?valid.filter(r=>r.close<=forwardStart):[];
    const historicalOnly=MINUTES.map(minute=>({minute,...stats(preForward.filter(r=>r.minute===minute))}));
    const historical=MINUTES.map(minute=>({minute,...stats(valid.filter(r=>r.minute===minute))}));
    const prospective=MINUTES.map(minute=>({minute,...stats(forward.filter(r=>r.minute===minute))}));
    const qualifications=prospective.map(s=>({minute:s.minute,gradedMarkets:s.distinctGradedMarkets,
      minimumGradedMarkets:100,lowerBoundPct:s.wilson95.lower,
      status:!forwardConfigured?'FORWARD_START_NOT_CONFIGURED':s.distinctGradedMarkets<100?'INSUFFICIENT_FORWARD_MARKETS':s.wilson95.lower==null||s.wilson95.lower<=50?'INSUFFICIENT_EVIDENCE':'RESEARCH_THRESHOLD_MET',
      tradingApproved:false}));
    return {...base,allRowsRead:raw.length,validClosedRows:valid.length,pendingMarketRows:pending.length,
      invalidRows:invalid.length,invalidReasonCounts:reasonCounts,invalidExamples:invalid.slice(0,20),
      pendingExamples:pending.slice(0,10),truncatedAtRowCap:truncated,
      historical,historicalOnly,checkpointAudit:{expectedForwardRows:new Set(forward.map(r=>r.ticker)).size*MINUTES.length,absentOrExcludedForwardRows:new Set(forward.map(r=>r.ticker)).size*MINUTES.length-forward.length},forward:{markets:new Set(forward.map(r=>r.ticker)).size,rows:forward.length,checkpoints:prospective},daily,
      qualifications,note:'Forward cohort requires KALSHIBOT_FORWARD_START_UTC fixed before prospective collection. Repeated checkpoint outcomes within one market are correlated. Research-only qualification NEVER enables trading.'};
  }
  function performance(){if(cached&&Date.now()-lastRun<300000)return Promise.resolve(cached);if(inflight)return inflight;
    inflight=calculate().then(r=>{cached=r;lastRun=Date.now();return r;}).catch(e=>({mode:'paper-only',tradingEnabled:false,status:'error',error:'Research quality '+(e.response?.status?'HTTP '+e.response.status:'unavailable')})).finally(()=>{inflight=null;});return inflight;}
  return {performance};
};
