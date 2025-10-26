// /assets/js/admin.js
// --- Guard: reuse your existing login flag & redirect ---
(function guard(){
  try {
    if (localStorage.getItem('amaranth_admin_pw_ok') !== '1') {
      window.location.replace('/admin/reporting_login.html');
    }
  } catch (e) {
    window.location.replace('/admin/reporting_login.html');
  }
})();

// --- API helpers: automatically include auth if you add a token later ---
// Works whether you use simple session (no header) or a bearer token.
// If localStorage.token exists, it will be sent; otherwise no auth header.
function authHeaders() {
  const h = {};
  const token = localStorage.getItem('token'); // optional JWT if you add it later
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

export async function apiGet(path){
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function apiPut(path, body){
  const r = await fetch(path, {
    method: 'PUT',
    headers: {
      'Content-Type':'application/json',
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// --- Money + ids ---
export function moneyToCents(v){
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const n = parseFloat(String(v).replace(/[^0-9.]/g,'') || '0');
  return Math.round(n * 100);
}
export function centsToMoney(c){ return (c/100).toFixed(2); }
export function uid(){ return 'id_' + Math.random().toString(36).slice(2,10); }
