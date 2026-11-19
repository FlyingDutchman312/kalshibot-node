/** Paper-only checkpoint monitor. Reads public prices and public market timestamps.
 * No account credentials, orders, trading endpoints, or artificial backfills.
 */
'use strict';
module.exports = function createCheckpointMonitor({axios,io,getMarkets,getBTC,getSignal,supabaseUrl,supabaseKey}) {
  const minutes=[3,5,7,9,11], rows=new Map(), pending=new Map();
  const state={configured:Boolean(supabaseUrl&&supabaseKey),status:'unconfigured',lastError:null,lastSync:null};
  const limit=500, closeToleranceMs=60000, captureToleranceMs=45000;
  let flushing=false;
  const url=(supabaseUrl||'').trim().replace(/\/$/,'');
  const key=(supabaseKey||'').trim();
  function keyFor(ticker,minute){return ticker+'|'+minute;}
  function dbUrl() {
    const u=new URL(url);
    if(u.protocol!=='https:'||!/^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname)) throw new Error('Invalid Supabase URL');
    return u.origin+'/rest/v1/kalshibot_checkpoint_signals';
  }
  async function request(method,suffix='',data) {
    return (await axios({method,url:dbUrl()+suffix,data,timeout:10000,
      headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',
      Prefer:'resolution=merge-duplicates,return=minimal'}})).data;
  }
  function queue(row){if(state.configured)pending.set(keyFor(row.ticker,row.checkpointMinute),{
    ticker:row.ticker,checkpoint_minute:row.checkpointMinute,payload:{...row},updated_at:new Date().toISOString()});}
  function add(row){const k=keyFor(row.ticker,row.checkpointMinute);if(rows.has(k))return;
    rows.set(k,row);queue(row);if(rows.size>limit){for(const [id,r] of rows){if(r.proxyStatus!=='pending'&&!pending.has(id)){rows.delete(id);break;}}}
  }
  async function load(){if(!state.configured)return;
    try {
      const found=await request('GET','?select=ticker,checkpoint_minute,payload&order=updated_at.desc&limit=500');
      for(const item of Array.isArray(found)?found:[]){if(!item?.payload?.ticker||!minutes.includes(item?.payload?.checkpointMinute))continue;
        rows.set(keyFor(item.payload.ticker,item.payload.checkpointMinute),item.payload);}
      state.status='ready';state.lastError=null;state.lastSync=new Date().toISOString();
      console.log('[Checkpoints] loaded',rows.size,'rows');
    } catch(e){state.status='error';state.lastError='read HTTP '+(e.response?.status||'network');console.error('[Checkpoints]',state.lastError);}
  }
  async function flush(){if(!state.configured||flushing||!pending.size)return;flushing=true;
    try{for(const [id,item] of pending){try{await request('POST','?on_conflict=ticker,checkpoint_minute',[item]);
      if(pending.get(id)===item)pending.delete(id);
      state.status='ready';state.lastError=null;state.lastSync=new Date().toISOString();
    }catch(e){state.status='error';state.lastError='write HTTP '+(e.response?.status||'network');console.error('[Checkpoints]',state.lastError);break;}}}
    finally{flushing=false;}}
  function tick(){const now=Date.now(),btc=getBTC();const fresh=Number.isFinite(btc.price)&&btc.price>0&&btc.time&&
       Math.abs(now-Date.parse(btc.time))<=30000;
    // Evaluate only with a fresh spot snapshot within one minute of actual close.
    for(const row of rows.values()){
      if(row.proxyStatus!=='pending'||now<row.closeTime)continue;
      if(now-row.closeTime>closeToleranceMs||!fresh){
        if(now-row.closeTime<=closeToleranceMs&&!fresh)continue;
        row.proxyStatus='missed_close_window';row.evaluatedAt=new Date(now).toISOString();
      }else{
        row.proxyStatus='spot_proxy';row.exitSpot=btc.price;row.evaluatedAt=new Date(now).toISOString();
        row.proxyDirection=btc.price>row.entrySpot?'UP':btc.price<row.entrySpot?'DOWN':'FLAT';
        row.proxyCorrect=row.action==='NONE'||row.proxyDirection==='FLAT'?null:row.action===row.proxyDirection;
      }
      queue(row);
    }
    for(const market of getMarkets()){
      const start=Number(market.openTime),close=Number(market.closeTime);
      // Only confirmed 15-minute markets qualify; never guess opening from close.
      if(!Number.isFinite(start)||!Number.isFinite(close)||Math.abs((close-start)-900000)>90000||
         start>now||close<=now)continue;
      for(const minute of minutes){const at=start+minute*60000,lag=now-at,id=keyFor(market.ticker,minute);
        if(lag<0||rows.has(id))continue;
        // Record a missed checkpoint when the service notices it late; do not backdate a signal.
        if(lag>captureToleranceMs){add({ticker:market.ticker,checkpointMinute:minute,scheduledAt:new Date(at).toISOString(),
           observedAt:null,openTime:start,closeTime:close,action:'NONE',reasonCode:'MISSED_CHECKPOINT',
           entrySpot:null,proxyStatus:'missed_checkpoint',proxyCorrect:null});continue;}
        const signal=getSignal();const action=fresh?signal.intent.action:'NONE';
        const reasonCode=fresh?signal.intent.reasonCode:'STALE_BTC_PRICE';
        add({ticker:market.ticker,checkpointMinute:minute,scheduledAt:new Date(at).toISOString(),
          observedAt:new Date(now).toISOString(),openTime:start,closeTime:close,action,reasonCode,
          entrySpot:fresh?btc.price:null,spotSource:fresh?btc.source:null,
          trend:signal.model.trend,spotMovePctAtSignal:signal.model.spotMovePct,
          shortMovePctAtSignal:signal.model.shortMovePct,volatility:signal.model.volatility,
          proxyStatus:fresh?'pending':'invalid_price',proxyCorrect:null});
      }
    }
    io.emit('checkpoint:summary',summary());
  }
  function summary(){const all=[...rows.values()].sort((a,b)=>
    (Date.parse(b.scheduledAt)||0)-(Date.parse(a.scheduledAt)||0));
    const stats=minutes.map(minute=>{const subset=all.filter(r=>r.checkpointMinute===minute);
      const captured=subset.filter(r=>r.observedAt);
      const evaluated=captured.filter(r=>r.proxyCorrect!==null);
      const correct=evaluated.filter(r=>r.proxyCorrect===true).length;
      return {minute,recorded:subset.length,captured:captured.length,missed:subset.filter(r=>r.reasonCode==='MISSED_CHECKPOINT').length,
       directional:captured.filter(r=>['UP','DOWN'].includes(r.action)).length,
       abstentions:captured.filter(r=>r.action==='NONE').length,evaluated:evaluated.length,correct,
       proxyAgreementPct:evaluated.length?Math.round(correct/evaluated.length*1000)/10:null};});
    return {mode:'paper-observation-only',storage:state.status==='ready'?'supabase':state.configured?'degraded':'volatile',
      persistence:{...state,pendingWrites:pending.size},source:'public BTC spot proxy; NOT official Kalshi settlement',
      checkpointMinutes:minutes,stats,journal:all.slice(0,100)};
  }
  return {load,flush,tick,summary};
};
