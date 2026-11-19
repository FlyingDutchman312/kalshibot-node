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
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT) || 3333;
const SERIES_TICKER = process.env.SERIES_TICKER || 'KXBTC15M';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const headers = { 'User-Agent': 'KalshibotReadOnly/1.0', 'Accept': 'application/json' };
let btc = null;
let btcSource = null;
let btcTime = null;
let marketTime = null;
let markets = [];
let errors = { btc: null, kalshi: null };
const priceHistory = [];
let busyBTC = false, busyKalshi = false;
// Authentication is ONLY for a browser-initiated private GET. Never broadcast balances.
const ACCOUNT_VIEW_PASSWORD = process.env.ACCOUNT_VIEW_PASSWORD || '';
const KALSHI_API_KEY_ID = process.env.KALSHI_API_KEY_ID || '';
const KALSHI_PRIVATE_KEY_PEM = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const accountConfigured = Boolean(ACCOUNT_VIEW_PASSWORD && KALSHI_API_KEY_ID && KALSHI_PRIVATE_KEY_PEM);
function denyAccount(res, status, message) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({error:message});
}
function passMatches(value) {
  const a=Buffer.from(value || '');const b=Buffer.from(ACCOUNT_VIEW_PASSWORD);
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}
function kalshiGet(pathname) {
  const timestamp=String(Date.now());
  const signature=crypto.sign('sha256', Buffer.from(timestamp+'GET'+pathname), {
    key:KALSHI_PRIVATE_KEY_PEM,
    padding:crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
  return axios.get(KALSHI_BASE+pathname,{timeout:10000,headers:{
    ...headers,'KALSHI-ACCESS-KEY':KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature
  }});
}
// Private API: never exposed via Socket.IO, /api/state, browser assets or logs.
app.get('/api/account',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!accountConfigured) return denyAccount(res,503,'Account view not configured on Render');
  const auth=req.get('authorization')||'';
  if(!auth.startsWith('Basic ')) return denyAccount(res,401,'Viewer password required');
  let parsed='';
  try {parsed=Buffer.from(auth.slice(6),'base64').toString('utf8');} catch {return denyAccount(res,401,'Invalid authentication');}
  const colon=parsed.indexOf(':');
  if(colon<0 || !passMatches(parsed.slice(colon+1))) return denyAccount(res,401,'Invalid viewer password');
  try {
    const [bal, pos]=await Promise.all([
      kalshiGet('/portfolio/balance'),kalshiGet('/portfolio/positions')
    ]);
    const b=bal.data||{};
    const positions=(pos.data?.market_positions||[]).filter(p=>Number(p.position_fp??p.position??0)!==0)
       .slice(0,100).map(p=>({ticker:String(p.ticker||''),position:String(p.position_fp??p.position??'0')}));
    // Kalshi balance and portfolio_value are in cents; portfolio_value is not additive cash.
    return res.json({connected:true,asOf:new Date().toISOString(),cashBalanceUSD:Number(b.balance||0)/100,
      portfolioValueUSD:Number(b.portfolio_value||0)/100,positions});
  } catch(err) {
    const status=err.response?.status;
    return denyAccount(res,502,'Kalshi account read failed'+(status?' (HTTP '+status+')':''));
  }
});

// Experimental spot momentum observations are not trained predictions.
function computePaperSignal() {
  const recent=priceHistory.slice(-20);
  const newest=recent[recent.length-1];
  const active=markets.find(m=>m.secondsUntilClose>0);
  const timeRemaining=active?Math.max(0,Math.floor((active.closeTime-Date.now())/1000)):null;
  const model={spotMovePct:null,volatility:null,timeRemaining,trendWarmup:true,trend:'UNKNOWN',trendROC:null};
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


app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req,res) => res.json({status:'ok', uptime:process.uptime(),botRunning:false, mode:'read-only',btcUpdatedAt:btcTime,marketsUpdatedAt:marketTime}));
app.get('/api/market-data', (_req,res) => res.json({mode:'read-only',btcPrice:btc,btcSource,btcUpdatedAt:btcTime,markets,marketsUpdatedAt:marketTime,errors,priceHistory}));
app.get('/api/paper-signal', (_req,res)=>res.json({mode:'paper-only',...computePaperSignal()}));
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
    io.emit('connection:binance',true);
    const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
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
    const signal=computePaperSignal();io.emit('intent',signal.intent);io.emit('model',signal.model);
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
  const paper=computePaperSignal();socket.emit('intent',paper.intent);socket.emit('model',paper.model);
  socket.emit('connection:kalshi',!!marketTime);
});
server.listen(PORT,()=>{
  console.log(`[ReadOnly] Mission Control on port ${PORT}; NO TRADING ENGINE LOADED`);
  getBTC();getKalshi();
  setInterval(getBTC,15000);
  setInterval(getKalshi,30000);
});
