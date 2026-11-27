(()=>{
  const status=document.getElementById('research-health-status');
  const body=document.getElementById('research-health-rows');
  const details=document.getElementById('research-health-details');
  const refresh=document.getElementById('research-health-refresh');
  if(!status||!body||!details||!refresh)return;
  let busy=false;
  const display=v=>v==null?'Unknown':String(v);
  const age=v=>v==null?'Unknown':Math.round(v)+'s';
  async function update(){
    if(busy||document.hidden)return;busy=true;
    try{
      const response=await fetch('/api/research-health',{cache:'no-store'});
      if(!response.ok)throw Error('HTTP '+response.status);
      const report=await response.json();
      status.textContent='Checked '+new Date(report.generatedAt).toLocaleString('en-US',{timeZone:'America/New_York'})+
        ' ET · remote checks cached '+report.cacheSeconds+'s · trading disabled';
      body.replaceChildren();details.replaceChildren();
      for(const app of report.apps||[]){
        const row=document.createElement('tr');
        const values=[app.app,app.status,age(app.pollAgeSeconds??app.marketAgeSeconds),
          app.app==='Original BTC bot'?display(app.missedCheckpoints):'Unknown',
          display(app.pendingDiscoveredSettlements),
          app.app==='Original BTC bot'?display(app.newQuoteRecords)+' saved / '+display(app.newMissingQuotes)+' missing':
            app.app==='Precision Scalper'?display(app.rateLimitsSinceRestart)+' rate limits; '+display(app.deferredReads)+' reads deferred':'—',
          (app.issues||[]).join('; ')||'No current issues reported'];
        for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
        body.append(row);
        const p=document.createElement('p');p.textContent=app.app+': '+(app.scope||'No data available.');details.append(p);
      }
    }catch(e){status.textContent='Health summary unavailable: '+e.message;}
    finally{busy=false;}
  }
  refresh.addEventListener('click',update);document.addEventListener('visibilitychange',()=>{if(!document.hidden)update();});
  update();setInterval(update,60000);
})();
