/** Phase 3.4 research analytics: read-only Supabase plus verified public settlements.
 * No trade initiation, credentials for brokerage, orders, or execution.
 */
'use strict';
module.exports = function createPerformanceAnalytics({axios,officialOutcomes,supabaseUrl,supabaseKey}) {
  const base=(supabaseUrl||'').trim().replace(/\/+$/,'');
  const key=(supabaseKey||'').trim();
  const configured=Boolean(base&&key);
  const MINUTES=[3,5,7,9,11], WINDOWS=[25,50,100,250];
  const MAX_ROWS=5000, PAGE=500;
  let cache=null, cacheAt=0, inflight=null;
  function endpoint(){
    const u=new URL(base);
    if(u.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname))throw Error('Invalid Supabase project URL');
    return u.origin+'/rest/v1/kalshibot_checkpoint_signals';
  }
  async function readPage(offset){
    const url=endpoint();
    const response=await axios.get(url,{params:{select:'ticker,checkpoint_minute,payload',order:'ticker.asc,checkpoint_minute.asc',limit:PAGE,offset},timeout:12000,headers:{apikey:key,Authorization:'Bearer '+key,Accept:'application/json'}});
    return Array.isArray(response.data)?response.data:[];
  }
  function wilson(success,total){
    if(!total)return {lower:null,upper:null};
    const z=1.96,p=success/total,d=1+z*z/total;
    const center=(p+z*z/(2*total))/d;
    const half=z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)/d;
    return {lower:Math.round(1000*(center-half))/10,upper:Math.round(1000*(center+half))/10};
  }
  function pct(a,b){return b?Math.round(a/b*1000)/10:null;}
  function distinct(rows){return new Set(rows.map(r=>r.ticker)).size;}
  function rowStats(rows){
    const directional=rows.filter(x=>x.captured&&['UP','DOWN'].includes(x.action));
    const scored=directional.filter(x=>x.officialResult);
    const correct=scored.filter(x=>x.action===(x.officialResult==='yes'?'UP':'DOWN')).length;
    const ci=wilson(correct,scored.length);
    return {recorded:rows.length,captured:rows.filter(x=>x.captured).length,
      missed:rows.filter(x=>x.reasonCode==='MISSED_CHECKPOINT').length,
      abstentions:rows.filter(x=>x.captured&&x.action==='NONE').length,
      directional:directional.length,graded:scored.length,correct,incorrect:scored.length-correct,
      ungraded:directional.length-scored.length,accuracyPct:pct(correct,scored.length),
      coveragePct:pct(scored.length,directional.length),abstentionPct:pct(rows.filter(x=>x.captured&&x.action==='NONE').length,rows.filter(x=>x.captured).length),
      wilson95:ci,distinctGradedMarkets:distinct(scored)};
  }
  async function calculate(){
    if(!configured)return {mode:'paper-only',status:'unconfigured',error:'Supabase variables missing',windows:[]};
    let raw=[],truncated=false;
    for(let offset=0;offset<MAX_ROWS;offset+=PAGE){
      const page=await readPage(offset);raw.push(...page);
      if(page.length<PAGE)break;
      if(offset+PAGE>=MAX_ROWS)truncated=true;
    }
    // Contract mapping is verified by the existing official public market checker.
    // Its in-memory whitelist fails closed after a restart until mapping checks complete.
    const verified=new Map(officialOutcomes.verifiedForResearch().map(o=>[o.ticker,o.result]));
    const byId=new Map();
    const now=Date.now();
    for(const item of raw){
      const p=item.payload||{};
      const ticker=String(item.ticker||'');
      const minute=Number(item.checkpoint_minute);
      const close=Number(p.closeTime);
      const at=Date.parse(p.observedAt);
      if(!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker)||!MINUTES.includes(minute)||!Number.isFinite(close)||close>now||close<=0)continue;
      const captured=Boolean(p.observedAt && Number.isFinite(at) && at<close && p.reasonCode!=='MISSED_CHECKPOINT');
      const action=String(p.action||'NONE').toUpperCase();
      const record={ticker,minute,close,action,captured,reasonCode:p.reasonCode||null,
        officialResult:verified.get(ticker)||null};
      // Deduplicate independent of database constraints; never count one checkpoint twice.
      const id=ticker+'|'+minute;
      if(!byId.has(id))byId.set(id,record);
    }
    const all=[...byId.values()];
    const sortedMarkets=[...new Set(all.map(x=>x.ticker))].map(ticker=>({ticker,close:Math.max(...all.filter(x=>x.ticker===ticker).map(x=>x.close))})).sort((a,b)=>b.close-a.close);
    const resultWindows=WINDOWS.map(windowSize=>{
      const marketSet=new Set(sortedMarkets.slice(0,windowSize).map(x=>x.ticker));
      const selected=all.filter(x=>marketSet.has(x.ticker));
      return {marketsInWindow:marketSet.size,windowSize,checkpoints:MINUTES.map(minute=>({minute,...rowStats(selected.filter(x=>x.minute===minute))}))};
    });
    const overall=MINUTES.map(minute=>({minute,...rowStats(all.filter(x=>x.minute===minute))}));
    const qualifications=overall.map(x=>{
      const enough=x.distinctGradedMarkets>=100;
      const lower=x.wilson95.lower;
      const strong=enough&&lower!==null&&lower>50;
      return {minute:x.minute,gradedMarkets:x.distinctGradedMarkets,
        minimumGradedMarkets:100,lowerBoundPct:lower,
        status:!enough?'INSUFFICIENT_MARKETS':!strong?'INSUFFICIENT_EVIDENCE':'RESEARCH_THRESHOLD_MET',
        tradingApproved:false,
        note:strong?'Research-only screening threshold met; prospective holdout and realistic cost tests still required.':'Research sample insufficient to approve a strategy.'};
    });
    return {mode:'paper-only',tradingEnabled:false,status:'ready',generatedAt:new Date().toISOString(),
      checkpointMinutes:MINUTES,allRowsRead:raw.length,validCheckpointRows:all.length,
      storedMarkets:sortedMarkets.length,validatedSettlementMarkets:verified.size,
      truncatedAtRowCap:truncated,rowsCap:MAX_ROWS,windows:resultWindows,overall,qualifications,
      note:'Descriptive market-level research only. Wilson intervals are descriptive and do not establish a profitable or out-of-sample strategy. Checkpoints on the same market are correlated. NO order execution.'};
  }
  async function performance(){
    if(cache&&Date.now()-cacheAt<300000)return cache;
    if(inflight)return inflight;
    inflight=calculate().then(result=>{cache=result;cacheAt=Date.now();return result;}).catch(e=>({mode:'paper-only',tradingEnabled:false,status:'error',error:'Phase 3.4 analytics '+(e.response?.status?'HTTP '+e.response.status:'unavailable'),windows:[]})).finally(()=>{inflight=null;});
    return inflight;
  }
  return {performance};
};
