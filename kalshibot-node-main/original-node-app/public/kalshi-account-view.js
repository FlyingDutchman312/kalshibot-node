'use strict';
for(const id of ['kalshi-account-pass','kalshi-account-unlock','kalshi-account-lock']) {const e=document.getElementById(id);if(e)e.disabled=true;}
document.getElementById('kalshi-account-status').textContent='Account access disabled in research-only bandwidth build.';
