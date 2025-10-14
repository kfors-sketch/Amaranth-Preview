// Shared helpers
async function getJSON(p){const r=await fetch(p,{cache:'no-store'}); if(!r.ok) throw new Error('load '+p); return r.json();}
function money(c){return `$${(c/100).toFixed(2)}`;}
function orgSlug(){const m=location.pathname.match(/^\/([^\/]+)\//);return m?m[1]:'';}
function setLS(k,v){localStorage.setItem(k, JSON.stringify(v));}
function getLS(k, fallback){try{const v=localStorage.getItem(k);return v?JSON.parse(v):fallback;}catch(_){return fallback;}}
function surchargeOf(base, settings){
  const s=settings?.surcharge||{};const P=Number(s.fee_percent||0),F=Number(s.fee_fixed_cents||0),CAP=Number(s.cap_percent||0);
  if(!s.enabled||(P<=0&&F<=0)) return 0;
  const gross=Math.ceil((base+F)/(1-P)); let sur=gross-base;
  if(CAP>0){const capPct=Math.floor(base*CAP); if(sur>capPct) sur=capPct;} return sur;
}

// --- STORE PAGE ---
async function renderStorePage(){
  const org=orgSlug(); if(!org) return;
  const [products, settings]=await Promise.all([
    getJSON(`/data/${org}/products.json`),
    getJSON(`/data/${org}/settings.json`),
  ]);
  const cartKey=`${org}_store`;
  const cart=getLS(cartKey, {});
  const grid=document.getElementById('store-grid');
  if(grid){
    grid.innerHTML=(products.items||[]).map(p=>{
      const q=cart[p.handle]||0;
      return `<div class="card">
        <h3>${p.name}</h3>
        <p>${p.description||''}</p>
        <div class="price">${money(p.price_cents)}</div>
        <label>Qty <input class="qty" data-h="${p.handle}" type="number" min="0" value="${q}"></label>
      </div>`;
    }).join('');
    grid.querySelectorAll('.qty').forEach(inp=>inp.addEventListener('input',e=>{
      const h=e.target.dataset.h; const v=Math.max(0, Number(e.target.value||0));
      if(v===0) delete cart[h]; else cart[h]=v;
      setLS(cartKey, cart);
      updateStoreSummary(products, settings, cart);
    }));
  }
  updateStoreSummary(products, settings, cart);
  const toOrder=document.getElementById('to-order'); if(toOrder) toOrder.href=`/${org}/order.html`;
  const toBanq=document.getElementById('to-banquets'); if(toBanq) toBanq.href=`/${org}/banquets.html`;
}
function updateStoreSummary(products, settings, cart){
  const el=document.getElementById('store-total'); if(!el) return;
  let total=0;
  (products.items||[]).forEach(p=>{
    const q=Number(cart[p.handle]||0);
    if(q>0){ for(let i=0;i<q;i++){ total+=p.price_cents+surchargeOf(p.price_cents, settings); } }
  });
  el.textContent=money(total);
}

// --- ORDER PAGE ---
let STATE=null;
async function renderOrderPage(){
  const org=orgSlug(); if(!org) return;
  const [banquets, settings]=await Promise.all([
    getJSON(`/data/${org}/banquets.json`),
    getJSON(`/data/${org}/settings.json`)
  ]);
  STATE={org,settings,attendees:[],donation_cents:0,banquets};
  // Purchaser/Attendees UI
  document.getElementById('add-attendee')?.addEventListener('click', addAttendee);
  addAttendee();

  // Donation (defaults to 0)
  const dnWrap=document.getElementById('extra-donation');
  if(dnWrap && settings.donations?.allow_extra_on_order){
    dnWrap.innerHTML=`<p>${settings.donations.purpose_text||''}</p>
      <label>Amount (USD) <input type="number" id="donation-amount" min="0" step="1" value="0"></label>`;
    dnWrap.querySelector('#donation-amount').addEventListener('input',e=>{
      STATE.donation_cents=Math.max(0, Math.round(Number(e.target.value||0)*100));
    });
  }

  // Save & Review
  document.getElementById('review')?.addEventListener('click', saveAndReview);
  // Links
  const toStore=document.getElementById('to-store'); if(toStore) toStore.href=`/${org}/shop.html`;
  const toBanq=document.getElementById('to-banquets'); if(toBanq) toBanq.href=`/${org}/banquets.html`;
}

function attendeeCard(i){
  const evs=STATE.banquets.events||[];
  const blocks=evs.map((ev,idx)=>{
    // Breakfast-like events: no meal dropdown if meal_required === false
    const mealRequired = (ev.meal_required !== false); // default true
    const meals = mealRequired ? (ev.meals||[]) : [];
    const mealSel = mealRequired ? `<label>Meal<select class="meal" data-i="${i}" data-ev="${idx}">
        ${(meals||[]).map(m=>`<option value="${m.code}">${m.label}</option>`).join('')}
      </select></label>` : `<div class="tiny">No meal choice required for this event.</div>`;

    const tickets=(ev.tickets||[]).map(t=>`<option value="${t.handle}|${t.price_cents}">${ev.title} — ${t.label} — ${money(t.price_cents)}</option>`).join('');

    return `<div class="card mt">
      <h4>${ev.title} — ${new Date(ev.datetime_iso).toLocaleString()}</h4>
      <p class="tiny">${ev.description||''}</p>
      <div class="grid-3">
        <label>Ticket<select class="ticket" data-i="${i}" data-ev="${idx}"><option value="">-- none --</option>${tickets}</select></label>
        ${mealSel}
      </div>
    </div>`;
  }).join('');
  return `<div class="card mt" id="att-${i}">
    <div style="display:flex;justify-content:space-between;align-items:center;"><h3>Attendee ${i+1}</h3><button class="btn" onclick="removeAttendee(${i})">Remove</button></div>
    <div class="grid-3">
      <label>Full name<input type="text" class="a-name" data-i="${i}" required></label>
      <label>Email<input type="email" class="a-email" data-i="${i}"></label>
      <label>Title<input type="text" class="a-title" data-i="${i}"></label>
    </div>
    <label>Dietary restrictions <input type="text" class="a-diet" data-i="${i}" placeholder="e.g., gluten-free"></label>
    ${blocks}
  </div>`;
}

function renderAttendees(){document.getElementById('attendee-list').innerHTML=STATE.attendees.map((a,i)=>attendeeCard(i)).join(''); bindAttendeeInputs();}
function addAttendee(){STATE.attendees.push({name:'',email:'',title:'',dietary:'',selections:[]}); renderAttendees();}
function removeAttendee(i){STATE.attendees.splice(i,1); renderAttendees();}

function bindAttendeeInputs(){
  document.querySelectorAll('.a-name').forEach(el=>el.addEventListener('input',e=>{const i=+e.target.dataset.i; STATE.attendees[i].name=e.target.value;}));
  document.querySelectorAll('.a-email').forEach(el=>el.addEventListener('input',e=>{const i=+e.target.dataset.i; STATE.attendees[i].email=e.target.value;}));
  document.querySelectorAll('.a-title').forEach(el=>el.addEventListener('input',e=>{const i=+e.target.dataset.i; STATE.attendees[i].title=e.target.value;}));
  document.querySelectorAll('.a-diet').forEach(el=>el.addEventListener('input',e=>{const i=+e.target.dataset.i; STATE.attendees[i].dietary=e.target.value;}));
  document.querySelectorAll('.ticket').forEach(sel=>sel.addEventListener('change',e=>{
    const i=+e.target.dataset.i, ev=+e.target.dataset.ev; const [h,c]=e.target.value?e.target.value.split('|'):[null,0];
    if(!STATE.attendees[i].selections[ev]) STATE.attendees[i].selections[ev]={};
    STATE.attendees[i].selections[ev].handle=h; STATE.attendees[i].selections[ev].price_cents=Number(c||0);
  }));
  document.querySelectorAll('.meal').forEach(sel=>sel.addEventListener('change',e=>{
    const i=+e.target.dataset.i, ev=+e.target.dataset.ev;
    if(!STATE.attendees[i].selections[ev]) STATE.attendees[i].selections[ev]={};
    STATE.attendees[i].selections[ev].meal=e.target.value;
  }));
}

function saveAndReview(){
  // Validate purchaser block
  const purchaser={
    name:document.getElementById('p_name').value.trim(),
    title:document.getElementById('p_title').value.trim(),
    email:document.getElementById('p_email').value.trim(),
    phone:document.getElementById('p_phone').value.trim(),
    address:{
      line1:document.getElementById('p_addr1').value.trim(),
      line2:document.getElementById('p_addr2').value.trim(),
      city:document.getElementById('p_city').value.trim(),
      state:document.getElementById('p_state').value.trim(),
      postal_code:document.getElementById('p_zip').value.trim(),
      country:document.getElementById('p_country').value.trim()||'US'
    }
  };
  if(!purchaser.name||!purchaser.email||!purchaser.phone||!purchaser.address.line1||!purchaser.address.city||!purchaser.address.state||!purchaser.address.postal_code||!purchaser.address.country){
    alert('Please complete purchaser info.'); return;
  }
  const org=orgSlug();
  const order={ purchaser, attendees:STATE.attendees, extra_donation_cents:STATE.donation_cents };
  setLS(`${org}_order`, order);
  location.href=`/${org}/review.html`;
}

// --- REVIEW PAGE ---
async function renderReviewPage(){
  const org=orgSlug(); if(!org) return;
  const [products, banquets, settings]=await Promise.all([
    getJSON(`/data/${org}/products.json`),
    getJSON(`/data/${org}/banquets.json`),
    getJSON(`/data/${org}/settings.json`)
  ]);
  const order=getLS(`${org}_order`, null);
  const store=getLS(`${org}_store`, {});
  if(!order){ document.getElementById('review-root').innerHTML='<div class="notice">No order found. Please start on the Order page.</div>'; return; }

  // Build line summary
  let total=0;
  const lines=[];
  // attendees tickets
  (order.attendees||[]).forEach((a,ai)=>{
    (a.selections||[]).forEach((sel,evIdx)=>{
      if(sel?.handle){
        const ev=(banquets.events||[])[evIdx];
        const itemName=`${ev?.title||'Event'} — Attendee ${ai+1}`;
        const price=Number(sel.price_cents||0);
        const sur=surchargeOf(price, settings);
        total+=price+sur;
        lines.push({name:itemName, detail:(sel.meal?`Meal: ${sel.meal}`:''), price, surcharge:sur, qty:1});
      }
    });
  });
  // store items
  const byH=Object.fromEntries((products.items||[]).map(p=>[p.handle,p]));
  for(const [h,q] of Object.entries(store)){
    const p=byH[h]; const qty=Number(q||0);
    if(p && qty>0){
      const sur=surchargeOf(p.price_cents, settings);
      total+=(p.price_cents+sur)*qty;
      lines.push({name:p.name, detail:'', price:p.price_cents, surcharge:sur, qty});
    }
  }
  // donation
  const dn=Number(order.extra_donation_cents||0);
  if(dn>0){ total+=dn; lines.push({name:'Extra Donation', detail:'', price:dn, surcharge:0, qty:1}); }

  const list=document.getElementById('review-lines');
  list.innerHTML = lines.map(l=>`<div class="card"><div><strong>${l.name}</strong>${l.detail?`<div class="tiny">${l.detail}</div>`:''}</div><div>${l.qty>1?`${l.qty} × `:''}${money(l.price)}${l.surcharge?` + fee ${money(l.surcharge)}`:''}</div></div>`).join('');
  document.getElementById('review-total').textContent = money(total);

  document.getElementById('pay')?.addEventListener('click', async()=>{
    try{
      const body={ org, order:{ ...order, store } };
      const res=await fetch('/api/create-checkout-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await res.json();
      if(!res.ok || !data.url) throw new Error(data?.error||'Checkout failed');
      location.href=data.url;
    }catch(e){ alert(e.message); }
  });

  // Links
  const backToOrder=document.getElementById('back-order'); if(backToOrder) backToOrder.href=`/${org}/order.html`;
  const toStore=document.getElementById('to-store'); if(toStore) toStore.href=`/${org}/shop.html`;
}

// Page routers
document.addEventListener('DOMContentLoaded',()=>{
  if(document.body.dataset.page==='store'){ renderStorePage(); }
  if(document.body.dataset.page==='order'){ renderOrderPage(); }
  if(document.body.dataset.page==='review'){ renderReviewPage(); }
});
