'use strict';
const crypto = require('node:crypto');
const HOST = 'https://external-api.demo.kalshi.co';
const ROOT = '/trade-api/v2';
const ORDER_PATH = '/portfolio/events/orders';
const READ_PATH = /^\/(portfolio\/(balance|orders|fills|positions)|markets\/KXBTC15M-[A-Za-z0-9-]+)$/;

function number(value) {
  if (value === null || value === undefined || value === '') throw Error('Missing numeric value');
  const n = Number(value);
  if (!Number.isFinite(n)) throw Error('Invalid numeric value');
  return n;
}
function quote(m, field) {
  return m[field + '_dollars'] != null ? number(m[field + '_dollars']) : number(m[field]) / 100;
}
function candidate(signal, m, now) {
  if (!['UP', 'DOWN'].includes(signal?.intent?.action) ||
      signal.intent.reasonCode !== 'EXPERIMENTAL_MOMENTUM' || signal.model?.trendWarmup) return null;
  if (!/^KXBTC15M-[A-Za-z0-9-]+$/.test(m.ticker) || !['open','active'].includes(m.status)) return null;
  const remaining = (Date.parse(m.close_time) - now) / 1000;
  if (!(remaining >= 90 && remaining <= 600)) return null;
  const yes = signal.intent.action === 'UP';
  const ask = quote(m, yes ? 'yes_ask' : 'no_ask');
  const bid = quote(m, yes ? 'yes_bid' : 'no_bid');
  if (!(bid > 0 && ask > 0 && ask <= .95 && bid <= ask && ask - bid <= .05)) return null;
  return {ticker:m.ticker, yes, ask, budget:Math.ceil(ask * 100) + 5};
}

