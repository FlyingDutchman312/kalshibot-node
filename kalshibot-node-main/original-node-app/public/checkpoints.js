// Phase 3.2 read-only research dashboard; never submits orders.
(() => {
  const storage=document.getElementById('checkpoint-storage');
  const statsBody=document.getElementById('checkpoint-stats');
  const journalBody=document.getElementById('checkpoint-journal');
  if(!storage||!statsBody||!journalBody)return;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
  const fmt=n=>Number.isFinite(n)?'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'--';
  const render=data=>{
    if(!data||!Array.isArray(data.stats))return;
    storage.textContent='Storage: '+data.storage+' • Pending writes: '+(data.persistence?.pendingWrites??'--')+
      (data.persistence?.lastError?' • '+data.persistence.lastError:'')+' • Five checkpoints per eligible 15m market';
    statsBody.innerHTML=data.stats.map(s=>`<tr><td>${s.minute}m</td><td>${s.captured}</td><td>${s.missed}</td><td>${s.directional}</td><td>${s.abstentions}</td><td>${s.evaluated}</td><td>${s.proxyAgreementPct==null?'--':s.proxyAgreementPct+'%'}</td></tr>`).join('');
    journalBody.innerHTML=(data.journal||[]).slice(0,25).map(r=>{
      const time=r.observedAt?new Date(r.observedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Missed';
      const result=r.proxyStatus==='pending'?'Pending':r.proxyStatus==='spot_proxy'?`${r.proxyDirection}${r.proxyCorrect==null?'':r.proxyCorrect?' · agrees':' · differs'}`:r.proxyStatus;
      return `<tr><td>${esc(time)}</td><td>${esc(r.ticker)}</td><td>${r.checkpointMinute}m</td><td>${esc(r.action)}</td><td>${esc(r.reasonCode)}</td><td>${fmt(r.entrySpot)}</td><td>${esc(result)}</td></tr>`;
    }).join('')||'<tr><td colspan="7">No checkpoint records yet. Render Free may sleep between requests.</td></tr>';
  };
  if(typeof socket!=='undefined') socket.on('checkpoint:summary',render);
  fetch('/api/checkpoints',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(render).catch(()=>{storage.textContent='Checkpoint API unavailable';});
})();
