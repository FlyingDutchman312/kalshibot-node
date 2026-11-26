/** One-time, idempotent Phase 3.5 install. Run: node install-phase35.js
 * Only modifies server.js and public/index.html. Never touches trading or DB tables.
 */
'use strict';
const fs=require('fs'),path=require('path');const root=__dirname;
const required=['server.js','official-outcomes.js','research-quality.js','public/index.html','public/research-quality.js'];
for(const p of required)if(!fs.existsSync(path.join(root,p)))throw Error('Missing '+p+'; nothing changed');
const serverPath=path.join(root,'server.js'),htmlPath=path.join(root,'public/index.html');
let server=fs.readFileSync(serverPath,'utf8'),html=fs.readFileSync(htmlPath,'utf8');
const oldServer=server,oldHtml=html;
if(!server.includes("app.get('/api/research-performance'")||!server.includes("require('./official-outcomes')"))throw Error('Expected Phase 3.4 server missing; no files changed');
if(!html.includes('id="phase34-research"'))throw Error('Expected Phase 3.4 UI missing; no files changed');
if(!server.includes("require('./research-quality')")){
 const anchor='let busyBTC = false, busyKalshi = false;';if(!server.includes(anchor))throw Error('Missing initialization anchor');
 server=server.replace(anchor,`const researchQuality=require('./research-quality')({axios,officialOutcomes,\n  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,\n  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY,\n  forwardStartUtc:process.env.KALSHIBOT_FORWARD_START_UTC});\n${anchor}`);
}
if(!server.includes("app.get('/api/research-quality'")){
 const anchor="app.get('/api/research-performance', async (_req,res)=>{";if(!server.includes(anchor))throw Error('Missing Phase 3.4 route anchor');
 server=server.replace(anchor,`app.get('/api/research-quality', async (_req,res)=>{\n  res.json(await researchQuality.performance());\n});\n${anchor}`);
}
if(!html.includes('id="phase35-research"')){
 const anchor='    <!-- Row 2: Bot Intent + Model -->';if(!html.includes(anchor))throw Error('Missing UI anchor');
 const panel=`    <section class="panel full-panel" id="phase35-research" style="grid-column:1/-1;padding:14px;">
      <div class="panel-header"><span class="panel-title">PHASE 3.5 • DATA QUALITY &amp; FORWARD VALIDATION (NO TRADES)</span></div>
      <div class="metric-sub" id="phase35-status" style="margin:8px 0 12px;">Loading forward-validation research…</div>
      <div class="metric-sub" id="phase35-quality" style="margin:8px 0 12px;"></div>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>CHECKPOINT</th><th>FORWARD SIGNALS</th><th>GRADED</th><th>ACCURACY</th><th>95% WILSON</th><th>QUALIFICATION</th></tr></thead><tbody id="phase35-stats"><tr><td colspan="6">Loading…</td></tr></tbody></table></div>
      <div class="metric-sub" style="margin:10px 0 5px;">Excluded-row diagnostics (read-only)</div>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>TICKER</th><th>MINUTE</th><th>REASONS</th></tr></thead><tbody id="phase35-invalid"><tr><td colspan="3">Loading…</td></tr></tbody></table></div>
      <div class="metric-sub" style="margin:10px 0 5px;">Daily forward research (UTC)</div>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>DATE (UTC)</th><th>MARKETS</th><th>GRADED</th><th>ACCURACY</th></tr></thead><tbody id="phase35-daily"><tr><td colspan="4">Loading…</td></tr></tbody></table></div>
      <div class="metric-sub" style="padding-top:8px;">Forward results only start after KALSHIBOT_FORWARD_START_UTC is configured. No historical signals are relabeled as forward tests. No order execution; qualification never unlocks trading.</div>
    </section>\n\n`;
 html=html.replace(anchor,panel+anchor);
}
if(!html.includes('<script src="research-quality.js'))html=html.replace('</body>','  <script src="research-quality.js?v=phase35-20261119"></script>\n</body>');
if(!server.includes("app.get('/api/research-quality'")||!server.includes("require('./research-quality')")||!html.includes('id="phase35-research"'))throw Error('Incomplete patch; no files changed');
if(server!==oldServer){fs.writeFileSync(serverPath,server);console.log('Updated server.js');}
if(html!==oldHtml){fs.writeFileSync(htmlPath,html);console.log('Updated public/index.html');}
console.log('Phase 3.5 installed: read-only data quality and forward validation. Trading disabled.');
