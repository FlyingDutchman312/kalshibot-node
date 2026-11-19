#!/usr/bin/env node
/** Kalshibot Mission Control: hard read-only public market viewer.
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
let busyBTC = false, busyKalshi = false;
// Experimental spot momentum observations are not trained predictions.
function computePaperSignal() {
  const recent=priceHistory.slice(-20);
  const newest=recent[recent.length-1];
  const active=markets.find(m=>m.secondsUntilClose>0);
  const timeRemaining=active?Math.max(0,Math.floor((active.closeTime-Date.now())/1000)):null;
  const model={spotMovePct:null,volatility:null,timeRemaining,trendWarmup:true,trend:'UNKNOWN',trendROC:null,observationCount:recent.length};
  if(recent.length<8 || !newest || !btcTime || Date.now()-Date.parse(btcTime)>60000) {
    return {intent:{status:'paper_only',action:'NONE',message:'PAPER ONLY • gathering BTC price observations (minimum 8). No trained model.'},model};
  }
  const first=recent[0];
  const changePct=((newest.price/first.price)-1)*100;
  const returns=recent.slice(1).map((p,i)=>Math.log(p.price/recent[i].price));
  const mean=returns.reduce((a,b)=>a+b,0)/returns.length;
  const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/returns.length);
  const shortMove=recent.length>=5?(newest.price/recent[recent.length-5].price-1)*100:changePct;
  model.spotMovePct=changePct;model.volatility=vol;
  model.trendWarmup=false;model.trend=changePct>0.03?'BULLISH':changePct< -0.03?'BEARISH':'NEUTRAL';model.trendROC=changePct;
  const action=(Math.abs(shortMove)>0.025 && Math.sign(shortMove)===Math.sign(changePct))?(shortMove>0?'UP':'DOWN'):'NONE';
  return {intent:{status:'paper_only',action,modelProbability:null,currentEdge:null,
     message:action==='NONE'?'PAPER ONLY • no directional momentum setup. Confidence not calibrated.':
       'PAPER ONLY • experimental '+action+' spot momentum; NOT an AI probability or trade recommendation.'},model};
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
    row.proxyStatus='spot_proxy';
    row.exitSpot=btc;
    row.evaluatedAt=new Date().toISOString();
    row.spotMovePct=100*(btc/row.entrySpot-1);
    row.proxyDirection=btc>row.entrySpot?'UP':btc<row.entrySpot?'DOWN':'FLAT';
    row.proxyCorrect=row.action==='NONE'?null:(row.proxyDirection==='FLAT'?null:row.action===row.proxyDirection);
  }
  const signal=computePaperSignal();
  if (signal.model.trendWarmup) return;
  const candidate=markets.find(m=>m.closeTime>now && m.closeTime-now<=300000 && m.closeTime-now>=60000 && !paperKnown.has(m.ticker));
  if (!candidate) return;
  const row={ticker:candidate.ticker,observedAt:new Date().toISOString(),closeTime:candidate.closeTime,
    action:signal.intent.action,entrySpot:btc,spotSource:btcSource,
    trend:signal.model.trend,spotMovePctAtSignal:signal.model.spotMovePct,
    volatility:signal.model.volatility,proxyStatus:'pending',proxyCorrect:null};
  paperKnown.add(row.ticker);paperJournal.unshift(row);
  if(paperJournal.length>200) paperJournal.pop();
  io.emit('paper:journal',paperSummary());
}
function paperSummary(){
  const resolved=paperJournal.filter(r=>r.proxyCorrect!==null);
  const correct=resolved.filter(r=>r.proxyCorrect).length;
  return {mode:'paper-observation-only',storage:'volatile',source:'public spot; NOT Kalshi settlement',
    recorded:paperJournal.length,directional:paperJournal.filter(r=>r.action!=='NONE').length,
    evaluated:resolved.length,proxyCorrect:correct,
    proxyAccuracyPct:resolved.length?Math.round(1000*correct/resolved.length)/10:null,
    journal:paperJournal.slice(0,50)};
}
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req,res) => res.json({status:'ok', uptime:process.uptime(),botRunning:false, mode:'read-only',btcUpdatedAt:btcTime,marketsUpdatedAt:marketTime}));
app.get('/api/market-data', (_req,res) => res.json({mode:'read-only',btcPrice:btc,btcSource,btcUpdatedAt:btcTime,markets,marketsUpdatedAt:marketTime,errors,priceHistory}));
app.get('/api/paper-signal', (_req,res)=>res.json({mode:'paper-only',...computePaperSignal()}));
app.get('/api/paper-journal', (_req,res)=>res.json(paperSummary()));
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
    updatePaperJournal();const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
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
      return {ticker:String(m.ticker||''),status:m.status||'open',yesBid:centsField(m,'yes_bid'),yesAsk:centsField(m,'yes_ask'),noBid:centsField(m,'no_bid'),noAsk:centsField(m,'no_ask'),secondsUntilClose:Math.max(0,Math.floor((closeTime-now)/1000)),closeTime};
    }).sort((a,b)=>a.closeTime-b.closeTime).slice(0,25);
    marketTime=new Date().toISOString();errors.kalshi=null;
    io.emit('markets',markets);io.emit('connection:kalshi',true);
    updatePaperJournal();const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
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
  const paper=computePaperSignal();socket.emit('intent',paper.intent);socket.emit('model',paper.model);
  socket.emit('connection:kalshi',!!marketTime);
});
server.listen(PORT,()=>{
  console.log(`[ReadOnly] Mission Control on port ${PORT}; NO TRADING ENGINE LOADED`);
  getBTC();getKalshi();
  setInterval(getBTC,15000);
  setInterval(getKalshi,30000);
  setInterval(()=>{updatePaperJournal();io.emit('paper:journal',paperSummary());},15000);
});
