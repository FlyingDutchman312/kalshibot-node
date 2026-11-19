'use strict';
/** Account viewing only. No orders, withdrawals, transfers or mutation requests. */
const crypto=require('node:crypto');
const BASE='https://external-api.kalshi.com';
const ROOT='/trade-api/v2';
const PATHS=Object.freeze({balance:ROOT+'/portfolio/balance',positions:ROOT+'/portfolio/positions'});
module.exports=function createKalshiAccountReadOnly({axios,env=process.env}){
 const keyId=String(env.KALSHI_READONLY_KEY_ID||'').trim();
 const rawPem=String(env.KALSHI_READONLY_PRIVATE_KEY||'');
 const pem=rawPem.replace(/\\n/g,'\n').trim();
 const viewerSecret=String(env.KALSHIBOT_ACCOUNT_VIEW_TOKEN||'');
 const configured=Boolean(keyId&&pem&&viewerSecret.length>=24);
 let privateKey=null;
 function authorize(req){
  const supplied=String(req.headers['x-account-view-token']||'');
  if(!configured||!supplied||supplied.length>512)return false;
  const a=crypto.createHash('sha256').update(supplied).digest();
  const b=crypto.createHash('sha256').update(viewerSecret).digest();
  return crypto.timingSafeEqual(a,b);
 }
 function signingHeaders(path){
  if(!privateKey)privateKey=crypto.createPrivateKey(pem);
  const timestamp=String(Date.now());
  const message=Buffer.from(timestamp+'GET'+path,'utf8');
  const kind=privateKey.asymmetricKeyType;
  let signature;
  if(kind==='rsa'||kind==='rsa-pss') signature=crypto.sign('sha256',message,{key:privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST});
  else if(kind==='ed25519')signature=crypto.sign(null,message,privateKey);
  else throw Error('Unsupported Kalshi private key type');
  return {'KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature.toString('base64'),'Accept':'application/json','User-Agent':'KalshibotAccountViewer/1.0'};
 }
 async function get(path,params){
  const result=await axios.get(BASE+path,{headers:signingHeaders(path),params,timeout:12000,maxRedirects:0,validateStatus:s=>s>=200&&s<300});
  return result.data||{};
 }
 function handler(req,res){
  res.set('Cache-Control','no-store, private');res.set('Pragma','no-cache');
  if(!authorize(req))return res.status(401).json({status:'unauthorized',connected:false,mode:'read-only',tradingEnabled:false,message:'Viewer passphrase missing, incorrect, or connection not configured.'});
  return Promise.allSettled([get(PATHS.balance),get(PATHS.positions,{limit:100})]).then(([balance,positions])=>{
   const bad=[balance,positions].find(x=>x.status==='rejected');
   if(bad){const code=bad.reason?.response?.status;
    return res.status(code===401||code===403?502:503).json({status:'error',connected:false,mode:'read-only',tradingEnabled:false,message:code===401||code===403?'Kalshi authentication or permissions rejected the read-only request. Check Key ID, PEM, API scope and production environment.':'Kalshi account read temporarily unavailable.',upstreamStatus:code||null});}
   const b=balance.value,p=positions.value;
   const num=x=>Number.isFinite(Number(x))?Number(x):null;
   const balanceCents=num(b.balance);const portfolioCents=num(b.portfolio_value);
   const marketPositions=(Array.isArray(p.market_positions)?p.market_positions:[]).slice(0,100).map(x=>({ticker:String(x.ticker||'').slice(0,120),position:x.position_fp??x.position??null,market_exposure:x.market_exposure_dollars??x.market_exposure??null,realized_pnl:x.realized_pnl_dollars??x.realized_pnl??null}));
   return res.json({status:'ready',connected:true,mode:'read-only',tradingEnabled:false,source:'kalshi_production',generatedAt:new Date().toISOString(),balanceUsd:balanceCents===null?null:balanceCents/100,portfolioValueUsd:portfolioCents===null?null:portfolioCents/100,marketPositions,positionResultsTruncated:Boolean(p.cursor),note:'Account data only; no orders or trades are enabled. Do not assume this is an all-time trade ledger.'});
  });
 }
 return {handler,configured};
};
