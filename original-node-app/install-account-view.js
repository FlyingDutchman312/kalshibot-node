/** Run in original-node-app: node install-account-view.js */
'use strict';
const fs=require('node:fs'),path=require('node:path');const dir=__dirname;
for(const p of ['server.js','public/index.html','kalshi-account-readonly.js','public/kalshi-account-view.js'])if(!fs.existsSync(path.join(dir,p)))throw Error('Missing '+p+'. No files modified.');
const sp=path.join(dir,'server.js'),hp=path.join(dir,'public/index.html');
let s=fs.readFileSync(sp,'utf8'),h=fs.readFileSync(hp,'utf8');
if(!s.includes("app.get('/api/research-quality'")||!h.includes('id="phase35-research"'))throw Error('Phase 3.5 required: do not patch older version.');
if(!s.includes("require('./kalshi-account-readonly')")){
 const anchor='let busyBTC = false, busyKalshi = false;';if(!s.includes(anchor))throw Error('Server anchor absent.');
 s=s.replace(anchor,"const accountViewer=require('./kalshi-account-readonly')({axios});\n"+anchor);
}
if(!s.includes("app.get('/api/account-view'")){
 const anchor="app.get('/api/research-quality', async (_req,res)=>{";if(!s.includes(anchor))throw Error('API anchor absent.');
 s=s.replace(anchor,"app.get('/api/account-view', accountViewer.handler);\n"+anchor);
}
if(!h.includes('id="kalshi-account-panel"')){
 const anchor='    <!-- Row 2: Bot Intent + Model -->';if(!h.includes(anchor))throw Error('HTML anchor absent.');
 const panel=`    <section class="panel full-panel" id="kalshi-account-panel" style="grid-column:1/-1;padding:14px;">
      <div class="panel-header"><span class="panel-title">KALSHI PRODUCTION ACCOUNT • READ ONLY • PRIVATE VIEW</span></div>
      <p class="metric-sub">This view does not enable any order placement. Enter only the separately configured viewer passphrase here, NEVER a Kalshi API key or private key.</p>
      <input id="kalshi-account-pass" type="password" autocomplete="off" placeholder="Viewer passphrase" style="padding:8px;max-width:320px;background:#172031;color:white;border:1px solid #667" />
      <button id="kalshi-account-unlock" type="button" style="padding:8px;margin:6px;cursor:pointer">Connect read-only view</button>
      <button id="kalshi-account-lock" type="button" style="padding:8px;margin:6px;cursor:pointer">Lock view</button>
      <div id="kalshi-account-status" class="metric-sub">Locked • no account data loaded</div>
      <div id="kalshi-account-data" class="metric-sub" style="padding-top:10px"></div>
    </section>
`;
 h=h.replace(anchor,panel+anchor);
}
if(!h.includes('src="kalshi-account-view.js'))h=h.replace('</body>','  <script src="kalshi-account-view.js?v=readonly-20261119"></script>\n</body>');
if(!s.includes("app.get('/api/account-view'")||!h.includes('id="kalshi-account-panel"'))throw Error('Incomplete patch: not written.');
fs.writeFileSync(sp,s);fs.writeFileSync(hp,h);console.log('Account viewer installed. Private route requires viewer passphrase. Trading remains disabled.');
