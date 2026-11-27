'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const createMonitor=require('../checkpoint-monitor');
const {quote,compare}=require('../checkpoint-shadow');
const start=Date.parse('2026-11-27T03:00:00Z');
function setup(t,{age=1000,legacy=false}={}) {
  const clock={now:start+180000};t.mock.method(Date,'now',()=>clock.now);
  const market={ticker:'KXBTC15M-TEST',openTime:start,closeTime:start+900000,
    yesBid:.6,yesAsk:.7,noBid:.3,noAsk:.4};
  const writes=[];const stored=legacy?[{ticker:market.ticker,checkpoint_minute:3,payload:{
    ticker:market.ticker,checkpointMinute:3,scheduledAt:new Date(clock.now).toISOString(),
    observedAt:new Date(clock.now).toISOString(),openTime:start,closeTime:market.closeTime,
    action:'UP',proxyStatus:'pending',proxyCorrect:null,entrySpot:100}}]:[];
  const axios=async req=>{if(req.method==='POST')writes.push(...req.data);return {data:stored};};
  const monitor=createMonitor({axios,io:{emit(){}},getMarkets:()=>[market],
    getMarketTime:()=>new Date(clock.now-age).toISOString(),
    getBTC:()=>({price:101,time:new Date(clock.now).toISOString(),source:'test'}),
    getSignal:()=>({intent:{action:'UP',reasonCode:'EXPERIMENTAL_MOMENTUM'},model:{trend:'BULLISH'}}),
    supabaseUrl:'https://example.supabase.co',supabaseKey:'test'});
  return {clock,market,monitor,writes};
}
test('deployed recorder persists a copy of the checkpoint bid/ask snapshot',async t=>{
  const {monitor,market,writes}=setup(t);monitor.tick();market.yesAsk=.9;await monitor.flush();
  const row=writes[0].payload;assert.equal(row.quote.yesAsk,.7);assert.equal(row.quote.noAsk,.4);
  assert.equal(row.quoteCaptureVersion,'3.6.2');assert.equal(row.quoteStatus,'RECORDED');
  assert.equal(monitor.summary().quoteCoverage.recorded,1);
  const report=compare([{ticker:row.ticker,minute:3,action:row.action,captured:true,
    scheduled:Date.parse(row.scheduledAt),observed:Date.parse(row.observedAt),close:row.closeTime,
    quote:row.quote,result:'yes'}],new Date(start).toISOString());
  assert.equal(report.strategies[0].priced,1);assert.equal(report.pricing.withQuote,1);
  assert.ok(Math.abs(report.strategies[0].netUsd-.28)<1e-9);
});
test('persisted checkpoint prices reach the actual research report after official settlement',async t=>{
  const {monitor,clock,writes}=setup(t);monitor.tick();await monitor.flush();
  clock.now=start+960000;
  const axios={get:async()=>({data:writes})};
  const research=require('../research-quality')({axios,
    officialOutcomes:{verifiedForResearch:()=>[{ticker:'KXBTC15M-TEST',result:'yes'}]},
    supabaseUrl:'https://example.supabase.co',supabaseKey:'test',
    forwardStartUtc:new Date(start).toISOString(),shadowStartUtc:new Date(start).toISOString()});
  const result=await research.performance();
  assert.equal(result.status,'ready');assert.equal(result.shadow.strategies[0].priced,1);
  assert.ok(Math.abs(result.shadow.strategies[0].midpointBrier-.1225)<1e-9);
  assert.equal(result.shadow.pricing.firstQuoteAt,new Date(start+180000).toISOString());
});
test('stale, future, crossed or absent quotes stay unpriced',async t=>{
  const {monitor,writes}=setup(t,{age:30001});monitor.tick();await monitor.flush();
  assert.equal(writes[0].payload.quote,null);
  assert.equal(writes[0].payload.quoteStatus,'MISSING_STALE_OR_INVALID');
  const at=new Date(start).toISOString();
  const q={yesBid:.6,yesAsk:.7,noBid:.3,noAsk:.4};
  assert.equal(quote(q,new Date(start+1).toISOString(),start),null);
  assert.equal(quote({...q,yesAsk:.5},at,start),null);
  assert.equal(quote({...q,noBid:null},at,start),null);
});
test('restart preserves legacy checkpoints without inventing missing prices',async t=>{
  const {monitor,writes}=setup(t,{legacy:true});await monitor.load();monitor.tick();await monitor.flush();
  assert.equal(writes.length,0);assert.equal(monitor.summary().journal[0].quote,undefined);
  assert.equal(monitor.summary().quoteCoverage.missing,1);
});
test('a later tick cannot overwrite a captured quote',async t=>{
  const {monitor,market,clock,writes}=setup(t);monitor.tick();await monitor.flush();
  clock.now+=10000;market.yesBid=.8;market.yesAsk=.9;monitor.tick();await monitor.flush();
  assert.equal(writes.length,1);assert.equal(monitor.summary().journal[0].quote.yesAsk,.7);
});
test('missing checkpoint prices remain explicit while directional results stay graded',()=>{
  const report=compare([{ticker:'KXBTC15M-TEST',minute:3,action:'UP',captured:true,
    scheduled:start+180000,observed:start+180000,close:start+900000,result:'yes'}],
    new Date(start).toISOString());
  assert.equal(report.strategies[0].graded,1);assert.equal(report.strategies[0].priced,0);
  assert.equal(report.strategies[0].unpricedGraded,1);assert.equal(report.strategies[0].netUsd,null);
  assert.equal(report.pricing.withoutQuote,1);assert.equal(report.tradingEnabled,false);
});
