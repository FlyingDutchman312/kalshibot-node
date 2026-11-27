'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createResearchHealth,buildLocal,buildSeven,buildPrecision}=require('../research-health');
const now=Date.parse('2026-11-27T04:00:00Z');
const at=ms=>new Date(now-ms).toISOString();
function local(){return {btcAt:at(1000),marketsAt:at(2000),errors:{},
  checkpoints:{persistence:{status:'ready',pendingWrites:0},stats:[{captured:20,missed:2}],
    journal:[{quoteCaptureVersion:'3.6.2',quote:{yesBid:.5}},{quoteCaptureVersion:'3.6.2',quote:null}],
    quoteCoverage:{missing:19}},
  official:{persistence:{state:'ready',lastCheckedAt:at(1000)},recovery:{remaining:3}}};}
function seven(){return {status:'running',version:'2.4.0',last_poll:at(1000),assets:['BTC','BNB'],
  errors:{BTC:null,BNB:null},persistence:{ok:true,durable:true},orders_enabled:false,
  live_trading_enabled:false,demo_trading_enabled:false};}
function precision(){return {version:'1.4.1',lastPoll:at(1000),markets:{BTC:{status:'WAIT'}},
  kalshiReads:{requests:100,rateLimited:1,deferred:6,cooldownUntil:null,lastSuccessAt:at(1000)},
  researchOnly:true,ordersEnabled:false};}
test('local snapshot distinguishes quote repair counts, missed checkpoints and discovered backlog',()=>{
  const r=buildLocal(local(),now);assert.equal(r.status,'OK');assert.equal(r.missedCheckpoints,2);
  assert.equal(r.newQuoteRecords,1);assert.equal(r.newMissingQuotes,1);
  assert.equal(r.windowMissingQuotes,19);assert.equal(r.pendingDiscoveredSettlements,3);
});
test('stale or future feed times and unavailable storage require review',()=>{
  const data=local();data.btcAt=at(31000);data.marketsAt=at(-1000);
  data.checkpoints.persistence.status='error';
  const r=buildLocal(data,now);assert.equal(r.status,'REVIEW');assert.equal(r.marketAgeSeconds,null);
  assert.ok(r.issues.some(x=>x.includes('persistence')));
});
test('seven-market polling, persistence and explicit disablement are checked',()=>{
  const data=seven();assert.equal(buildSeven(data,now).status,'OK');data.errors.BNB='HTTP 429';
  assert.equal(buildSeven(data,now).status,'REVIEW');delete data.orders_enabled;
  assert.ok(buildSeven(data,now).issues.includes('Order disablement not confirmed'));
});
test('a recovered historical rate limit is not a current failure; active cooldown is visible',()=>{
  const data=precision();assert.equal(buildPrecision(data,now).status,'OK');
  data.kalshiReads.cooldownUntil=at(-20000);assert.equal(buildPrecision(data,now).status,'BACKOFF');
  data.kalshiReads.cooldownUntil=null;data.storageError='Database HTTP 500';
  assert.equal(buildPrecision(data,now).status,'REVIEW');
});
test('malformed source health is never presented as healthy',()=>{
  assert.throws(()=>buildSeven({},now));assert.throws(()=>buildPrecision({},now));
});
test('public checks are coalesced, cached and limited to two fixed GET URLs',async()=>{
  const calls=[];let time=now;
  const svc=createResearchHealth({now:()=>time,getLocalSnapshot:local,
    axios:{get:async(url,options)=>{calls.push({url,options});return {data:url.includes('seven-market')?seven():precision()};}}});
  const [a,b]=await Promise.all([svc.get(),svc.get()]);assert.deepEqual(a,b);assert.equal(calls.length,2);
  assert.equal(a.tradingEnabled,false);assert.equal(a.apps.length,3);
  await svc.get();assert.equal(calls.length,2);
  time+=60001;await svc.get();assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.url.endsWith('/api/health')||c.url.endsWith('/api/status')));
  assert.ok(calls.every(c=>!c.options.headers.Authorization&&!c.options.headers.apikey));
});
test('local freshness is recomputed even while remote checks are cached',async()=>{
  let time=now;const svc=createResearchHealth({now:()=>time,getLocalSnapshot:local,
    axios:{get:async url=>({data:url.includes('seven-market')?seven():precision()})}});
  assert.equal((await svc.get()).apps[0].status,'OK');time+=31000;
  assert.equal((await svc.get()).apps[0].status,'REVIEW');
});
test('failed remote reads return unknown values and cannot echo secrets or arbitrary errors',async()=>{
  const secret='never-include-this-value';
  const svc=createResearchHealth({now:()=>now,getLocalSnapshot:local,axios:{get:async()=>{throw Error(secret);}}});
  const result=await svc.get();assert.equal(result.apps[1].status,'UNAVAILABLE');
  assert.equal(result.apps[1].pendingDiscoveredSettlements,undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
});
