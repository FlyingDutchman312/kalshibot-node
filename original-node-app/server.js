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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (_req,res) => res.json({status:'ok', uptime:process.uptime(),botRunning:false, mode:'read-only',btcUpdatedAt:btcTime,marketsUpdatedAt:marketTime}));
app.get('/api/market-data', (_req,res) => res.json({mode:'read-only',btcPrice:btc,btcSource,btcUpdatedAt:btcTime,markets,marketsUpdatedAt:marketTime,errors,priceHistory}));
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
    btcPrice:{binance:btc}, balance:{total:0,available:0},
    activeMarkets:markets,openPositions:[],tradeLog:[],pnlHistory:[],
    intent:{status:'read_only',action:'NONE',message:'READ-ONLY MARKET VIEWER — trading disabled'},
    stats:{totalPnL:0,wins:0,losses:0,totalTrades:0},model:{},startTime:null,
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
  socket.emit('connection:kalshi',!!marketTime);
});
server.listen(PORT,()=>{
  console.log(`[ReadOnly] Mission Control on port ${PORT}; NO TRADING ENGINE LOADED`);
  getBTC();getKalshi();
  setInterval(getBTC,15000);
  setInterval(getKalshi,30000);
});
