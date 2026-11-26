/** Phase 3.3: PUBLIC read-only Kalshi settlement verification; NO orders/account access. */
'use strict';
module.exports = function createOfficialOutcomes({axios,io,supabaseUrl,supabaseKey,seriesTicker='KXBTC15M'}) {
  const root=(supabaseUrl||'').trim().replace(/\/+$/,'');
  const secret=(supabaseKey||'').trim();
  const configured=Boolean(root&&secret);
  const BASE='https://external-api.kalshi.com/trade-api/v2';
  const status={configured,state:configured?'starting':'unconfigured',lastError:null,lastSyncedAt:null,lastCheckedAt:null};
  const outcomes=new Map(), lastAttempt=new Map();
  const MAPPING_VERSION="yes-up-v1";
  let restoredVerified=0;
  let running=false, cycling=false, lastCheckpointCount=0, scanOffset=0, completedScans=0;
  const candidates=new Map();
  const diagnostics={attempted:0,recovered:0,notFound:0,notFinal:0,mappingRejected:0,errors:0};
  const MAX_CHECKPOINTS=500, MAX_MARKETS_PER_PASS=24, RETRY_MS=30*60*1000;
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
    const settled=['settled','finalized'].includes(String(m?.status||'').toLowerCase());
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
    try{return (await axios.get(BASE+'/historical/markets/'+encodeURIComponent(ticker),{timeout:10000})).data?.market||null;}catch(e){if(e.response?.status===404)return null;throw e;}
  }
  async function load(){if(!configured)return;
    try{for(let offset=0;;offset+=500){
      const records=await db('GET','kalshibot_official_outcomes',`?select=*&order=ticker.asc&limit=500&offset=${offset}`);
      if(!Array.isArray(records))throw Error('Invalid outcome response');
      for(const r of records)if(isSafeTicker(r.ticker)){
        const trusted=r.mapping_verified===true&&r.mapping_version===MAPPING_VERSION&&Number.isFinite(Date.parse(r.mapping_verified_at))&&r.source==='kalshi_public_api'&&['settled','finalized'].includes(r.market_status)&&['yes','no'].includes(r.result);
        outcomes.set(r.ticker,{...r,mappingVerified:trusted?true:null});
        if(trusted)restoredVerified++;
      }
      if(records.length<500)break;
      }
      status.state='ready';status.lastError=null;status.lastSyncedAt=new Date().toISOString();
      console.log('[OfficialOutcomes] restored',outcomes.size,'outcomes');
    }catch(e){status.state='error';status.lastError='Supabase outcomes read HTTP '+(e.response?.status||'network');console.error('[OfficialOutcomes]',status.lastError);}}
  async function collect(){if(!configured||running)return;running=true;
    try{
      // Research only: read checkpoint rows, not orders, positions, or credentials.
      // Rotate through stable ordered pages instead of permanently revisiting the newest 500 rows.
      const data=await db('GET','kalshibot_checkpoint_signals',`?select=ticker,close_time:payload->>closeTime&order=ticker.asc,checkpoint_minute.asc&limit=${MAX_CHECKPOINTS}&offset=${scanOffset}`);
      const checkpoints=Array.isArray(data)?data:[];lastCheckpointCount=checkpoints.length;
      if(checkpoints.length<MAX_CHECKPOINTS){scanOffset=0;completedScans++;}else scanOffset+=checkpoints.length;
      const now=Date.now();
      for(const x of checkpoints){const close=Number(x.close_time??x.payload?.closeTime);
        if(isSafeTicker(x.ticker)&&Number.isFinite(close)&&close>0&&close<=now-60000)candidates.set(x.ticker,close);}
      const next=[...candidates].filter(([ticker])=>outcomes.get(ticker)?.mappingVerified!==true&&now-(lastAttempt.get(ticker)||0)>RETRY_MS)
        .sort((a,b)=>(lastAttempt.get(a[0])||0)-(lastAttempt.get(b[0])||0)||a[1]-b[1]).slice(0,MAX_MARKETS_PER_PASS);
      const writes=[];
      for(const [ticker] of next){lastAttempt.set(ticker,Date.now());diagnostics.attempted++;try{
        const m=await getMarket(ticker);if(!m||m.ticker!==ticker){diagnostics.notFound++;continue;}
        const o=normal(m);if(!o.result){diagnostics.notFinal++;continue;}
        if(!o.mappingVerified)diagnostics.mappingRejected++;
        const dbRow={ticker:o.ticker,market_status:o.market_status,result:o.result,settlement_time:o.settlement_time,
          source:o.source,verified_at:o.verified_at,updated_at:o.updated_at,
          mapping_verified:o.mappingVerified,mapping_version:MAPPING_VERSION,mapping_verified_at:new Date().toISOString()};
        writes.push({dbRow,o});
      }catch(e){diagnostics.errors++;status.lastError='Kalshi lookup HTTP '+(e.response?.status||'network');if(e.response?.status===429)break;}}
      if(writes.length){await db('POST','kalshibot_official_outcomes','?on_conflict=ticker',writes.map(x=>x.dbRow));
        for(const {dbRow,o} of writes){outcomes.set(o.ticker,{...dbRow,mappingVerified:o.mappingVerified,title:o.title});diagnostics.recovered++;}}
      status.state='ready';status.lastSyncedAt=new Date().toISOString();
    }catch(e){status.state='error';status.lastError='Phase 3.3 collection HTTP '+(e.response?.status||'network');console.error('[OfficialOutcomes]',status.lastError);}
    finally{status.lastCheckedAt=new Date().toISOString();running=false;io.emit('official:summary',summary());}
  }
  // Do not consider an outcome without confirmed semantics verifiable for a directional score.
  // Persist mapping evidence only after exact-ticker public verification and successful DB write.
  async function cycle(){if(cycling)return;cycling=true;try{await collect();}finally{cycling=false;}}
  function summary(){const checkpointRecords=[];
    // Comparison snapshot is assembled in /api/official-performance by loadable async DB call.
    const verified=[...outcomes.values()].filter(x=>['yes','no'].includes(String(x.result).toLowerCase()));
    return {mode:'paper-only',storage:status.state==='ready'?'supabase':configured?'degraded':'unconfigured',
      persistence:{...status},verifiedMarkets:verified.length,mappingValidated:verified.filter(x=>x.mappingVerified===true).length,
      mappingUnverified:verified.filter(x=>x.mappingVerified!==true).length,checkpointRowsSeen:lastCheckpointCount,
      recovery:{version:"3.6.1",restoredVerified,persistedVerified:verified.filter(x=>x.mappingVerified===true&&x.mapping_verified===true).length,scanOffset,completedScans,discoveredMarkets:candidates.size,remaining:[...candidates.keys()].filter(t=>outcomes.get(t)?.mappingVerified!==true).length,...diagnostics},
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
  return {load,cycle,summary,performance,verifiedForResearch:()=>[...outcomes.values()].filter(o=>o.mappingVerified===true&&['yes','no'].includes(o.result)).map(o=>({ticker:o.ticker,result:o.result}))};
};
