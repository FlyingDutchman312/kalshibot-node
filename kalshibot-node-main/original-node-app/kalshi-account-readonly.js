'use strict';
/** Account viewer and safe diagnostics. Production account GETs only; NO orders. */
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
  if(!privateKey){
   try{privateKey=crypto.createPrivateKey(pem);}catch(e){const err=new Error('PRIVATE_KEY_PARSE_FAILED');err.safeCode='PRIVATE_KEY_PARSE_FAILED';throw err;}
  }
  const timestamp=String(Date.now());
  const message=Buffer.from(timestamp+'GET'+path,'utf8');
  let signature;
  try{
   const kind=privateKey.asymmetricKeyType;
   if(kind==='rsa'||kind==='rsa-pss')signature=crypto.sign('sha256',message,{key:privateKey,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:crypto.constants.RSA_PSS_SALTLEN_DIGEST});
   else if(kind==='ed25519')signature=crypto.sign(null,message,privateKey);
   else {const err=new Error('UNSUPPORTED_KEY_TYPE');err.safeCode='UNSUPPORTED_KEY_TYPE';throw err;}
  }catch(e){if(e.safeCode)throw e;const err=new Error('SIGNATURE_FAILED');err.safeCode='SIGNATURE_FAILED';throw err;}
  return {'KALSHI-ACCESS-KEY':keyId,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature.toString('base64'),'Accept':'application/json','User-Agent':'KalshibotAccountViewer/1.0'};
 }
 async function get(path,params){
  const result=await axios.get(BASE+path,{headers:signingHeaders(path),params,timeout:12000,maxRedirects:0,validateStatus:s=>s>=200&&s<300});
  return result.data||{};
 }
 function classifyFailure(reason){
  const status=Number(reason?.response?.status)||null;
  if(reason?.safeCode)return {category:reason.safeCode,upstreamStatus:null};
  if(status===401||status===403)return {category:'KALSHI_AUTH_OR_PERMISSION',upstreamStatus:status};
  if(status===429)return {category:'KALSHI_RATE_LIMIT',upstreamStatus:status};
  if(status)return {category:'KALSHI_HTTP_ERROR',upstreamStatus:status};
  if(reason?.code==='ECONNABORTED')return {category:'KALSHI_TIMEOUT',upstreamStatus:null};
  if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH'].includes(reason?.code))return {category:'KALSHI_NETWORK_ERROR',upstreamStatus:null};
  return {category:'UNCLASSIFIED_REQUEST_ERROR',upstreamStatus:null};
 }
 async function handler(req,res){
  res.set('Cache-Control','no-store, private');res.set('Pragma','no-cache');
  if(!authorize(req))return res.status(401).json({status:'unauthorized',connected:false,mode:'read-only',tradingEnabled:false,message:'Viewer passphrase missing, incorrect, or connection not configured.'});
  const [balance,positions]=await Promise.allSettled([get(PATHS.balance),get(PATHS.positions,{limit:100})]);
  const failures=[];
  if(balance.status==='rejected')failures.push({endpoint:'balance',...classifyFailure(balance.reason)});
  if(positions.status==='rejected')failures.push({endpoint:'positions',...classifyFailure(positions.reason)});
  if(failures.length){
   const auth=failures.some(x=>x.category==='KALSHI_AUTH_OR_PERMISSION');
   return res.status(auth?502:503).json({status:'error',connected:false,mode:'read-only',tradingEnabled:false,
    message:auth?'Kalshi authentication or permissions rejected the read-only request.':'Kalshi account read temporarily unavailable.',
    upstreamStatus:failures[0].upstreamStatus,diagnostics:failures});
  }
  const b=balance.value,p=positions.value;
  const num=x=>Number.isFinite(Number(x))?Number(x):null;
  const balanceCents=num(b.balance),portfolioCents=num(b.portfolio_value);
  const marketPositions=(Array.isArray(p.market_positions)?p.market_positions:[]).slice(0,100).map(x=>({
   ticker:String(x.ticker||'').slice(0,120),position:x.position_fp??x.position??null,
   market_exposure:x.market_exposure_dollars??x.market_exposure??null,
   realized_pnl:x.realized_pnl_dollars??x.realized_pnl??null}));
  return res.json({status:'ready',connected:true,mode:'read-only',tradingEnabled:false,source:'kalshi_production',generatedAt:new Date().toISOString(),
   balanceUsd:balanceCents===null?null:balanceCents/100,portfolioValueUsd:portfolioCents===null?null:portfolioCents/100,
   marketPositions,positionResultsTruncated:Boolean(p.cursor),note:'Account data only; no orders or trades are enabled.'});
 }
 return {handler,configured};
};
