// Phase 3.6: private view of production account. Nothing persisted client-side.
(()=>{
 const $=id=>document.getElementById(id);
 const status=$('kalshi-account-status'),unlock=$('kalshi-account-unlock'),pass=$('kalshi-account-pass'),out=$('kalshi-account-data');
 if(!status||!unlock||!pass||!out)return;
 let token='';
 const money=n=>typeof n==='number'&&Number.isFinite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD'}):'—';
 const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&quot;'}[c]));
 async function refresh(){if(!token)return;status.textContent='Connecting securely…';
  try{const r=await fetch('/api/account-view',{headers:{'x-account-view-token':token},cache:'no-store'});const x=await r.json();
   if(!r.ok||x.status!=='ready'){status.textContent=x.message||'Connection failed';if(r.status===401)token='';return;}
   status.textContent='Kalshi production • READ ONLY • updated '+new Date(x.generatedAt).toLocaleTimeString();
   out.innerHTML='<div style="margin-bottom:10px">Available balance: <strong>'+money(x.balanceUsd)+'</strong> | Portfolio value: <strong>'+money(x.portfolioValueUsd)+'</strong></div>'+
    '<div>Positions returned: '+x.marketPositions.length+(x.positionResultsTruncated?' (more pages exist)':'')+'</div><div class="markets-table-wrap"><table class="markets-table"><thead><tr><th>TICKER</th><th>POSITION</th><th>EXPOSURE</th><th>REALIZED P&L</th></tr></thead><tbody>'+x.marketPositions.map(p=>'<tr><td>'+esc(p.ticker)+'</td><td>'+esc(p.position)+'</td><td>'+esc(p.market_exposure)+'</td><td>'+esc(p.realized_pnl)+'</td></tr>').join('')+'</tbody></table></div>';
  }catch(_e){status.textContent='Account view unavailable.';}
 }
 unlock.addEventListener('click',()=>{token=pass.value;pass.value='';refresh();});
 pass.addEventListener('keydown',e=>{if(e.key==='Enter')unlock.click();});
 const lock=$('kalshi-account-lock');lock?.addEventListener('click',()=>{token='';pass.value='';out.textContent='Locked';status.textContent='Account view locked';});
 // Never auto-refresh with persisted credentials. Token exists in memory for current tab only.
})();
