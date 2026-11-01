// /assets/js/tours-nav-helper.js
(function(){
  function visible(item,now){ if(!item||item.active===false)return false; const s=item.publishStart?Date.parse(item.publishStart):NaN; const e=item.publishEnd?Date.parse(item.publishEnd):NaN; if(!isNaN(s)&&now<s)return false; if(!isNaN(e)&&now>e)return false; return true; }
  async function run(){
    const links=[...document.querySelectorAll('[data-tours-link]')]; if(!links.length)return;
    let tours=[];
    try{ const r=await fetch('/api/router?type=tours',{cache:'no-store'}); if(r.ok){ const j=await r.json(); tours=Array.isArray(j?.tours)?j.tours:[]; } }catch(e){}
    if(!(tours||[]).some(t=>visible(t,Date.now()))) links.forEach(a=>a.style.display='none');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
})();
