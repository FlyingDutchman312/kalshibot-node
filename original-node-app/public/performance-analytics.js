/** Phase 3.4 research-only analytics UI. */
(() => {
  const status=document.getElementById('phase34-status');
  const tbody=document.getElementById('phase34-stats');
  const windowSelect=document.getElementById('phase34-window');
  if(!status||!tbody||!windowSelect)return;
  const safe=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\"':'&quot;'}[c]));
  const fmt=x=>x===null||x===undefined?'--':Number(x).toFixed(1)+'%';
  let last=null;
  function render(){
    if(!last)return;
    if(last.status!=='ready'){status.textContent='Analytics unavailable: '+(last.error||last.status);return;}
    const chosen=Number(windowSelect.value);
    const data=last.windows.find(x=>x.windowSize===chosen)||last.windows[0];
    status.textContent='Paper only • '+data.marketsInWindow+' markets in window • '+last.validatedSettlementMarkets+' mapped outcomes in memory • '+(last.truncatedAtRowCap?'DATA CAP REACHED':'history available')+' • No orders';
    tbody.innerHTML=data.checkpoints.map(s=>{
      const q=last.qualifications.find(x=>x.minute===s.minute);
      return `<tr><td>${s.minute}m</td><td>${s.directional}</td><td>${s.graded}</td><td>${s.correct}/${s.incorrect}</td><td>${fmt(s.accuracyPct)}</td><td>${fmt(s.wilson95.lower)}–${fmt(s.wilson95.upper)}</td><td>${fmt(s.coveragePct)}</td><td>${s.abstentions}</td><td>${s.missed}</td><td>${safe(q?.status||'LOCKED')} (NO TRADES)</td></tr>`;
    }).join('');
  }
  async function refresh(){try{const r=await fetch('/api/research-performance',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);last=await r.json();render();}catch(e){status.textContent='Analytics unavailable: '+e.message;}}
  windowSelect.addEventListener('change',render);
  refresh();
  if(typeof socket!=='undefined')socket.on('official:summary',()=>{refresh();});
  window.setInterval(refresh,60000);
})();
