'use strict';
(() => {
  const el=id=>document.getElementById(id);
  async function refresh(stopped) {
    const method=typeof stopped==='boolean'?'POST':'GET';
    el('demoMessage').textContent='Checking demo state…';
    try {
      const response=await fetch('/api/demo',{
        method,headers:{'x-demo-control-token':el('demoToken').value,'Content-Type':'application/json'},
        ...(method==='POST'?{body:JSON.stringify({stopped})}:{})
      });
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Demo request failed');
      el('demoMessage').textContent=(data.control?.[0]?.stopped?'STOPPED. ':'DEMO AUTOMATION ARMED. ')+data.last;
      el('demoJournal').textContent=JSON.stringify(data,null,2);
    } catch(e){el('demoMessage').textContent=e.message;}
  }
  el('demoRefresh').onclick=()=>refresh();
  el('demoStart').onclick=()=>refresh(false);
  el('demoStop').onclick=()=>refresh(true);
})();
