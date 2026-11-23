#!/usr/bin/env node
/** Kalshibot Mission Control: public research plus isolated optional demo testing.
 * Intentionally does not import, initialize, or start any trading agent.
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3333;
const SERIES_TICKER = process.env.SERIES_TICKER || 'KXBTC15M';
const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';
const headers = { 'User-Agent': 'KalshibotReadOnly/1.0', 'Accept': 'application/json' };
let btc = null;
let btcSource = null;
let btcTime = null;
let marketTime = null;
let markets = [];
let errors = { btc: null, kalshi: null };
const priceHistory = [];
const checkpointMonitor = require('./checkpoint-monitor')({axios, io,
  getMarkets:()=>markets, getBTC:()=>({price:btc,source:btcSource,time:btcTime}),
  getSignal:()=>computePaperSignal(),
  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,
  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY});
const officialOutcomes = require('./official-outcomes')({axios,io,
  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,
  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY,
  seriesTicker:SERIES_TICKER});
const performanceAnalytics=require('./performance-analytics')({axios,officialOutcomes,
  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,
  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY});
const researchQuality=require('./research-quality')({axios,officialOutcomes,
  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,
  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY,
  forwardStartUtc:process.env.KALSHIBOT_FORWARD_START_UTC});
const accountViewer=require('./kalshi-account-readonly')({axios});
const demoTrading = require('./demo-trading')({axios,
  getSignal:()=>computePaperSignal(),getMarkets:()=>markets,getSpotTime:()=>btcTime});
let busyBTC = false, busyKalshi = false;
// Experimental spot momentum observations are not trained predictions.
function computePaperSignal() {
  const recent=priceHistory.slice(-20);
  const newest=recent[recent.length-1];
  const active=markets.find(m=>m.secondsUntilClose>0);
  const timeRemaining=active?Math.max(0,Math.floor((active.closeTime-Date.now())/1000)):null;
  const model={spotMovePct:null,shortMovePct:null,volatility:null,timeRemaining,
    trendWarmup:recent.length<8,trend:'UNKNOWN',trendROC:null,observationCount:recent.length};
  const response=(action,reasonCode,message)=>({
    intent:{status:'paper_only',action,reasonCode,modelProbability:null,currentEdge:null,
      message:'PAPER ONLY • '+message},model});
  if (!newest || recent.length<8) return response('NONE','WARMUP',
    'collecting BTC spot observations ('+recent.length+'/8). No trained model.');
  if (!btcTime || Date.now()-Date.parse(btcTime)>60000) return response('NONE','STALE_BTC_PRICE',
    'BTC price feed is stale or unavailable.');
  const changePct=(newest.price/recent[0].price-1)*100;
  const returns=recent.slice(1).map((p,i)=>Math.log(p.price/recent[i].price));
  const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
  const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length);
  const shortMove=(newest.price/recent[recent.length-5].price-1)*100;
  Object.assign(model,{spotMovePct:changePct,shortMovePct:shortMove,volatility:vol,
    trendWarmup:false,trend:changePct>0.03?'BULLISH':changePct< -0.03?'BEARISH':'NEUTRAL',trendROC:changePct});
  if (Math.abs(shortMove)<=0.025) return response('NONE','WEAK_MOMENTUM',
    'short-term move below 0.025% threshold.');
  if (Math.sign(shortMove)!==Math.sign(changePct)) return response('NONE','MOMENTUM_CONFLICT',
    'short-term movement conflicts with longer spot trend.');
  const action=shortMove>0?'UP':'DOWN';
  return response(action,'EXPERIMENTAL_MOMENTUM',
    'experimental '+action+' momentum signal; no calibrated AI confidence or trade recommendation.');
}


// Optional Supabase persistence for public-market paper observations only.
// Keys are server-only Render environment variables; never sent to browsers.
const SUPABASE_URL=(process.env.KALSHIBOT_SUPABASE_URL||'').trim().replace(/\/$/,'');
const SUPABASE_KEY=(process.env.KALSHIBOT_SUPABASE_SERVICE_KEY||'').trim();
const persistence={configured:Boolean(SUPABASE_URL&&SUPABASE_KEY),state:'unconfigured',lastError:null,lastSyncedAt:null};
const pendingWrites=new Map();
let flushing=false;
function dbUrl() {
  const url=new URL(SUPABASE_URL);
  if (url.protocol!=='https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) throw Error('Invalid Supabase project URL');
  return url.origin+'/rest/v1/kalshibot_paper_observations';
}
async function dbRequest(method, suffix, data) {
  return (await axios({method,url:dbUrl()+suffix,data,timeout:10000,headers:{
    apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY,
    'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'}})).data;
}
function persistRow(row) {
  if (!persistence.configured) return;
  pendingWrites.set(row.ticker,{ticker:row.ticker,payload:{...row},updated_at:new Date().toISOString()});
}
async function loadPaperJournal() {
  if (!persistence.configured) return;
  try {
    const records=await dbRequest('GET','?select=ticker,payload&order=updated_at.desc&limit=200');
    for(const item of (Array.isArray(records)?records:[])) {
      const row=item.payload;
      if (!row || typeof row.ticker!=='string' || paperKnown.has(row.ticker)) continue;
      paperKnown.add(row.ticker);paperJournal.push(row);
    }
    persistence.state='ready';persistence.lastError=null;persistence.lastSyncedAt=new Date().toISOString();
    console.log('[PaperJournal] Restored '+paperJournal.length+' rows');
  } catch(err) {
    persistence.state='error';persistence.lastError='Supabase read failed (HTTP '+(err.response?.status||'network')+')';
    console.error('[PaperJournal]',persistence.lastError);
  }
}
async function flushPaperWrites() {
  if (!persistence.configured || flushing || !pendingWrites.size) return;
  flushing=true;
  try {
    for(const [ticker,row] of pendingWrites) {
      try {
        await dbRequest('POST','?on_conflict=ticker',[row]);
        if (pendingWrites.get(ticker)===row) pendingWrites.delete(ticker);
        persistence.state='ready';persistence.lastError=null;persistence.lastSyncedAt=new Date().toISOString();
      } catch(err) {
        persistence.state='error';persistence.lastError='Supabase write failed (HTTP '+(err.response?.status||'network')+')';
        console.error('[PaperJournal]',persistence.lastError);
        break;
      }
    }
  } finally {flushing=false;}
}

// In-memory paper research journal: never creates orders or synthetic trades.
// A sample is recorded at most once per 15-minute ticker, near five minutes to close.
const paperJournal = [];
const paperKnown = new Set();
function updatePaperJournal() {
  if (!btc || !btcTime || Date.now()-Date.parse(btcTime)>60000) return;
  const now = Date.now();
  // Evaluate matured observations using the first observed public spot snapshot
  // at or after close; this is a SPOT PROXY, NOT an official Kalshi settlement.
  for (const row of paperJournal) {
    if (row.proxyStatus !== 'pending' || now < row.closeTime) continue;
    // A restart or free-tier sleep can leave a large gap after market close.
    // Do not label a much later spot price as a close-time proxy.
    if (now - row.closeTime > 60000) {
      row.proxyStatus='missed_close_window';
      row.evaluatedAt=new Date().toISOString();
      persistRow(row);
      continue;
    }
    row.proxyStatus='spot_proxy';
    row.exitSpot=btc;
    row.evaluatedAt=new Date().toISOString();
    row.spotMovePct=100*(btc/row.entrySpot-1);
    row.proxyDirection=btc>row.entrySpot?'UP':btc<row.entrySpot?'DOWN':'FLAT';
    row.proxyCorrect=row.action==='NONE'?null:(row.proxyDirection==='FLAT'?null:row.action===row.proxyDirection);
    persistRow(row);
  }
  const signal=computePaperSignal();
  if (signal.model.trendWarmup) return;
  const candidate=markets.find(m=>m.closeTime>now && m.closeTime-now<=300000 && m.closeTime-now>=60000 && !paperKnown.has(m.ticker));
  if (!candidate) return;
  const row={ticker:candidate.ticker,observedAt:new Date().toISOString(),closeTime:candidate.closeTime,
    action:signal.intent.action,reasonCode:signal.intent.reasonCode,entrySpot:btc,spotSource:btcSource,
    trend:signal.model.trend,spotMovePctAtSignal:signal.model.spotMovePct,
    volatility:signal.model.volatility,proxyStatus:'pending',proxyCorrect:null};
  paperKnown.add(row.ticker);paperJournal.unshift(row);persistRow(row);
  if(paperJournal.length>200) paperJournal.pop();
  io.emit('paper:journal',paperSummary());
}
function paperSummary(){
  const resolved=paperJournal.filter(r=>r.proxyCorrect!==null);
  const correct=resolved.filter(r=>r.proxyCorrect).length;
  return {mode:'paper-observation-only',storage:persistence.state==='ready'?'supabase':persistence.configured?'degraded':'volatile',
    persistence:{...persistence,pendingWrites:pendingWrites.size},source:'public spot; NOT Kalshi settlement',
    recorded:paperJournal.length,directional:paperJournal.filter(r=>r.action!=='NONE').length,
    evaluated:resolved.length,proxyCorrect:correct,
    proxyAccuracyPct:resolved.length?Math.round(1000*correct/resolved.length)/10:null,
    journal:paperJournal.slice(0,50)};
}
app.use('/api/demo', express.json({limit:'2kb'}));
app.get('/api/demo', demoTrading.handler);
app.post('/api/demo', demoTrading.handler);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req,res) => res.json({status:'ok', uptime:process.uptime(),botRunning:false, mode:'research-with-optional-demo',productionTradingEnabled:false,demoConfigured:demoTrading.configured,demoEnabled:demoTrading.enabled,btcUpdatedAt:btcTime,marketsUpdatedAt:marketTime}));
app.get('/api/market-data', (_req,res) => res.json({mode:'read-only',btcPrice:btc,btcSource,btcUpdatedAt:btcTime,markets,marketsUpdatedAt:marketTime,errors,priceHistory}));
app.get('/api/paper-signal', (_req,res)=>res.json({mode:'paper-only',...computePaperSignal()}));
app.get('/api/paper-journal', (_req,res)=>res.json(paperSummary()));
app.get('/api/checkpoints', (_req,res)=>res.json(checkpointMonitor.summary()));
app.get('/api/account-view', accountViewer.handler);
app.get('/api/research-quality', async (_req,res)=>{
  res.json(await researchQuality.performance());
});
app.get('/api/research-performance', async (_req,res)=>{
  const report=await performanceAnalytics.performance();res.json(report);
});
app.get('/api/official-performance', async (_req,res)=>{
  const result=await officialOutcomes.performance();res.json(result);
});
app.get('/api/bot/status', (_req,res) => res.json({running:false, mode:'read-only'}));
app.get('/api/state', (_req,res) => res.json(snapshot()));
app.get('/api/ml', (_req,res) => res.json({trained:false,note:'AI model disabled in read-only mode'}));
app.get('/api/skills', (_req,res) => res.json({skills:[],orchestrator:null,note:'Trading agent disabled'}));
// Fail closed for ALL write operations, including unrecognized routes.
app.use((_req,res,next) => {
  if (!['GET','HEAD','OPTIONS'].includes(_req.method)) return res.status(403).json({status:'disabled',message:'Read-only market viewer: trading and writes are disabled'});
  next();
});

function snapshot() {
  return {
    paperJournal:paperSummary(),
    connections: {binance:!!btc,kalshi:!!marketTime,polymarket:false,redstone:false},
    btcPrice:{binance:btc}, balance:{total:null,available:null},
    activeMarkets:markets,openPositions:[],tradeLog:[],pnlHistory:[],
    intent:computePaperSignal().intent,
    stats:{totalPnL:0,wins:0,losses:0,totalTrades:0},model:computePaperSignal().model,startTime:null,
  };
}
function getNumber(value) { const n=Number(value); return Number.isFinite(n)?n:null; }
async function getBTC() {
  if(busyBTC) return;
  busyBTC=true;
  try {
    let price,source;
    try {
      const resp=await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot',{timeout:8000,headers});
      price=getNumber(resp.data?.data?.amount);source='Coinbase Spot';
      if(!price || price<=0) throw Error('Invalid Coinbase price');
    } catch (primaryError) {
      const resp=await axios.get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD',{timeout:8000,headers});
      const pair=Object.values(resp.data?.result||{})[0];
      price=getNumber(pair?.c?.[0]);source='Kraken Spot';
      if(!price || price<=0) throw Error('Invalid Kraken price; Coinbase failed: '+primaryError.message);
    }
    btc=price;btcSource=source;btcTime=new Date().toISOString();errors.btc=null;
    priceHistory.push({timestamp:Date.now(),price});
    while(priceHistory.length>180) priceHistory.shift();
    io.emit('price:binance',{mid:btc,bid:btc,ask:btc,source});
    io.emit('readonly:btc',{price,source,timestamp:btcTime});
    io.emit('readonly:history',priceHistory);
    io.emit('paper:journal',paperSummary());
    io.emit('connection:binance',true);
    updatePaperJournal();checkpointMonitor.tick();const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
  } catch(err) {
    errors.btc=err.message;io.emit('connection:binance',false);
    console.error('[ReadOnly BTC]',err.message);
  } finally {busyBTC=false;}
}
function centsField(m,name) {
  const inCents=getNumber(m[name]);
  if(inCents!==null) return inCents/100;
  return getNumber(m[name+'_dollars']);
}
async function getKalshi() {
  if(busyKalshi) return;
  busyKalshi=true;
  try {
    const resp=await axios.get(KALSHI_BASE+'/markets',{params:{series_ticker:SERIES_TICKER,status:'open',limit:100},timeout:10000,headers});
    const now=Date.now();
    markets=(resp.data?.markets||[]).filter(m=>m.close_time && Date.parse(m.close_time)>now).map(m=>{
      const closeTime=Date.parse(m.close_time);
      return {ticker:String(m.ticker||''),status:m.status||'open',openTime: m.open_time?Date.parse(m.open_time):null,yesBid:centsField(m,'yes_bid'),yesAsk:centsField(m,'yes_ask'),noBid:centsField(m,'no_bid'),noAsk:centsField(m,'no_ask'),secondsUntilClose:Math.max(0,Math.floor((closeTime-now)/1000)),closeTime};
    }).sort((a,b)=>a.closeTime-b.closeTime).slice(0,25);
    marketTime=new Date().toISOString();errors.kalshi=null;
    io.emit('markets',markets);io.emit('connection:kalshi',true);
    updatePaperJournal();checkpointMonitor.tick();const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
  } catch(err) {
    errors.kalshi=err.response?`HTTP ${err.response.status}: ${err.message}`:err.message;
    io.emit('connection:kalshi',false);
    console.error('[ReadOnly Kalshi]',errors.kalshi);
  } finally {busyKalshi=false;}
}
io.on('connection',socket=>{
  console.log('[Server] UI connected:',socket.id);
  socket.emit('bot:status',{running:false});
  socket.emit('snapshot',snapshot());
  if(btc) socket.emit('readonly:btc',{price:btc,source:btcSource,timestamp:btcTime});
  socket.emit('readonly:history',priceHistory);
  socket.emit('paper:journal',paperSummary());
  socket.emit('checkpoint:summary',checkpointMonitor.summary());
  const paper=computePaperSignal();socket.emit('intent',paper.intent);socket.emit('model',paper.model);
  socket.emit('connection:kalshi',!!marketTime);
});
server.listen(PORT,async()=>{
  console.log(`[ReadOnly] Mission Control on port ${PORT}; NO TRADING ENGINE LOADED`);
  await loadPaperJournal();
  await checkpointMonitor.load();
  await officialOutcomes.load();
  getBTC();getKalshi();
  setInterval(()=>demoTrading.cycle(),15000);
  setInterval(getBTC,15000);
  setInterval(getKalshi,30000);
  officialOutcomes.cycle().catch(err=>console.error('[OfficialOutcomes]',err.message));
  setInterval(()=>officialOutcomes.cycle().catch(err=>console.error('[OfficialOutcomes]',err.message)),60000);
  setInterval(()=>{updatePaperJournal();flushPaperWrites().catch(()=>{});io.emit('paper:journal',paperSummary());},15000);
  setInterval(()=>{checkpointMonitor.tick();checkpointMonitor.flush().catch(()=>{});},15000);
});
