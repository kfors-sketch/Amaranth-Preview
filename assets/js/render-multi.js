
/* ===== utilities ===== */
async function getJSON(p){const r=await fetch(p,{cache:'no-store'});if(!r.ok) throw new Error('load '+p);return r.json();}
function money(c){return `$${(c/100).toFixed(2)}`;}
function currentOrg(){const m=location.pathname.match(/^\/([^\/]+)\//);return m?m[1]:'';}

/* ===== Banquet date formatting ===== */
function ordinal(n){const s=["th","st","nd","rd"], v=n%100;return n+(s[(v-20)%10]||s[v]||s[0]);}
function formatBanquetDateTime(iso){
  if(!iso) return '';
  const d=new Date(iso); if(isNaN(d)) return '';
  const weekday=d.toLocaleDateString(undefined,{weekday:'long'});
  const month=d.toLocaleDateString(undefined,{month:'long'});
  const day=ordinal(d.getDate());
  let h=d.getHours(), m=d.getMinutes();
  const ampm=h>=12?'PM':'AM'; h=h%12; if(h===0) h=12;
  const time=m===0?`${h} ${ampm}`:`${h}:${String(m).padStart(2,'0')} ${ampm}`;
  return `${weekday}, ${month} ${day} at ${time}`;
}

/* ===== simple lightbox ===== */
function ensureLightbox(){
  if(document.getElementById('lightbox')) return;
  const lb=document.createElement('div');
  lb.id='lightbox';
  lb.innerHTML=`
    <div class="lb-inner">
      <button class="lb-close" aria-label="Close">×</button>
      <img id="lightbox-img" alt="">
      <div id="lightbox-caption" class="lb-caption"></div>
    </div>`;
  document.body.appendChild(lb);
  lb.addEventListener('click',e=>{ if(e.target.id==='lightbox'||e.target.classList.contains('lb-close')) lb.classList.remove('open'); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') lb.classList.remove('open'); });
}
function openLightbox(src,caption){
  ensureLightbox();
  const lb=document.getElementById('lightbox');
  const img=document.getElementById('lightbox-img');
  const cap=document.getElementById('lightbox-caption');
  img.src=src; img.alt=caption||''; cap.textContent=caption||''; lb.classList.add('open');
}

/* ===== home widgets ===== */
async function renderGroupHome(){
  const org=currentOrg();
  const homeBanquets=document.getElementById('home-banquets');
  const homeProducts=document.getElementById('home-products');

  if(homeBanquets){
    const banquets=await getJSON(`/data/${org}/banquets.json`);
    homeBanquets.innerHTML=(banquets.events||[]).slice(0,8).map(ev=>`
      <div class="card">
        <h3>${ev.title}</h3>
        <p>${formatBanquetDateTime(ev.datetime_iso)}</p>
        <p>${ev.venue||''}</p>
      </div>`).join('');
  }

  if(homeProducts){
    const products=await getJSON(`/data/${org}/products.json`);
    homeProducts.innerHTML=(products.items||[]).slice(0,3).map(p=>`
      <div class="card">
        <h3>${p.name}</h3>
        <p>${p.description||''}</p>
        <div class="price">${money(p.price_cents)}</div>
      </div>`).join('');
  }
}

async function renderBanquets(){
  const org=currentOrg();
  const data=await getJSON(`/data/${org}/banquets.json`);
  const el=document.getElementById('banquet-list');
  if(el){
    el.innerHTML=(data.events||[]).map(ev=>`
      <div class="card">
        <h3>${ev.title}</h3>
        <p><strong>${formatBanquetDateTime(ev.datetime_iso)}</strong> — ${ev.venue||''}</p>
        ${(ev.tickets||[]).map(t=>`<div class="mt">${t.label} — ${money(t.price_cents)}</div>`).join('')}
        <p class="tiny">Meals: ${(ev.meals||[]).map(m=>m.label).join(', ')}</p>
      </div>`).join('');
  }
}

async function renderDirectory(){
  const org=currentOrg();
  const el=document.getElementById('directory-info');
  if(!el) return;
  const s=await getJSON(`/data/${org}/settings.json`);
  el.textContent=s.directory?.blurb||'Purchase a printed directory via the Order page.';
}

async function renderShop(){
  const org=currentOrg();
  const data=await getJSON(`/data/${org}/products.json`);
  const grid=document.getElementById('product-grid');
  if(!grid) return;

  const pickImage=p=>p.image||p.image_url||p.img||(Array.isArray(p.images)&&p.images[0])||'';

  const cards=(data.items||[]).map(p=>{
    const imgSrc=pickImage(p);
    const imgBlock=imgSrc?`
      <button type="button" class="img-zoom" data-full="${imgSrc}" aria-label="View ${p.name}">
        <img src="${imgSrc}" alt="${p.name}" loading="lazy" style="max-width:100%;height:auto;border-radius:.75rem;">
      </button>`:'';
    return `
      <div class="card">
        ${imgBlock}
        <h3 style="margin-top:.5rem;">${p.name}</h3>
        <p>${p.description||''}</p>
        <div class="price">${money(p.price_cents)}</div>
      </div>`;
  }).join('');

  grid.innerHTML=cards;

  grid.addEventListener('click',e=>{
    const btn=e.target.closest('.img-zoom'); if(!btn) return;
    const full=btn.getAttribute('data-full'); const label=btn.getAttribute('aria-label')||'';
    if(full) openLightbox(full,label.replace(/^View\s+/,''));
  });
}

/* ===== ORDER ===== */
let STATE=null;

function surchargeOf(base){
  const s=STATE?.settings?.surcharge||{};
  const P=Number(s.fee_percent||0), F=Number(s.fee_fixed_cents||0), CAP=Number(s.cap_percent||0);
  if(!s.enabled||(P<=0&&F<=0)) return 0;
  const gross=Math.ceil((base+F)/(1-P));
  let sur=gross-base;
  if(CAP>0){const capPct=Math.floor(base*CAP); if(sur>capPct) sur=capPct;}
  return sur;
}

function regPriceCents(){
  const p=(STATE?.products?.items||[]).find(x=>x.handle==='registration');
  return p?Number(p.price_cents||0):0;
}

async function renderOrder(){
  /* FIX: guard so running this on non-order pages doesn’t crash */
  const hasOrderUI = document.getElementById('attendee-list') ||
                     document.getElementById('store-list') ||
                     document.getElementById('checkout');
  if(!hasOrderUI) return;

  const org=currentOrg(); if(!org) return;
  const [products,banquets,settings]=await Promise.all([
    getJSON(`/data/${org}/products.json`),
    getJSON(`/data/${org}/banquets.json`),
    getJSON(`/data/${org}/settings.json`)
  ]);
  STATE={org, attendees:[], store:{}, storeNotes:{}, products, banquets, settings};

  const addBtn=document.getElementById('add-attendee');
  if(addBtn) addBtn.addEventListener('click', addAttendee);

  /* FIX: only seed an attendee if the container exists */
  if(document.getElementById('attendee-list')) addAttendee();

  const store=document.getElementById('store-list');
  if(store){
    const addonsHandles=new Set(['directory','corsage']);
    const items=(products.items||[]);
    const addons=items.filter(p=>addonsHandles.has(p.handle)&&p.handle!=='registration');
    const merch =items.filter(p=>!addonsHandles.has(p.handle)&&p.handle!=='registration');

    const pickImage=p=>p.image||p.image_url||p.img||(Array.isArray(p.images)&&p.images[0])||'';
    const renderItem=p=>{
      const q=STATE.store[p.handle]||0;
      const imgSrc=pickImage(p);
      const thumb=imgSrc?`
        <button type="button" class="img-zoom" data-full="${imgSrc}" aria-label="View ${p.name}">
          <img src="${imgSrc}" alt="${p.name}" loading="lazy" style="max-width:100%;height:auto;border-radius:.75rem;">
        </button>`:'';
      return `
        <div class="card">
          ${thumb}
          <h3>${p.name}</h3>
          <p>${p.description||''}</p>
          <div class="price">${money(p.price_cents)}</div>
          <label>Qty <input type="number" min="0" value="${q}" data-handle="${p.handle}" class="store-qty"></label>
        </div>`;
    };

    const renderCorsage=p=>{
      const qty=STATE.store['corsage']||0;
      const note=STATE.storeNotes['corsage']||'';
      const presets=['Red Roses','Pink Roses','Yellow Roses','Spring Flowers'];
      const selected=presets.includes(note)?note:(note?'Custom':'Red Roses');
      const customText=(selected==='Custom' && !presets.includes(note))?note:'';
      const imgSrc=pickImage(p);
      const thumb=imgSrc?`
        <button type="button" class="img-zoom" data-full="${imgSrc}" aria-label="View ${p.name}">
          <img src="${imgSrc}" alt="${p.name}" loading="lazy" style="max-width:100%;height:auto;border-radius:.75rem;">
        </button>`:'';
      return `
        <div class="card">
          ${thumb}
          <h3>${p.name} ($${(p.price_cents/100).toFixed(0)})</h3>
          <p>${p.description||''}</p>
          <div class="grid-3">
            <label>Style
              <select id="corsage-style">
                <option value="Red Roses"${selected==='Red Roses'?' selected':''}>Red Roses</option>
                <option value="Pink Roses"${selected==='Pink Roses'?' selected':''}>Pink Roses</option>
                <option value="Yellow Roses"${selected==='Yellow Roses'?' selected':''}>Yellow Roses</option>
                <option value="Spring Flowers"${selected==='Spring Flowers'?' selected':''}>Spring Flowers</option>
                <option value="Custom"${selected==='Custom'?' selected':''}>Custom</option>
              </select>
            </label>
            <label>Custom text (if Custom)
              <input type="text" id="corsage-custom" placeholder="Describe your request" value="${customText}">
            </label>
            <label>Qty
              <input type="number" id="corsage-qty" min="0" value="${qty}">
            </label>
          </div>
        </div>`;
    };

    const addonsHTML=addons.map(p=>p.handle==='corsage'?renderCorsage(p):renderItem(p)).join('');
    const merchHTML =merch.map(renderItem).join('');

    store.innerHTML=`
      <div class="store-sections">
        <section class="card store-addons">
          <h2>Event add-ons</h2>
          <div class="grid-2">
            ${addonsHTML || '<div class="tiny">No add-ons available.</div>'}
          </div>
        </section>
        <section class="card store-merch" style="margin-top:24px">
          <h2>Merchandise</h2>
          <div class="grid-3">
            ${merchHTML || '<div class="tiny">No merchandise available.</div>'}
          </div>
        </section>
      </div>`;

    document.querySelectorAll('.store-qty').forEach(inp=>{
      inp.addEventListener('input',e=>{
        const h=e.target.getAttribute('data-handle');
        const v=Math.max(0,Number(e.target.value||0));
        if(v===0) delete STATE.store[h]; else STATE.store[h]=v;
        updateTotal();
      });
    });

    store.addEventListener('click',e=>{
      const btn=e.target.closest('.img-zoom'); if(!btn) return;
      const full=btn.getAttribute('data-full'); const label=btn.getAttribute('aria-label')||'';
      if(full) openLightbox(full,label.replace(/^View\s+/,''));
    });

    const cq=document.getElementById('corsage-qty');
    const cs=document.getElementById('corsage-style');
    const cc=document.getElementById('corsage-custom');
    function syncCorsage(){
      if(!cq||!cs||!cc) return;
      const qty=Math.max(0,Number(cq.value||0));
      const style=cs.value;
      const custom=(cc.value||'').trim();
      if(qty>0){
        STATE.store['corsage']=qty;
        STATE.storeNotes['corsage']=(style==='Custom')?(custom||'Custom'):style;
      }else{
        delete STATE.store['corsage'];
        delete STATE.storeNotes['corsage'];
      }
      updateTotal();
    }
    cq?.addEventListener('input',syncCorsage);
    cs?.addEventListener('change',syncCorsage);
    cc?.addEventListener('input',syncCorsage);
  }

  const donateWrap=document.getElementById('extra-donation');
  if(donateWrap && settings.donations?.allow_extra_on_order){
    donateWrap.innerHTML=`<p>${settings.donations.purpose_text||''}</p>
      <div id="donation-quick"></div>
      <label>Custom amount (USD) <input type="number" id="donation-amount" min="0" step="1" value="${settings.donations.default_amount||0}"></label>`;
    const quick=donateWrap.querySelector('#donation-quick');
    if(quick){
      quick.innerHTML=(settings.donations.suggested||[]).map(v=>`<button class="btn" data-dn="${v}">$${v}</button>`).join(' ');
      quick.querySelectorAll('[data-dn]').forEach(b=>b.addEventListener('click',e=>{
        const val=Number(e.currentTarget.getAttribute('data-dn')||0);
        const inp=document.getElementById('donation-amount'); if(inp) inp.value=val; updateTotal();
      }));
    }
    donateWrap.querySelector('#donation-amount')?.addEventListener('input', updateTotal);
  }

  document.getElementById('checkout')?.addEventListener('click', checkout);
  updateTotal();
}

/**
 * FIX: Enhanced attendeeCard for safer data access.
 * This function now pre-loads current selections or defaults to prevent null/undefined errors.
 */
function attendeeCard(i){
  const evs=STATE.banquets.events||[];
  const attendee = STATE.attendees[i] || {};
  // Ensure 'selections' is an array, even if empty
  attendee.selections = attendee.selections || [];

  const blocks=evs.map((ev,idx)=>{
    // Get the selection for this specific event index, or use an empty object as a safe default
    const sel = attendee.selections[idx] || {};

    const tickets=(ev.tickets||[]).map(t=>{
      const value = `${t.handle}|${t.price_cents}`;
      const selected = (sel.handle === t.handle) ? ' selected' : '';
      return `<option value="${value}"${selected}>${ev.title} — ${t.label} — ${money(t.price_cents)}</option>`;
    }).join('');

    const meals=(ev.meals||[]).map(m=>{
      const selected = (sel.meal === m.code) ? ' selected' : '';
      return `<option value="${m.code}"${selected}>${m.label}</option>`;
    }).join('');

    return `<div class="card mt"><h4>${ev.title} — ${formatBanquetDateTime(ev.datetime_iso)}</h4>
      <div class="grid-3">
        <label>Ticket<select class="ticket" data-i="${i}" data-ev="${idx}"><option value="">-- none --</option>${tickets}</select></label>
        <label>Meal<select class="meal" data-i="${i}" data-ev="${idx}"><option value="">-- none --</option>${meals}</select></label>
        <label>Dietary<input type="text" class="diet" data-i="${i}" data-ev="${idx}" placeholder="e.g., gluten-free" value="${sel.dietary || ''}"></label>
      </div></div>`;
  }).join('');

  const checked=STATE.attendees[i]?.registration?' checked':'';
  const activeClass=STATE.attendees[i]?.registration?' active':'';
  const regBlock=`
    <div class="reg-box${activeClass}" data-i="${i}">
      <label style="display:flex;align-items:center;gap:.6rem;margin:0;">
        <input type="checkbox" class="a-register" data-i="${i}"${checked}>
        <div>
          <div class="title">Register this attendee
            <span class="price-chip">${money(regPriceCents())}</span>
          </div>
          <div class="hint">Optional – adds a registration tied to this person’s name.</div>
        </div>
      </label>
    </div>`;

  return `<div class="card mt" id="att-${i}">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <h3>Attendee ${i+1}</h3><button class="btn" onclick="removeAttendee(${i})">Remove</button>
    </div>
    <div class="grid-3">
      <label>Full name<input type="text" class="a-name" data-i="${i}" required value="${attendee.name || ''}"></label>
      <label>Email (optional)<input type="email" class="a-email" data-i="${i}" value="${attendee.email || ''}"></label>
      <label>Title (optional)<input type="text" class="a-title" data-i="${i}" value="${attendee.title || ''}"></label>
    </div>
    ${blocks}
    ${regBlock}
  </div>`;
}

/* FIX: safe if container missing */
function renderAttendees(){
  const wrap=document.getElementById('attendee-list');
  if(!wrap) return;
  wrap.innerHTML=STATE.attendees.map((a,i)=>attendeeCard(i)).join('');
  bindAttendeeInputs();
}

/* FIX: don’t add if container missing */
function addAttendee(){
  if(!document.getElementById('attendee-list')) return;
  STATE.attendees.push({name:'',email:'',title:'',selections:[], registration:false});
  renderAttendees();
}

function removeAttendee(i){
  STATE.attendees.splice(i,1);
  renderAttendees();
  updateTotal();
}

/**
 * FIX: Used nullish coalescing (|| {}) to ensure selections[ev] is an object before setting a property.
 * This prevents the original "Cannot set properties of null" error.
 */
function bindAttendeeInputs(){
  document.querySelectorAll('.a-name').forEach(el=>el.addEventListener('input',e=>{const i=Number(e.target.getAttribute('data-i')); STATE.attendees[i].name=e.target.value;}));
  document.querySelectorAll('.a-email').forEach(el=>el.addEventListener('input',e=>{const i=Number(e.target.getAttribute('data-i')); STATE.attendees[i].email=e.target.value;}));
  document.querySelectorAll('.a-title').forEach(el=>el.addEventListener('input',e=>{const i=Number(e.target.getAttribute('data-i')); STATE.attendees[i].title=e.target.value;}));
  document.querySelectorAll('.ticket').forEach(sel=>sel.addEventListener('change',e=>{
    const i=Number(e.target.getAttribute('data-i'));
    const ev=Number(e.target.getAttribute('data-ev'));
    const [h,c]=e.target.value?e.target.value.split('|'):[null,0]; 
    
    // FIX APPLIED HERE
    STATE.attendees[i].selections[ev] = STATE.attendees[i].selections[ev] || {}; 
    
    STATE.attendees[i].selections[ev].handle=h; 
    STATE.attendees[i].selections[ev].price_cents=Number(c||0); 
    updateTotal();
  }));
  document.querySelectorAll('.meal').forEach(sel=>sel.addEventListener('change',e=>{
    const i=Number(e.target.getAttribute('data-i'));
    const ev=Number(e.target.getAttribute('data-ev')); 
    
    // FIX APPLIED HERE
    STATE.attendees[i].selections[ev] = STATE.attendees[i].selections[ev] || {}; 
    
    STATE.attendees[i].selections[ev].meal=e.target.value;
    updateTotal();
  }));
  document.querySelectorAll('.diet').forEach(inp=>inp.addEventListener('input',e=>{
    const i=Number(e.target.getAttribute('data-i'));
    const ev=Number(e.target.getAttribute('data-ev')); 
    
    // FIX APPLIED HERE
    STATE.attendees[i].selections[ev] = STATE.attendees[i].selections[ev] || {}; 
    
    STATE.attendees[i].selections[ev].dietary=e.target.value;
    updateTotal();
  }));
  document.querySelectorAll('.a-register').forEach(chk=>{
    const box=chk.closest('.reg-box'); const i=Number(chk.getAttribute('data-i'));
    const sync=()=>{ STATE.attendees[i].registration=!!chk.checked; if(box) box.classList.toggle('active',chk.checked); updateTotal(); };
    chk.addEventListener('change',sync); sync();
  });
}

function updateTotal(){
  let total=0, feeTotal=0;
  const lines=[];
  const pushLine=(label,cents)=>{lines.push(`<li class="line" style="display:flex;justify-content:space-between;gap:1rem;"><span>${label}</span><strong>${money(cents)}</strong></li>`);};

  const evs=STATE.banquets.events||[];
  STATE.attendees.forEach(a=>{
    (a.selections||[]).forEach((sel,evIdx)=>{
      if(sel?.handle){
        const ev=evs[evIdx];
        const t=(ev?.tickets||[]).find(x=>x.handle===sel.handle);
        const label=`${a.name||'Attendee'} — ${ev?.title||'Event'} — ${(t?.label)||'Ticket'}`;
        const base=Number(sel.price_cents||t?.price_cents||0);
        const fee =surchargeOf(base);
        const line=base+fee;
        feeTotal+=fee; total+=line; pushLine(label,line);
      }
    });
  });

  const regCents=regPriceCents();
  if(regCents>0){
    STATE.attendees.forEach(a=>{
      if(a.registration){
        const base=regCents, fee=surchargeOf(base), line=base+fee;
        feeTotal+=fee; total+=line; pushLine(`${a.name||'Attendee'} — Registration`, line);
      }
    });
  }

  const items=STATE.products.items||[];
  items.forEach(p=>{
    const q=Number(STATE.store[p.handle]||0);
    if(q>0){
      for(let i=0;i<q;i++){
        const base=Number(p.price_cents||0), fee=surchargeOf(base), line=base+fee;
        feeTotal+=fee; total+=line;
        let label=p.name;
        if(p.handle==='corsage' && STATE.storeNotes['corsage']) label+=` — ${STATE.storeNotes['corsage']}`;
        pushLine(label,line);
      }
    }
  });

  const dn=document.getElementById('donation-amount');
  const dnCents=dn?Math.max(0,Math.round(Number(dn.value||0)*100)):0;
  if(dnCents>0){
    const fee=surchargeOf(dnCents), line=dnCents+fee;
    feeTotal+=fee; total+=line; pushLine('Extra Donation', line);
  }

  const el=document.getElementById('order-total'); if(el) el.textContent=money(total);
  const linesEl=document.getElementById('order-lines');
  if(linesEl){ linesEl.innerHTML = lines.length?`<ul style="list-style:none;padding:0;margin:.5rem 0 0 0;">${lines.join('')}</ul>`:`<div class="tiny">No items selected yet.</div>`; }

  const feesEl=document.getElementById('fees-line');
  if(feesEl){
    const s=STATE.settings?.surcharge||{};
    if(s.enabled && feeTotal>0){
      feesEl.innerHTML=`<strong>Fees added:</strong> ${money(feeTotal)} <span class="tiny">(card processing)</span>`;
    }else if(s.enabled){
      feesEl.textContent='Fees added: $0.00';
    }else{
      feesEl.textContent='No card processing fee added to customer total.';
    }
  }
}

async function checkout(){
  const purchaser={
    name:document.getElementById('p_name')?.value.trim()||'',
    title:document.getElementById('p_title')?.value.trim()||'',
    email:document.getElementById('p_email')?.value.trim()||'',
    phone:document.getElementById('p_phone')?.value.trim()||'',
    address:{
      line1:document.getElementById('p_addr1')?.value.trim()||'',
      line2:document.getElementById('p_addr2')?.value.trim()||'',
      city:document.getElementById('p_city')?.value.trim()||'',
      state:document.getElementById('p_state')?.value.trim()||'',
      postal_code:document.getElementById('p_zip')?.value.trim()||'',
      country:document.getElementById('p_country')?.value.trim()||''
    }
  };
  if(!purchaser.name||!purchaser.email||!purchaser.phone||!purchaser.address.line1||!purchaser.address.city||!purchaser.address.state||!purchaser.address.postal_code||!purchaser.address.country){
    alert('Please complete purchaser info.'); return;
  }
  const dn=document.getElementById('donation-amount');
  const extra_donation_cents=dn?Math.max(0,Math.round(Number(dn.value||0)*100)):0;

  const priceMap={}; (STATE.products.items||[]).forEach(p=>{priceMap[p.handle]=Number(p.price_cents||0);});

  const body={ 
    org:STATE.org,
    order:{
      purchaser,
      attendees:STATE.attendees,
      store:STATE.store,
      store_notes:STATE.storeNotes,
      extra_donation_cents,
      store_price_cents_map:priceMap
    }
  };

  try{
    const res=await fetch('/api/create-checkout-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await res.json();
    if(!res.ok){ alert('Server error: '+(d.error||res.statusText)); return; }
    if(!d.url) throw new Error(d.error||'Checkout failed');
    location.href=d.url;
  }catch(e){ alert(e.message); }
}

/* ===== boot ===== */
document.addEventListener('DOMContentLoaded',()=>{
  const org=currentOrg();
  if(org) document.body.setAttribute('data-org', org);

  renderGroupHome();
  renderBanquets();
  renderDirectory();
  renderShop();
  renderOrder();
});
