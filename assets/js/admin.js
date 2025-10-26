<!-- File: /assets/js/admin.js -->
<script>
/* Admin shared helpers (browser global: window.Admin) */
(function(){
  const Admin = {};

  // Require admin login for ALL admin pages
  Admin.guard = function(){
    try{
      if (localStorage.getItem('amaranth_admin_pw_ok') !== '1') {
        window.location.replace('/admin/reporting_login.html');
      }
    }catch(e){
      window.location.replace('/admin/reporting_login.html');
    }
  };

  // Bearer token header (for /api/admin/*)
  Admin.tokenHeader = function(){
    const headers = { 'Content-Type':'application/json' };
    const t = localStorage.getItem('amaranth_report_token');
    if (t) headers.Authorization = 'Bearer ' + t;
    return headers;
  };

  // Small UI helpers
  Admin.setMsg = function(el, text, ok){
    if(!el) return;
    el.textContent = text || '';
    el.className = ok ? 'ok' : (text ? 'danger' : 'muted');
  };
  Admin.esc = s => (s??'').toString().replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c] ));
  Admin.toLocalDT = v => {
    if(!v) return '';
    const d = new Date(v); if (isNaN(d)) return '';
    const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
    return local.toISOString().slice(0,16);
  };
  Admin.fromLocalDT = v => {
    if(!v) return '';
    const d = new Date(v);
    return isNaN(d) ? '' : d.toISOString();
  };

  // Auto-guard and auto-wire logout if present
  document.addEventListener('DOMContentLoaded', ()=>{
    Admin.guard();
    const btn = document.getElementById('logoutBtn');
    if (btn){
      btn.addEventListener('click', ()=>{
        localStorage.removeItem('amaranth_admin_pw_ok');
        location.href = '/admin/reporting_login.html';
      });
    }
  });

  window.Admin = Admin;
})();
</script>
