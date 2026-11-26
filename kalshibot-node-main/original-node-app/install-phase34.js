/** Apply Phase 3.4 as an idempotent patch to the verified Phase 3.3 source.
 * Run from within original-node-app: node install-phase34.js
 * Never edits paper signal collection, Supabase data, or live trading restrictions.
 */
'use strict';
const fs=require('fs'),path=require('path');
const root=__dirname;
const file=(p)=>path.join(root,p);
const paths=['server.js','official-outcomes.js','public/index.html','performance-analytics.js','public/performance-analytics.js'];
for(const p of paths)if(!fs.existsSync(file(p)))throw Error('Missing '+p+'; no files changed.');
let server=fs.readFileSync(file('server.js'),'utf8');
let official=fs.readFileSync(file('official-outcomes.js'),'utf8');
let html=fs.readFileSync(file('public/index.html'),'utf8');
const old={server,official,html};
const originalReturn='return {load,cycle,summary,performance};';
if(!official.includes('verifiedForResearch:')){
  if(!official.includes(originalReturn))throw Error('Official verifier return hook missing; no files changed.');
  official=official.replace(originalReturn,
    "return {load,cycle,summary,performance,verifiedForResearch:()=>[...outcomes.values()].filter(o=>o.mappingVerified===true&&['yes','no'].includes(o.result)).map(o=>({ticker:o.ticker,result:o.result}))};");
}
if(!server.includes("require('./performance-analytics')")){
  const anchor='let busyBTC = false, busyKalshi = false;';
  if(!server.includes(anchor))throw Error('Server initializer anchor missing; no files changed.');
  server=server.replace(anchor,
    `const performanceAnalytics=require('./performance-analytics')({axios,officialOutcomes,\n  supabaseUrl:process.env.KALSHIBOT_SUPABASE_URL,\n  supabaseKey:process.env.KALSHIBOT_SUPABASE_SERVICE_KEY});\n${anchor}`);
}
if(!server.includes("app.get('/api/research-performance'")){
  const anchor="app.get('/api/official-performance', async (_req,res)=>{";
  if(!server.includes(anchor))throw Error('Existing Phase 3.3 API anchor missing; no files changed.');
  server=server.replace(anchor,
    `app.get('/api/research-performance', async (_req,res)=>{\n  const report=await performanceAnalytics.performance();res.json(report);\n});\n${anchor}`);
}
if(!html.includes('id="phase34-research"')){
  const anchor='    <!-- Row 2: Bot Intent + Model -->';
  if(!html.includes(anchor))throw Error('HTML section insertion anchor missing; no files changed.');
  const panel=`    <section class="panel full-panel" id="phase34-research" style="grid-column:1/-1;padding:14px;">
      <div class="panel-header"><span class="panel-title">PHASE 3.4 • CHECKPOINT PERFORMANCE RESEARCH (NO TRADES)</span></div>
      <div class="metric-sub" id="phase34-status" style="margin:8px 0 12px;">Loading research history…</div>
      <label class="metric-sub" for="phase34-window">Latest unique markets:</label>
      <select id="phase34-window" style="margin:0 0 12px 8px;background:#172031;color:#fff;padding:6px;border:1px solid #556;">
        <option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="250">250</option>
      </select>
      <div class="markets-table-wrap"><table class="markets-table"><thead><tr>
        <th>MINUTE</th><th>UP/DOWN</th><th>GRADED</th><th>CORRECT / WRONG</th><th>OFFICIAL AGREEMENT</th><th>95% WILSON INTERVAL</th><th>SETTLEMENT COVERAGE</th><th>NONE</th><th>MISSED</th><th>QUALIFICATION</th>
      </tr></thead><tbody id="phase34-stats"><tr><td colspan="10">Loading…</td></tr></tbody></table></div>
      <div class="metric-sub" style="padding-top:10px;">Only validated official YES/NO market mappings are graded. At least 100 independently settled markets per checkpoint and a 95% Wilson lower bound above 50% are required even to meet a research threshold. This is not proof of out-of-sample performance or profitability. NO live or demo orders are enabled.</div>
    </section>

`;
  html=html.replace(anchor,panel+anchor);
}
if(!html.includes('<script src="performance-analytics.js')){
  if(!html.includes('</body>'))throw Error('Missing HTML script insertion anchor; no files changed.');
  html=html.replace('</body>','  <script src="performance-analytics.js?v=phase34-20261119"></script>\n</body>');
}
if(!server.includes("app.get('/api/research-performance'")||!server.includes("require('./performance-analytics')")||!official.includes('verifiedForResearch:')||!html.includes('id="phase34-research"'))throw Error('Patch incomplete; no files changed.');
for(const [p,content,previous] of [['server.js',server,old.server],['official-outcomes.js',official,old.official],['public/index.html',html,old.html]]){
  if(content!==previous){fs.writeFileSync(file(p),content);console.log('Updated '+p);}
}
console.log('Phase 3.4 research panel installed. Existing checkpoint and official settlement tables unchanged. Trading remains disabled.');
