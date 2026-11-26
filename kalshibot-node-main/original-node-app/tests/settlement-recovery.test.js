const test=require('node:test');
const assert=require('node:assert/strict');
const create=require('../official-outcomes');
test('recovery rotates pages, checks exact ticker, batches verified outcomes',async()=>{
 const a='KXBTC15M-OLD',b='KXBTC15M-NEW',c='KXBTC15M-WRONG';
 const writes=[],offsets=[];const close=Date.now()-120000;
 const axios=async req=>{
  if(req.method==='POST'){writes.push(req.data);return {data:null};}
  if(req.url.includes('checkpoint_signals')){const offset=Number(new URL(req.url).searchParams.get('offset'));offsets.push(offset);return {data:offset===0?Array.from({length:500},()=>({ticker:a,close_time:close})):[{ticker:b,close_time:close},{ticker:c,close_time:close}]};}
  return {data:[]};
 };
 axios.get=async url=>({data:{market:{ticker:url.endsWith(c)?a:url.split('/').pop(),status:'finalized',result:'yes',title:'Bitcoin up'}}});
 const svc=create({axios,io:{emit(){}},supabaseUrl:'https://example.supabase.co',supabaseKey:'test'});
 await svc.load();await svc.cycle();await svc.cycle();
 assert.deepEqual(offsets,[0,500]);assert.equal(writes.length,2);assert.deepEqual(svc.verifiedForResearch().map(x=>x.ticker),[a,b]);assert.equal(svc.summary().recovery.remaining,1);assert.equal(svc.summary().recovery.completedScans,1);
});
test('archived markets use exact historical endpoint; ambiguous markets stay ungraded',async()=>{
 const ticker='KXBTC15M-ARCHIVED';let historical=false;
 const axios=async req=>({data:req.method==='GET'&&req.url.includes('checkpoint_signals')?[{ticker,close_time:Date.now()-120000}]:[]});
 axios.get=async url=>{if(!url.includes('/historical/'))throw {response:{status:404}};historical=true;return {data:{market:{ticker,status:'finalized',result:'no',title:'Bitcoin price'}}};};
 const svc=create({axios,io:{emit(){}},supabaseUrl:'https://example.supabase.co',supabaseKey:'test'});await svc.cycle();assert.equal(historical,true);assert.equal(svc.verifiedForResearch().length,0);assert.equal(svc.summary().recovery.mappingRejected,1);
});
