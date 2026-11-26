// Phase 3.3: official-outcome research panel. Read-only browser fetch; no account/order calls.
(() => {
 const el=document.getElementById('official-status');
 const body=document.getElementById('official-stats');
 const recent=document.getElementById('official-recent');
 if(!el||!body||!recent)return;
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const render=x=>{
   if(!x)return;
   el.textContent=`Storage: ${x.storage||'unknown'} • Official settled markets: ${x.verifiedMarkets||0} • Mappings verified: ${x.mappingValidated||0} • Mappings pending/unverified: ${x.mappingUnverified||0} • Checkpoint history inspected: ${x.checkpointRowsSeen||0}${x.persistence?.lastError?' • '+x.persistence.lastError:''}${x.error?' • '+x.error:''}`;
   body.innerHTML=(x.stats||[]).map(r=>`<tr><td>${r.minute}m</td><td>${r.directional}</td><td>${r.abstentions}</td><td>${r.missed}</td><td>${r.officiallyGraded}</td><td>${r.correct}</td><td>${r.incorrect}</td><td>${r.ungraded}</td><td>${r.officialAccuracyPct==null?'—':r.officialAccuracyPct+'%'}</td></tr>`).join('')||'<tr><td colspan="9">Waiting for checkpoint and outcome data</td></tr>';
   recent.innerHTML=(x.recent||[]).slice(0,15).map(r=>`<tr><td>${esc(r.ticker)}</td><td>${esc(r.result?.toUpperCase())}</td><td>${r.mappingVerified?'Verified':'Not verified'}</td><td>${esc(r.verifiedAt||'—')}</td></tr>`).join('')||'<tr><td colspan="4">No official outcomes retrieved yet</td></tr>';
 };
 const refresh=()=>document.hidden?Promise.resolve():fetch('/api/official-performance',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(r.status)).then(render).catch(e=>{el.textContent='Official performance API unavailable ('+e+')';});
 refresh();setInterval(refresh,300000);
})();
