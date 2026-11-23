'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const createDemo=require('../demo-trading');
const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const now=Date.parse('2026-11-23T18:00:00Z'),ticker='KXBTC15M-26NOV231315-15';
const signal={intent:{action:'UP',reasonCode:'EXPERIMENTAL_MOMENTUM'},model:{trendWarmup:false}};
function fixture({stop=false,enabled=true,timeout=false,rows=[],fillCount='0.00',fills=[]}={}){
  const state={stopped:stop,rows,calls:[],posts:0};
  const market={ticker,status:'active',close_time:new Date(now+300000).toISOString(),
    yes_ask_dollars:'0.60',yes_bid_dollars:'0.59',no_ask_dollars:'0.41',no_bid_dollars:'0.40'};
  const env={KALSHIBOT_SUPABASE_URL:'https://test.supabase.co',KALSHIBOT_SUPABASE_SERVICE_KEY:'sb_secret_test',
    KALSHI_DEMO_KEY_ID:'demo',KALSHI_DEMO_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}),
    KALSHIBOT_DEMO_CONTROL_TOKEN:'a'.repeat(32),KALSHIBOT_DEMO_ENABLED:String(enabled)};
  const axios={async request(r){
    state.calls.push(r);
    assert.equal(r.maxRedirects,0);
    assert(!r.url.includes('external-api.kalshi.com'));
    let data;
    if(r.url.includes('/rest/v1/')){
      if(r.url.includes('kalshibot_demo_attempts?'))data=state.rows;
      else if(r.url.includes('kalshibot_demo_control?'))data=[{stopped:state.stopped}];
      else if(r.url.endsWith('kalshibot_demo_reserve')){
        assert.equal(state.stopped,false);
        if(state.rows.some(x=>x.ticker===r.data.p_ticker))data=false;
        else {
          state.rows.push({ticker,client_order_id:r.data.p_client,status:'RESERVED',payload:r.data.p_payload});
          data=true;
        }
      }else if(r.url.endsWith('kalshibot_demo_update')){
        const row=state.rows.find(x=>x.ticker===r.data.p_ticker);
        row.status=r.data.p_status;Object.assign(row.payload,r.data.p_payload);
      }else if(r.url.endsWith('kalshibot_demo_stop'))state.stopped=r.data.p_stopped;
      else throw Error('Unexpected DB request');
    }else{
      const path=new URL(r.url).pathname.replace('/trade-api/v2','');
      assert(r.headers['KALSHI-ACCESS-SIGNATURE']);
      if(r.method==='POST'){
        state.posts++;
        assert.equal(path,'/portfolio/events/orders');
        if(timeout)throw Error('timeout');
        data={order:{order_id:'exchange-id'}};
      }else if(path.startsWith('/markets/'))data={market};
      else if(path==='/portfolio/orders')data={orders:r.params?.status?[]:
        state.rows.filter(x=>x.payload.orderId).map(x=>({ticker,client_order_id:x.client_order_id,
          order_id:'exchange-id',status:'canceled',fill_count_fp:fillCount})),cursor:''};
      else if(path==='/portfolio/fills')data={fills,cursor:''};
      else if(path==='/portfolio/positions')data={market_positions:[],cursor:''};
      else if(path==='/portfolio/balance')data={balance:10000};
      else throw Error('Unexpected demo request');
    }
    return {data};
  }};
  return {state,market,env,axios,make:()=>createDemo({axios,env,getSignal:()=>signal,
    getMarkets:()=>[{ticker,closeTime:now+300000}],getSpotTime:()=>new Date(now).toISOString(),clock:()=>now})};
}
test('valid candidate selects one-contract budget and correct side',()=>{
  const {market}=fixture();
  const c=createDemo.candidate(signal,market,now);
  assert.equal(c.budget,65);assert.equal(c.yes,true);
});
test('invalid market, wide spread, missing quotes and near close fail qualification',()=>{
  const {market}=fixture();
  for(const change of [{ticker:'PRODUCTION-OTHER'},{yes_bid_dollars:'.10'},
    {yes_ask_dollars:'NaN'},{close_time:new Date(now+10000).toISOString()}]){
    try{assert.equal(createDemo.candidate(signal,{...market,...change},now),null);}
    catch(e){assert.match(e.message,/numeric/);}
  }
});
test('persistent stop prevents signed order submission',async()=>{
  const f=fixture({stop:true});await f.make().cycle();assert.equal(f.state.posts,0);
});
test('environment default off prevents submission',async()=>{
  const f=fixture({enabled:false});await f.make().cycle();assert.equal(f.state.posts,0);
});
test('one reservation and submit survive another cycle and restart',async()=>{
  const f=fixture();const d=f.make();await d.cycle();await d.cycle();await f.make().cycle();
  assert.equal(f.state.posts,1);assert.equal(f.state.rows.length,1);
  assert.equal(f.state.rows[0].status,'NO_FILL');
});
test('ambiguous timeout remains locked after restart',async()=>{
  const f=fixture({timeout:true});await f.make().cycle();await f.make().cycle();
  assert.equal(f.state.posts,1);assert.equal(f.state.rows[0].status,'UNKNOWN');
});
test('partial fill reconciles quantity costs fees and persists pending settlement',async()=>{
  const row={ticker,client_order_id:'client',status:'SUBMITTED',payload:{yes:true,orderId:'exchange-id'}};
  const f=fixture({stop:true,rows:[row],fillCount:'0.50',
    fills:[{order_id:'exchange-id',fill_id:'f1',count_fp:'.50',yes_price_dollars:'.60',fee_cost:'.01'}]});
  await f.make().cycle();
  assert.equal(row.payload.filled,.5);assert.equal(row.payload.cost,.3);assert.equal(row.payload.fees,.01);
});
test('mismatched fills block new orders',async()=>{
  const row={ticker,client_order_id:'client',status:'SUBMITTED',payload:{yes:true,orderId:'exchange-id'}};
  const f=fixture({rows:[row],fillCount:'1.00'});await f.make().cycle();
  assert.equal(f.state.posts,0);assert.equal(row.status,'SUBMITTED');
});
test('account token is required for stop/start control',async()=>{
  const f=fixture();const res={set(){},status(s){this.code=s;return this;},json(data){this.data=data;}};
  await f.make().handler({headers:{},method:'POST',body:{stopped:false}},res);
  assert.equal(res.code,401);
});
test('database outage prevents order attempt',async()=>{
  const f=fixture();f.axios.request=async()=>{throw Error('offline');};
  await f.make().cycle();assert.equal(f.state.posts,0);
});
