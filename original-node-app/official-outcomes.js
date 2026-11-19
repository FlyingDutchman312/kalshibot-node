/** Phase 3.3: PUBLIC read-only Kalshi settlement verification; NO orders/account access. */
'use strict';
module.exports = function createOfficialOutcomes({axios,io,supabaseUrl,supabaseKey,seriesTicker='KXBTC15M'}) {
  const root=(supabaseUrl||'').trim().replace(/\/+$/,'');
  const secret=(supabaseKey||'').trim();
  const configured=Boolean(root&&secret);
  const BASE='https://external-api.kalshi.com/trade-api/v2';
  const status={configured,state:configured?'starting':'unconfigured',lastError:null,lastSyncedAt:null,lastCheckedAt:null};
  const outcomes=new Map(), lastAttempt=new Map();
  let running=false, lastCheckpointCount=0;
  const MAX_CHECKPOINTS=500, MAX_MARKETS_PER_PASS=12, RETRY_MS=5*60*1000;
  function apiBase(){const u=new URL(root);if(u.protocol!=='https:'||!/^[a-z0-9-]+\.supabase\.co$/i.test(u.hostname))throw Error('Invalid Supabase URL');return u.origin+'/rest/v1/';}
  async function db(method,table,suffix='',data){return (await axios({method,url:apiBase()+table+suffix,data,timeout:12000,headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'}})).data;}
  function pct(n,d){return d?Math.round(1000*n/d)/10:null;}
  function isSafeTicker(t){return typeof t==='string'&&t.startsWith(seriesTicker+'-')&&/^[A-Z0-9-]{5,100}$/.test(t);}
  // Only score a settlement when the market description clearly establishes YES = BTC UP.
  // Ambiguous markets remain ungraded, even if Kalshi supplied a result.
  function safeMapping(m){
    if(!isSafeTicker(m?.ticker))return false;
    const desc=[m.title,m.yes_sub_title,m.rules_primary].filter(x=>typeof x==='string').join(' ').toLowerCase();
    const btc=/\b(bitcoin|btc)\b/.test(desc);
    const upward=/\b(up|higher|increase|rises?|above|greater than)\b/.test(desc);
    const reversed=/\b(down|lower|decrease|falls?|below|less than)\b/.test(String(m.title||'').toLowerCase());
    return btc&&upward&&!reversed;
  }
  function normal(m){
    const result=String(m?.result||'').toLowerCase();
    const settled=String(m?.status||'').toLowerCase()==='settled';
    const valid=settled&&['yes','no'].includes(result);
    return {ticker:String(m?.ticker||''),market_status:String(m?.status||''),result:valid?result:null,
      settlement_time:m?.settlement_ts||null,source:'kalshi_public_api',
      verified_at:valid?new Date().toISOString():null,updated_at:new Date().toISOString(),
      mappingVerified:valid&&safeMapping(m),title:String(m?.title||'')};
  }
  async function getMarket(ticker){
    const url=BASE+'/markets/'+encodeURIComponent(ticker);
    try{return (await axios.get(url,{timeout:10000,headers:{'User-Agent':'KalshibotResearchReadOnly/1.0','Accept':'application/json'}})).data?.market;}
    catch(e){if(e.response?.status!==404)throw e;}
    // Markets older than the public/historical cutoff may be available via historical list.
    const resp=await axios.get(BASE+'/historical/markets',{params:{tickers:ticker,limit:10},timeout:10000,headers:{'User-Agent':'KalshibotResearchReadOnly/1.0'}});
    return (resp.data?.markets||[]).find(m=>m.ticker===ticker)||null;
  }
  async function load(){if(!configured)return;
    try{const records=await db('GET','kalshibot_official_outcomes','?select=*&order=updated_at.desc&limit=1000');
      for(const r of Array.isArray(records)?records:[])if(isSafeTicker(r.ticker))outcomes.set(r.ticker,{...r,mappingVerified:null});
      status.state='ready';status.lastError=null;status.lastSyncedAt=new Date().toISOString();
      console.log('[OfficialOutcomes] restored',outcomes.size,'outcomes');
    }catch(e){status.state='error';status.lastError='Supabase outcomes read HTTP '+(e.response?.status||'network');console.error('[OfficialOutcomes]',status.lastError);}}
  async function collect(){if(!configured||running)return;running=true;
    try{
      // Research only: read checkpoint rows, not orders, positions, or credentials.
      const data=await db('GET','kalshibot_checkpoint_signals',`?select=ticker,checkpoint_minute,payload&order=updated_at.desc&limit=${MAX_CHECKPOINTS}`);
      const checkpoints=Array.isArray(data)?data:[];lastCheckpointCount=checkpoints.length;
      const now=Date.now(), tickers=new Map();
      for(const x of checkpoints){const row=x.payload||{};
        if(!isSafeTicker(x.ticker)||!Number.isFinite(Number(row.closeTime))||Number(row.closeTime)>now-60000)continue;
        if(!tickers.has(x.ticker))tickers.set(x.ticker,Number(row.closeTime));}
      const next=[...tickers].filter(([ticker])=>{
        const old=outcomes.get(ticker);return (!old||!['yes','no'].includes(String(old.result).toLowerCase()))&&now-(lastAttempt.get(ticker)||0)>RETRY_MS;
      }).sort((a,b)=>b[1]-a[1]).slice(0,MAX_MARKETS_PER_PASS);
      for(const [ticker] of next){lastAttempt.set(ticker,Date.now());try{
        const m=await getMarket(ticker);if(!m)continue;
        const o=normal(m);
        if(!o.result)continue; // never invent settlement, never count closed-only
        const dbRow={ticker:o.ticker,market_status:o.market_status,result:o.result,settlement_time:o.settlement_time,
          source:o.source,verified_at:o.verified_at,updated_at:o.updated_at};
        await db('POST','kalshibot_official_outcomes','?on_conflict=ticker',[dbRow]);
        outcomes.set(ticker,{...dbRow,mappingVerified:o.mappingVerified,title:o.title});
      }catch(e){status.lastError='Kalshi/DB lookup for a market failed (HTTP '+(e.response?.status||'network')+')';console.error('[OfficialOutcomes]',ticker,status.lastError);}}
      // Refresh rows to remain compatible with other services that may write settlements.
      const stored=await db('GET','kalshibot_official_outcomes','?select=*&order=updated_at.desc&limit=1000');
      for(const r of Array.isArray(stored)?stored:[]){
        const prev=outcomes.get(r.ticker);
        if(isSafeTicker(r.ticker))outcomes.set(r.ticker,{...r,mappingVerified:prev?.mappingVerified??null,title:prev?.title||''});}
      status.state='ready';status.lastSyncedAt=new Date().toISOString();
    }catch(e){status.state='error';status.lastError='Phase 3.3 collection HTTP '+(e.response?.status||'network');console.error('[OfficialOutcomes]',status.lastError);}
    finally{status.lastCheckedAt=new Date().toISOString();running=false;io.emit('official:summary',summary());}
  }
  // Do not consider an outcome without confirmed semantics verifiable for a directional score.
  // Mapping flags are process-local and reverified on restart by checking the market again.
  async function verifyMappings(){if(running)return;const unknown=[...outcomes.values()].filter(x=>x.result&&x.mappingVerified==null).slice(0,12);
    for(const item of unknown){try{const m=await getMarket(item.ticker);if(m)item.mappingVerified=safeMapping(m);
    }catch(_e){/* Remains unverified; do not score */}}
  }
  async function cycle(){await collect();await verifyMappings();io.emit('official:summary',summary());}
  function summary(){const checkpointRecords=[];
    // Comparison snapshot is assembled in /api/official-performance by loadable async DB call.
    const verified=[...outcomes.values()].filter(x=>['yes','no'].includes(String(x.result).toLowerCase()));
    return {mode:'paper-only',storage:status.state==='ready'?'supabase':configured?'degraded':'unconfigured',
      persistence:{...status},verifiedMarkets:verified.length,mappingValidated:verified.filter(x=>x.mappingVerified===true).length,
      mappingUnverified:verified.filter(x=>x.mappingVerified!==true).length,checkpointRowsSeen:lastCheckpointCount,
      recent:verified.slice(-20).reverse().map(x=>({ticker:x.ticker,result:x.result,mappingVerified:x.mappingVerified===true,verifiedAt:x.verified_at})),checkpointRecords};}
  async function performance(){const base=summary();if(!configured)return {...base,stats:[],note:'Supabase not configured'};
    try{const records=await db('GET','kalshibot_checkpoint_signals',`?select=ticker,checkpoint_minute,payload&order=updated_at.desc&limit=${MAX_CHECKPOINTS}`);
      const all=Array.isArray(records)?records:[];
      const stats=[3,5,7,9,11].map(minute=>{
        const relevant=all.filter(x=>x.checkpoint_minute===minute).map(x=>({ticker:x.ticker,...x.payload}));
        const directional=relevant.filter(x=>x.observedAt&&['UP','DOWN'].includes(x.action));
        const graded=directional.filter(x=>{const o=outcomes.get(x.ticker);return o?.mappingVerified===true&&['yes','no'].includes(o.result);});
        const correct=graded.filter(x=>x.action===(outcomes.get(x.ticker).result==='yes'?'UP':'DOWN')).length;
        return {minute,recorded:relevant.length,captured:relevant.filter(x=>x.observedAt).length,
          missed:relevant.filter(x=>x.reasonCode==='MISSED_CHECKPOINT').length,
          abstentions:relevant.filter(x=>x.observedAt&&x.action==='NONE').length,directional:directional.length,
          officiallyGraded:graded.length,correct,incorrect:graded.length-correct,
          officialAccuracyPct:pct(correct,graded.length),ungraded:directional.length-graded.length};});
      return {...base,stats,uniqueMarkets:new Set(all.map(x=>x.ticker)).size,source:'Kalshi finalized YES/NO; only verified YES=UP semantics',
        note:'Experimental paper-only observations. Checkpoints in the same market are correlated. No P&L or calibrated probability.'};
    }catch(e){return {...base,stats:[],error:'Performance read HTTP '+(e.response?.status||'network')};}
  }
  return {load,cycle,summary,performance};
};
