// Phase 3.5: client-side read-only display. No trading controls.
(() => {
 const get=id=>document.getElementById(id),status=get('phase35-status'),quality=get('phase35-quality');
 const table=get('phase35-stats'),bad=get('phase35-invalid'),daily=get('phase35-daily');
 if(!status||!quality||!table||!bad||!daily)return;
 const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&quot;'}[c]));
 const pct=x=>x==null?'--':x+'%';
 async function update(){if(document.hidden)return;try{const response=await fetch('/api/research-quality',{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const x=await response.json();
 status.textContent='Status: '+x.status+' • Forward start (UTC): '+(x.forwardStartUtc||'NOT CONFIGURED')+' • Forward markets: '+(x.forward?.markets??0)+' • Trading: DISABLED'+(x.error?' • '+x.error:'');
 quality.textContent='Read '+(x.allRowsRead??0)+' rows • Closed valid '+(x.validClosedRows??0)+' • Pending market close '+(x.pendingMarketRows??0)+' • Excluded '+(x.invalidRows??0)+(x.truncatedAtRowCap?' • LIMIT REACHED':'');
 table.innerHTML=(x.forward?.checkpoints||[]).map(s=>{const q=(x.qualifications||[]).find(v=>v.minute===s.minute);return `<tr><td>${s.minute}m</td><td>${s.directional}</td><td>${s.graded}</td><td>${pct(s.accuracyPct)}</td><td>${pct(s.wilson95.lower)}–${pct(s.wilson95.upper)}</td><td>${esc(q?.status||'—')}</td></tr>`;}).join('')||'<tr><td colspan="6">Forward cohort not configured or no data.</td></tr>';
 bad.innerHTML=(x.invalidExamples||[]).map(r=>`<tr><td>${esc(r.ticker)}</td><td>${esc(r.minute)}</td><td>${esc((r.reasons||[]).join(', '))}</td></tr>`).join('')||'<tr><td colspan="3">No invalid checkpoint rows found</td></tr>';
 daily.innerHTML=(x.daily||[]).map(d=>{const g=d.checkpoints.reduce((v,s)=>({correct:v.correct+s.correct,graded:v.graded+s.graded}),{correct:0,graded:0});return `<tr><td>${esc(d.date)}</td><td>${d.markets}</td><td>${g.graded}</td><td>${g.graded?pct(Math.round(1000*g.correct/g.graded)/10):'--'}</td></tr>`;}).join('')||'<tr><td colspan="4">No prospective daily results yet</td></tr>';
 }catch(e){status.textContent='Phase 3.5 API unavailable: '+e.message;}}
 update();setInterval(update,300000);
})();
