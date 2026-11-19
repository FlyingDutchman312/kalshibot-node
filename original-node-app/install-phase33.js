/** One-time idempotent local patch of EXISTING Phase 3.2 files. Run: node install-phase33.js
 * No data migration, no trade controls, no secrets. Existing source remains otherwise unchanged.
 */
const fs=require('fs'),path=require('path');
const root=__dirname;
const serverPath=path.join(root,'server.js'),htmlPath=path.join(root,'public','index.html');
const modulePath=path.join(root,'official-outcomes.js'),uiPath=path.join(root,'public','official-outcomes.js');
for(const p of [serverPath,htmlPath,modulePath,uiPath])if(!fs.existsSync(p))throw Error('Required file missing: '+p);
let server=fs.readFileSync(serverPath,'utf8');
let html=fs.readFileSync(htmlPath,'utf8');
if(!server.includes("app.get('/api/checkpoints'"))throw Error('Expected Phase 3.2 server.js; refusing to patch another version.');
if(!server.includes('await checkpointMonitor.load();'))throw Error('Checkpoint startup hook not found.');
if(!html.includes('id="checkpoint-research"'))throw Error('Existing Phase 3.2 dashboard section not found.');
const beforeServer=server,beforeHtml=html;
if(!server.includes("require('./official-outcomes')")){
  server=server.replace('let busyBTC = false, busyKalshi = false;',
`const officialOutcomes = require('./official-outcomes')({axios,io,
  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,
  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY,
  seriesTicker:SERIES_TICKER});
let busyBTC = false, busyKalshi = false;`);
}
if(!server.includes("app.get('/api/official-performance'")){
  server=server.replace("app.get('/api/checkpoints', (_req,res)=>res.json(checkpointMonitor.summary()));",
`app.get('/api/checkpoints', (_req,res)=>res.json(checkpointMonitor.summary()));
app.get('/api/official-performance', async (_req,res)=>{
  const result=await officialOutcomes.performance();res.json(result);
});`);
}
if(!server.includes('await officialOutcomes.load();')){
  server=server.replace('await checkpointMonitor.load();',
    'await checkpointMonitor.load();\n  await officialOutcomes.load();');
}
if(!server.includes('officialOutcomes.cycle().catch')){
  server=server.replace('  setInterval(getKalshi,30000);',
`  setInterval(getKalshi,30000);
  officialOutcomes.cycle().catch(err=>console.error('[OfficialOutcomes]',err.message));
  setInterval(()=>officialOutcomes.cycle().catch(err=>console.error('[OfficialOutcomes]',err.message)),60000);`);
}
const panel=`    <section class="panel full-panel" id="official-research" style="grid-column:1/-1;padding:14px;">
      <div class="panel-header"><span class="panel-title">PHASE 3.3 • OFFICIAL KALSHI OUTCOME VERIFICATION (PAPER ONLY)</span></div>
      <div class="metric-sub" id="official-status" style="margin:8px 0 12px;">Loading official outcomes...</div>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr>
        <th>MINUTE</th><th>UP/DOWN</th><th>NONE</th><th>MISSED</th><th>OFFICIALLY GRADED</th><th>CORRECT</th><th>INCORRECT</th><th>UNGRADED</th><th>OFFICIAL AGREEMENT</th>
      </tr></thead><tbody id="official-stats"><tr><td colspan="9">Checking public settlements...</td></tr></tbody></table></div>
      <div class="metric-sub" style="margin-top:10px;">Recent official market outcomes</div>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>TICKER</th><th>RESULT</th><th>YES=UP MAPPING</th><th>VERIFIED AT (UTC)</th></tr></thead><tbody id="official-recent"></tbody></table></div>
      <div class="metric-sub" style="margin-top:8px;">Only finalized Kalshi YES/NO with verified contract wording count toward agreement. NONE/missed/unverified outcomes are excluded. Five checkpoints on one market are correlated. No actual trades, model probabilities, or P&amp;L.</div>
    </section>\n\n`;
if(!html.includes('id="official-research"')){
  const anchor='    <!-- Row 2: Bot Intent + Model -->';
  if(!html.includes(anchor))throw Error('Expected HTML anchor missing');
  html=html.replace(anchor,panel+anchor);
}
if(!html.includes('official-outcomes.js')){
  html=html.replace('</body>','  <script src="official-outcomes.js?v=phase33-20261119"></script>\n</body>');
}
if(!server.includes("app.get('/api/official-performance'") || !server.includes('await officialOutcomes.load();') || !server.includes('officialOutcomes.cycle().catch') || !html.includes('id="official-research"'))throw Error('Phase 3.3 patch could not find every required insertion point; no files changed');
if(server===beforeServer&&html===beforeHtml){console.log('Already installed; no files changed');process.exit(0);}
fs.writeFileSync(serverPath,server);fs.writeFileSync(htmlPath,html);
console.log('Phase 3.3 installed. Modified server.js and public/index.html; no trading engine loaded.');
