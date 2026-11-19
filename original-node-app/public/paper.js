// Independent read-only paper-observation panel. Does not call trading endpoints.
(() => {
  const body = document.getElementById('paper-journal-body');
  const summary = document.getElementById('paper-summary');
  if (!body || !summary) return;
  const safe = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const usd = (n) => Number.isFinite(Number(n)) ? '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '--';
  const render = (data) => {
    if (!data || !Array.isArray(data.journal)) return;
    const accuracy = data.proxyAccuracyPct == null ? '--' : `${data.proxyAccuracyPct}%`;
    summary.textContent = `${data.recorded} observations • ${data.directional} UP/DOWN signals • ${data.evaluated} spot-proxy evaluations • proxy directional agreement: ${accuracy} (not official accuracy)`;
    body.innerHTML = data.journal.length ? data.journal.slice(0,30).map(r => {
      const time = new Date(r.observedAt).toLocaleString('en-US',{timeZone:'America/New_York',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const outcome = r.proxyStatus === 'pending' ? 'Pending' : `${r.proxyDirection} (spot proxy${r.proxyCorrect === null ? '' : r.proxyCorrect ? ', agrees' : ', differs'})`;
      return `<tr><td>${safe(time)}</td><td>${safe(r.ticker)}</td><td>${safe(r.action)}</td><td>${usd(r.entrySpot)}</td><td>${safe(outcome)}</td></tr>`;
    }).join('') : '<tr><td colspan="5">Waiting for a BTC 15-minute market within five minutes of close and a warmed-up price feed.</td></tr>';
  };
  if (typeof socket !== 'undefined') socket.on('paper:journal', render);
  fetch('/api/paper-journal', {cache:'no-store'}).then(r=>r.ok?r.json():null).then(render).catch(()=>{});
})();