module.exports = function createDemo({axios, env = process.env, getSignal, getMarkets, getSpotTime, clock = Date.now}) {
  const db = String(env.KALSHIBOT_SUPABASE_URL || '').replace(/\/$/, '');
  const dbKey = env.KALSHIBOT_SUPABASE_SERVICE_KEY;
  const keyId = env.KALSHI_DEMO_KEY_ID;
  const pem = String(env.KALSHI_DEMO_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const token = String(env.KALSHIBOT_DEMO_CONTROL_TOKEN || '');
  const enabled = env.KALSHIBOT_DEMO_ENABLED === 'true';
  const configured = Boolean(/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(db) && dbKey && keyId && pem && token.length >= 24);
  let working = false, last = 'Not checked', lastAt = null;
  let signingKey;
  const options = {timeout:10000,maxRedirects:0,validateStatus:s=>s>=200&&s<300};
  const dbHeaders = {apikey:dbKey,'Content-Type':'application/json'};
  if (dbKey && !dbKey.startsWith('sb_secret_')) dbHeaders.Authorization='Bearer '+dbKey;

  async function storage(path, data) {
    if (!configured) throw Error('Demo not configured');
    const response = await axios.request({...options,url:db+'/rest/v1/'+path,
      method:data===undefined?'GET':'POST',headers:dbHeaders,data});
    return response.data;
  }
  async function request(method, path, data, params) {
    if (!configured || !(method==='GET' && READ_PATH.test(path) || method==='POST' && path===ORDER_PATH && enabled)) {
      throw Error('Disallowed demo request');
    }
    const stamp=String(clock());
    signingKey ||= crypto.createPrivateKey(pem);
    if (!['rsa','rsa-pss'].includes(signingKey.asymmetricKeyType)) throw Error('RSA key required');
    const signature=crypto.sign('sha256',Buffer.from(stamp+method+ROOT+path),{
      key:signingKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }).toString('base64');
    const response=await axios.request({...options,url:HOST+ROOT+path,method,data,params,headers:{
      'KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':stamp,'KALSHI-ACCESS-SIGNATURE':signature,
      'Content-Type':'application/json'
    }});
    return response.data;
  }
  async function pages(path, collection, params={}) {
    let rows=[],cursor,seen=new Set();
    for(let i=0;i<100;i++){
      const page=await request('GET',path,undefined,{...params,limit:100,...(cursor?{cursor}:{})});
      if(!Array.isArray(page[collection])) throw Error('Invalid account collection');
      rows.push(...page[collection]);
      cursor=page.cursor;
      if(!cursor) return rows;
      if(typeof cursor!=='string'||seen.has(cursor)) throw Error('Invalid account pagination');
      seen.add(cursor);
    }
    throw Error('Account pagination exceeded');
  }
  async function attempts() {
    // Entry admission is capped, but page old history too.
    let rows=[];
    for(let offset=0;offset<100000;offset+=100){
      const page=await storage('kalshibot_demo_attempts?select=*&order=created_at.asc,ticker.asc&limit=100&offset='+offset);
      if(!Array.isArray(page)) throw Error('Invalid journal');
      rows.push(...page);
      if(page.length<100) return rows;
    }
    throw Error('Journal pagination exceeded');
  }
  async function update(row,status,payload) {
    return storage('rpc/kalshibot_demo_update',{p_ticker:row.ticker,p_status:status,p_payload:payload});
  }
  async function reconcile() {
    const rows=await attempts();
    for(const row of rows.filter(r=>!['NO_FILL','SETTLED'].includes(r.status))){
      const orders=await pages('/portfolio/orders','orders',{ticker:row.ticker});
      const matching=orders.filter(o=>o.client_order_id===row.client_order_id);
      if(matching.length!==1) throw Error('Unresolved demo order');
      const order=matching[0];
      if(order.ticker!==row.ticker || row.payload.orderId && order.order_id!==row.payload.orderId) throw Error('Order identity mismatch');
      const fills=await pages('/portfolio/fills','fills',{order_id:order.order_id});
      const ids=new Set();let count=0,cost=0,fees=0;
      for(const f of fills){
        if(f.order_id!==order.order_id || ids.has(f.fill_id) || !f.fill_id) throw Error('Invalid fill identity');
        ids.add(f.fill_id);
        const qty=number(f.count_fp),px=number(row.payload.yes?f.yes_price_dollars:f.no_price_dollars);
        const fee=number(f.fee_cost);
        if(qty<=0||px<=0||px>=1||fee<0) throw Error('Invalid fill values');
        count+=qty;cost+=qty*px;fees+=fee;
      }
      if(Math.abs(count-number(order.fill_count_fp))>1e-8 || count>1) throw Error('Fill mismatch');
      if(!['executed','canceled'].includes(order.status)) throw Error('Order not terminal');
      let status=count===0?'NO_FILL':'SUBMITTED';
      const detail={orderId:order.order_id,filled:count,cost,fees,checkedAt:new Date(clock()).toISOString()};
      if(count){
        const market=(await request('GET','/markets/'+row.ticker)).market;
        if(['finalized','settled'].includes(market?.status)&&['yes','no'].includes(market.result)){
          detail.result=market.result;
          detail.pnl=(market.result===(row.payload.yes?'yes':'no')?count:0)-cost-fees;
          status='SETTLED';
        }
      }
      await update(row,status,detail);
    }
    return attempts();
  }
  async function cycle() {
    if(working || !configured) return;
    working=true;
    try{
      const rows=await reconcile();
      last='Reconciliation passed';lastAt=new Date(clock()).toISOString();
      const control=await storage('kalshibot_demo_control?id=eq.1&select=stopped');
      if(!enabled||control.length!==1||control[0].stopped!==false){last='Demo stopped';return;}
      const decisionAt=clock();
      const signal=getSignal();
      const age=clock()-Date.parse(getSpotTime());
      if(!Number.isFinite(age)||age<0||age>30000) {last='Waiting for fresh BTC signal';return;}
      const reference=getMarkets().find(m=>m.closeTime>clock()+90000&&m.closeTime<=clock()+600000);
      if(!reference||rows.some(r=>r.ticker===reference.ticker)) return;
      const market=(await request('GET','/markets/'+reference.ticker)).market;
      if(!market||Date.parse(market.close_time)!==reference.closeTime) throw Error('Demo market mismatch');
      const pick=candidate(signal,market,clock());
      if(!pick){last='No qualified demo entry';return;}
      const resting=await pages('/portfolio/orders','orders',{status:'resting'});
      if(resting.length) throw Error('Resting demo orders require review');
      const positions=await pages('/portfolio/positions','market_positions');
      const tracked=new Set(rows.filter(r=>r.status==='SUBMITTED').map(r=>r.ticker));
      for(const p of positions){
        if(number(p.position_fp)!==0&&!tracked.has(p.ticker)) throw Error('Untracked demo position');
      }
      const balance=number((await request('GET','/portfolio/balance')).balance);
      if(balance<pick.budget) throw Error('Insufficient demo balance');
      const finalAge=clock()-Date.parse(getSpotTime());
      if(finalAge<0||finalAge>30000||clock()-decisionAt>30000||Date.parse(market.close_time)-clock()<90000) throw Error('Entry data expired');
      const client=crypto.randomUUID();
      const reserved=await storage('rpc/kalshibot_demo_reserve',{
        p_ticker:pick.ticker,p_client:client,p_budget:pick.budget,
        p_payload:{...pick,signal:signal.intent,model:signal.model,observedAt:new Date(clock()).toISOString()}
      });
      if(reserved!==true) return;
      // A reservation survives any crash here. Unknown submissions are never retried.
      const stopped=await storage('kalshibot_demo_control?id=eq.1&select=stopped');
      if(stopped.length!==1||stopped[0].stopped!==false) throw Error('Stopped before submission');
      let result;
      try{
        result=await request('POST',ORDER_PATH,{
          ticker:pick.ticker,client_order_id:client,side:pick.yes?'bid':'ask',
          count:'1.00',price:(pick.yes?pick.ask:1-pick.ask).toFixed(4),
          time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross'
        });
      }catch(e){
        await update({ticker:pick.ticker},'UNKNOWN',{error:'Submission requires reconciliation'});
        throw Error('Submission requires reconciliation');
      }
      const order=result.order||result;
      await update({ticker:pick.ticker},order.order_id?'SUBMITTED':'UNKNOWN',{orderId:order.order_id||null});
      last='Demo order submitted; reconciliation pending';
    }catch(e){last='Blocked: '+(e.response?'HTTP '+e.response.status:String(e.message).slice(0,100));}
    finally{working=false;}
  }
  function authorized(req) {
    const supplied=String(req.headers['x-demo-control-token']||'');
    return configured&&supplied.length<=512&&crypto.timingSafeEqual(
      crypto.createHash('sha256').update(supplied).digest(),crypto.createHash('sha256').update(token).digest());
  }
  async function handler(req,res) {
    res.set('Cache-Control','no-store');
    if(!authorized(req))return res.status(401).json({error:'Demo control token required'});
    try{
      if(req.method==='POST'){
        if(typeof req.body?.stopped!=='boolean') return res.status(400).json({error:'stopped must be boolean'});
        if(!enabled&&!req.body.stopped) throw Error('Set KALSHIBOT_DEMO_ENABLED=true first');
        await storage('rpc/kalshibot_demo_stop',{p_stopped:req.body.stopped});
      }
      return res.json({mode:'demo-only',productionOrders:false,enabled,last,lastAt,working,
        control:await storage('kalshibot_demo_control?id=eq.1&select=stopped'),
        attempts:await attempts(),policy:{contracts:1,orderCapUsd:5,dailyReservedCapUsd:15,dailyAttempts:5}});
    }catch(e){return res.status(503).json({error:'Demo storage or configuration unavailable'});}
  }
  return {cycle,handler,configured,enabled};
};
module.exports.candidate=candidate;
module.exports.HOST=HOST;
