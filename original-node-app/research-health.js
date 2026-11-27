'use strict';
// Fixed public GET sources only. No credentials, settings or collector writes.
const SOURCES={
  seven:'https://kalshibot-seven-market-research.onrender.com/api/health',
  precision:'https://kalshi-precision-scalper.onrender.com/api/status'
};
function ageSeconds(at,now){const t=Date.parse(at);return Number.isFinite(t)&&t<=now?(now-t)/1000:null;}
function buildLocal(snapshot,now){
  const {btcAt,marketsAt,errors={},checkpoints={},official={}}=snapshot;
  const btcAge=ageSeconds(btcAt,now),marketAge=ageSeconds(marketsAt,now);
  const quotes=(checkpoints.journal||[]).filter(r=>r.quoteCaptureVersion==='3.6.2');
  const checkpointPersistence=checkpoints.persistence||{},settlementPersistence=official.persistence||{};
  const issues=[];
  if(btcAge===null||btcAge>30)issues.push('BTC spot missing or older than 30s');
  if(marketAge===null||marketAge>30)issues.push('Kalshi market snapshot missing or older than 30s');
  if(errors.btc)issues.push('BTC spot provider error');
  if(errors.kalshi)issues.push('Kalshi provider error');
  if(checkpointPersistence.status!=='ready')issues.push('Checkpoint persistence not ready');
  if(settlementPersistence.state!=='ready')issues.push('Settlement persistence not ready');
  return {app:'Original BTC bot',status:issues.length?'REVIEW':'OK',issues,
    btcAgeSeconds:btcAge,marketAgeSeconds:marketAge,
    pendingWrites:checkpointPersistence.pendingWrites??null,
    recordedCheckpoints:(checkpoints.stats||[]).reduce((n,s)=>n+(s.captured||0),0),
    missedCheckpoints:(checkpoints.stats||[]).reduce((n,s)=>n+(s.missed||0),0),
    newQuoteRecords:quotes.filter(r=>r.quote).length,
    newMissingQuotes:quotes.filter(r=>!r.quote).length,
    windowMissingQuotes:checkpoints.quoteCoverage?.missing??null,
    pendingDiscoveredSettlements:official.recovery?.remaining??null,
    lastSettlementCheckAt:settlementPersistence.lastCheckedAt||null,
    scope:'Checkpoint totals cover the in-memory window (normally 500 rows); quote repair counts cover the latest 100 journal rows. Settlement backlog covers discovered contracts only.'};
}
function buildSeven(data,now){
  if(data?.status!=='running'||!data.errors||!data.persistence)throw Error('Invalid seven-market health response');
  const age=ageSeconds(data.last_poll,now),issues=[];
  if(age===null||age>60)issues.push('Last completed poll missing or older than 60s');
  const failed=Object.keys(data.errors).filter(k=>data.errors[k]);
  if(failed.length)issues.push('Provider errors: '+failed.join(', '));
  if(data.persistence.ok!==true||data.persistence.durable!==true)issues.push('Durable persistence not confirmed');
  if(data.orders_enabled!==false||data.live_trading_enabled!==false||data.demo_trading_enabled!==false)
    issues.push('Order disablement not confirmed');
  return {app:'Seven-market research',version:data.version||null,status:issues.length?'REVIEW':'OK',issues,
    pollAgeSeconds:age,assets:(data.assets||[]).filter(x=>typeof x==='string'),
    durable:data.persistence.durable===true,
    scope:'Public health endpoint does not expose checkpoint gaps or settlement backlog; those remain unknown here.'};
}
function buildPrecision(data,now){
  if(typeof data?.version!=='string'||!data.markets||!data.kalshiReads)throw Error('Invalid precision health response');
  const age=ageSeconds(data.lastPoll,now),issues=[];
  const failed=Object.keys(data.markets).filter(k=>data.markets[k]?.status==='ERROR');
  if(age===null||age>30)issues.push('Last completed poll missing or older than 30s');
  if(failed.length)issues.push('Market reads unavailable: '+failed.join(', '));
  if(data.storageError)issues.push('Observation storage error');
  if(data.settlementError)issues.push('Settlement recovery error');
  if(data.probabilityError)issues.push('Probability journal error');
  if(data.strategies?.readError||data.strategies?.writeError)issues.push('Strategy journal error');
  if(data.ordersEnabled!==false||data.researchOnly!==true)issues.push('Research-only disablement not confirmed');
  const cooldown=Date.parse(data.kalshiReads.cooldownUntil);
  const backingOff=Number.isFinite(cooldown)&&cooldown>now;
  return {app:'Precision Scalper',version:data.version,status:backingOff?'BACKOFF':issues.length?'REVIEW':'OK',issues,
    pollAgeSeconds:age,kalshiRequests:data.kalshiReads.requests??null,
    rateLimitsSinceRestart:data.kalshiReads.rateLimited??null,
    deferredReads:data.kalshiReads.deferred??null,
    cooldownUntil:backingOff?data.kalshiReads.cooldownUntil:null,
    lastSuccessfulReadAt:data.kalshiReads.lastSuccessAt||null,
    lastSettlementCheckAt:data.settlement?.lastCheckedAt||null,
    settledLastPass:data.settlement?.settled??null,
    scope:'429 counts are since restart. A recovered historical 429 does not mean the feed is currently down. This endpoint does not expose the full pending settlement count.'};
}
function createResearchHealth({axios,getLocalSnapshot,now=Date.now,ttlMs=60000}){
  let cached=null,expires=0,inflight=null;
  async function refresh(){
    const checks=await Promise.all(Object.entries(SOURCES).map(async([name,url])=>{
      try{
        const response=await axios.get(url,{timeout:8000,maxContentLength:4*1024*1024,
          headers:{Accept:'application/json','Accept-Encoding':'gzip','User-Agent':'KalshibotResearchHealth/1.0'}});
        return name==='seven'?buildSeven(response.data,now()):buildPrecision(response.data,now());
      }catch(e){return {app:name==='seven'?'Seven-market research':'Precision Scalper',status:'UNAVAILABLE',
        issues:['Public health read unavailable'],httpStatus:e.response?.status||null};}
    }));
    const report={version:'1.0',generatedAt:new Date(now()).toISOString(),cacheSeconds:ttlMs/1000,
      mode:'read-only-research-health',tradingEnabled:false,
      apps:[buildLocal(getLocalSnapshot(),now()),...checks],
      note:'No forecasting, settlement recovery, model promotion, or orders are triggered by this report. Unknown counts are not zero.'};
    cached=report;expires=now()+ttlMs;return report;
  }
  function get(){
    if(cached&&now()<expires)return Promise.resolve({...cached,apps:[buildLocal(getLocalSnapshot(),now()),...cached.apps.slice(1)]});
    if(inflight)return inflight;
    inflight=refresh().finally(()=>{inflight=null;});return inflight;
  }
  return {get};
}
module.exports={createResearchHealth,buildLocal,buildSeven,buildPrecision,ageSeconds};
