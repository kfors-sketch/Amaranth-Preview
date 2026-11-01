import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { renderOrderEmailHTML } from "../api/admin/core/receipts-render.js";
import { calculateProcessingFeeCents, resolveCheckoutLines } from "../api/admin/checkout-pricing.js";
import { authorizeDebugRoute, DEBUG_ROUTE_TYPES } from "../api/admin/debug-auth.js";
import {
  authorizeTestEmail,
  recordTestEmailAudit,
  sendApprovedTestEmail,
} from "../api/admin/test-email-security.js";
import { runScheduledReport } from "../api/cron/security.js";
import {
  createManualOrderOnly,
  authorizeManualMutation,
  findForbiddenStripeField,
  normalizeManualPaymentMethod,
  recordManualOrderAudit,
} from "../api/admin/manual-order-security.js";
import { enforcePublicFormRateLimit, validateContactInput, validateSuppliesInput } from "../api/admin/public-form-security.js";

test("full receipt renderer retains all currently rendered order sections and totals", () => {
  const order = {
    id: "cs_test_receipt_fixture",
    created: Date.UTC(2027, 5, 1),
    currency: "usd",
    amount_total: 15150,
    customer_email: "buyer@example.test",
    purchaser: {
      name: "Receipt Buyer",
      email: "buyer@example.test",
      phone: "555-0100",
      title: "Grand Representative",
      address1: "1 Test Way",
      city: "Hershey",
      state: "PA",
      postal: "17033",
      country: "US",
    },
    lines: [
      {
        id: "banquet-line",
        itemId: "banquet-fixture",
        itemName: "Banquet Fixture",
        category: "banquet",
        qty: 1,
        unitPrice: 7500,
        gross: 7500,
        attendeeId: "attendee-1",
        attendeeName: "Attendee Example",
        attendeeEmail: "attendee@example.test",
        meta: {
          attendeeName: "Attendee Example",
          attendeeTitle: "Royal Matron",
          attendeePhone: "555-0101",
          attendeeEmail: "attendee@example.test",
          attendeeCourt: "Test Court",
          attendeeCourtNumber: "101",
          dietaryNote: "Vegetarian",
          itemNote: "Banquet note",
        },
      },
      {
        id: "addon-line",
        itemId: "addon-fixture",
        itemName: "Add-On Fixture",
        category: "addon",
        qty: 1,
        unitPrice: 2500,
        gross: 2500,
        meta: { itemNote: "Add-on note" },
      },
      {
        id: "tour-line",
        itemId: "tour-fixture",
        itemName: "Tour Fixture",
        category: "tour",
        qty: 1,
        unitPrice: 5000,
        gross: 5000,
        meta: {
          itemNote: "Tour note",
          transportationPickup: "Hotel lobby",
          transportationDropoff: "Tour venue",
        },
      },
      {
        id: "fee-line",
        itemId: "processing-fee",
        itemName: "Online Processing Fee",
        category: "fee",
        qty: 1,
        unitPrice: 150,
        gross: 150,
        meta: { itemType: "fee" },
      },
    ],
    fees: { pct: 2.9, flat: 30 },
    status: "paid",
  };

  const html = renderOrderEmailHTML(order);
  for (const expected of [
    "cs_test_receipt_fixture",
    "Receipt Buyer",
    "buyer@example.test",
    "Attendee Example",
    "Vegetarian",
    "Banquet Fixture",
    "Add-On Fixture",
    "Tour Fixture",
    "Online Processing Fee",
    "$151.50",
  ]) assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("public success page uses only scoped customer receipt access", () => {
  const source = fs.readFileSync(new URL("../success.html", import.meta.url), "utf8");
  const activePrefix = source.slice(0, source.indexOf("if (!sid || !receiptToken)"));
  assert.match(activePrefix, /type=customer_receipt/);
  assert.match(activePrefix, /receipt_token/);
});

test("saved order requires Stripe paid status", () => {
  const source = fs.readFileSync(new URL("../api/admin/order-utils.js", import.meta.url), "utf8");
  assert.match(source, /payment_status !== "paid"/);
  assert.match(source, /checkout-session-not-paid/);
});

test("automatic receipt email uses an atomic single-send claim", () => {
  const source = fs.readFileSync(new URL("../api/admin/order-lifecycle.js", import.meta.url), "utf8");
  assert.match(source, /kv\.set\(key, "sending", \{ nx: true/);
  assert.match(source, /customerReceiptSent/);
});

test("generic order and receipt routes are admin protected", () => {
  const source = fs.readFileSync(new URL("../api/admin/orders-router.js", import.meta.url), "utf8");
  assert.match(source, /"order_receipt_html"/);
  assert.match(source, /await requireAdminAuth\(req, res\)/);
  assert.match(source, /timingSafeEqual/);
});

const commonMeta = {
  attendeeName: "Test Attendee",
  attendeeTitle: "Royal Matron",
  attendeePhone: "555-0101",
  attendeeEmail: "attendee@example.test",
  attendeeCourt: "Test Court",
  attendeeCourtNumber: "101",
  attendeeNotes: "Current note",
  dietaryNote: "Vegetarian",
  slotKey: "unchanged-slot",
  slotLabel: "Unchanged Slot",
};

function assertCompatible(oldLine, newLine, expectedPrice) {
  assert.equal(newLine.unitPrice, expectedPrice);
  assert.equal(newLine.itemId, oldLine.itemId);
  assert.equal(newLine.itemName, oldLine.itemName);
  assert.equal(newLine.itemType, oldLine.itemType);
  assert.equal(newLine.qty, oldLine.qty);
  assert.deepEqual(newLine.meta, oldLine.meta);
}

test("banquet price and reporting metadata match legacy checkout", () => {
  const oldLine = { itemId:"banquet-1", itemType:"banquet", itemName:"Banquet One (Vegetarian)", qty:1, unitPrice:60, meta:{...commonMeta, decorationFee:1.5, hotelAmount:58.5} };
  const [line] = resolveCheckoutLines({ lines:[oldLine], catalogs:{ banquet:[{id:"banquet-1",name:"Banquet One",price:60,active:true}] } });
  assertCompatible(oldLine, line, 60);
});

test("add-on fixed and variant prices match legacy checkout", () => {
  const fixed = { itemId:"addon-1", itemType:"addon", itemName:"Add-On One", qty:1, unitPrice:25, meta:{...commonMeta} };
  const variant = { itemId:"corsage", itemType:"addon", itemName:"Corsage (Rose)", qty:1, unitPrice:30, meta:{...commonMeta,variantId:"rose",corsageChoice:"Rose",corsageWear:"Wrist",itemNote:"Red"} };
  const out = resolveCheckoutLines({ lines:[fixed,variant], catalogs:{ addon:[{id:"addon-1",price:25,active:true},{id:"corsage",price:20,active:true,variants:[{id:"rose",label:"Rose",price:30}]}] } });
  assertCompatible(fixed,out[0],25); assertCompatible(variant,out[1],30);
});

test("tour price and attendee/report fields match legacy checkout", () => {
  const oldLine={itemId:"tour-1",itemType:"tour",itemName:"Tour One",qty:1,unitPrice:50,meta:{...commonMeta,category:"tour",tourDateTime:"2027-06-01",location:"Lobby",accessibility:"Wheelchair"}};
  const [line]=resolveCheckoutLines({lines:[oldLine],catalogs:{tour:[{id:"tour-1",price:50,active:true,limitPerAttendee:1}]}});
  assertCompatible(oldLine,line,50);
});

test("transportation fixed and donation rules preserve payload", () => {
  const oldLine={itemId:"transport-1",itemType:"addon",itemName:"Transportation",qty:1,unitPrice:20,meta:{category:"transportation",transportation:{passengerCount:2,pickup:{needed:true}},paymentMode:"donation"}};
  const [line]=resolveCheckoutLines({lines:[oldLine],catalogs:{addon:[{id:"transport-1",type:"transportation",priceMode:"donation",minDonation:10,active:true}]}});
  assertCompatible(oldLine,line,20);
  assert.throws(()=>resolveCheckoutLines({lines:[{...oldLine,unitPrice:5}],catalogs:{addon:[{id:"transport-1",priceMode:"donation",minDonation:10,active:true}]}}),/amount-below-minimum/);
});

test("catalog price and highest once-per-order shipping match legacy checkout", () => {
  const a={itemId:"product-a",itemType:"catalog",itemName:"Product A",qty:2,unitPrice:25,meta:{category:"catalog"}};
  const b={itemId:"product-b",itemType:"catalog",itemName:"Product B",qty:1,unitPrice:40,meta:{category:"catalog"}};
  const out=resolveCheckoutLines({lines:[a,b,{itemId:"shipping",itemType:"shipping",itemName:"Shipping & Handling",qty:1,unitPrice:999,meta:{}}],catalogs:{catalog:[{id:"product-a",price:25,shippingCents:550,active:true},{id:"product-b",price:40,shippingCents:750,active:true}]}});
  assertCompatible(a,out[0],25); assertCompatible(b,out[1],40);
  assert.deepEqual(out[2],{id:"shipping",itemId:"shipping",itemType:"shipping",itemName:"Shipping & Handling",unitPrice:7.5,qty:1,attendeeId:"",priceMode:"flat",bundleQty:"",bundleTotalCents:"",meta:{}});
});

test("customer-entered donation is accepted only within configured rules", () => {
  const line={itemId:"love-gift",itemType:"addon",itemName:"Love Gift — $25.00",qty:1,unitPrice:25,meta:{...commonMeta,itemNote:"Love gift"}};
  const [resolved]=resolveCheckoutLines({lines:[line],catalogs:{addon:[{id:"love-gift",name:"Love Gift",type:"amount",priceMode:"donation",minAmount:1,active:true}]}});
  assertCompatible(line,resolved,25);
});

test("manual/group orders remain outside public checkout pricing", () => {
  assert.throws(()=>resolveCheckoutLines({lines:[{itemId:"manual",itemType:"manual",itemName:"Manual",qty:1,unitPrice:10}],catalogs:{}}),/unknown-item/);
});

test("server processing fee matches the existing 2.9 percent plus 30 cent gross-up", () => {
  const subtotalCents = 15000;
  const legacy = Math.max(0, Math.ceil((subtotalCents + 30) / (1 - 0.029)) - subtotalCents);
  assert.equal(calculateProcessingFeeCents(subtotalCents, 2.9, 0.30), legacy);
});

test("legacy caller-supplied item prices cannot bypass the authoritative resolver", () => {
  const source = fs.readFileSync(new URL("../api/admin/checkout-router.js", import.meta.url), "utf8");
  assert.match(source, /server-priced-lines-required/);
  assert.doesNotMatch(source, /unit_amount:\s*dollarsToCents\(it\.price/);
});

test("unsafe legacy order-save endpoint is no longer deployable", () => {
  assert.equal(fs.existsSync(new URL("../api/orders/save.js", import.meta.url)), false);
});

test("current Stripe, receipt, report, YOY, and manual paths do not reference legacy order-save", () => {
  const roots = ["api", "admin", "assets"];
  const scan = (path) => {
    const full = new URL(`../${path}`, import.meta.url);
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return scan(child);
      if (!/\.(?:js|html)$/.test(entry.name)) return [];
      return [[child, fs.readFileSync(new URL(`../${child}`, import.meta.url), "utf8")]];
    });
  };
  const references = roots.flatMap(scan).filter(([, source]) => /\/api\/orders\/save/.test(source));
  assert.deepEqual(references, []);

  assert.match(fs.readFileSync(new URL("../api/admin/webhook-router.js", import.meta.url), "utf8"), /saveOrderFromSession/);
  assert.match(fs.readFileSync(new URL("../api/admin/order-utils.js", import.meta.url), "utf8"), /orders:index/);
  assert.match(fs.readFileSync(new URL("../api/admin/manual-orders-router.js", import.meta.url), "utf8"), /create_manual_order/);
  assert.match(fs.readFileSync(new URL("../api/admin/manual-orders-router.js", import.meta.url), "utf8"), /manual_orders:index/);
  assert.match(fs.readFileSync(new URL("../api/admin/yearly-reports.js", import.meta.url), "utf8"), /orders:index/);
});

for (const type of DEBUG_ROUTE_TYPES) {
  test(`${type} rejects unauthenticated access without debug output`, async () => {
    const replies = [];
    const res = {
      status(code) { replies.push({ code }); return this; },
      json(body) { replies[replies.length - 1].body = body; return this; },
    };
    const result = await authorizeDebugRoute({
      type, req: {}, res,
      requireAdminAuth: async (_req, response) => {
        response.status(401).json({ error: "unauthorized" });
        return false;
      },
    });
    assert.deepEqual(result, { handled: true, authorized: false });
    assert.deepEqual(replies, [{ code: 401, body: { error: "unauthorized" } }]);
  });

  test(`${type} permits valid admin authentication`, async () => {
    const result = await authorizeDebugRoute({
      type, req: {}, res: {}, requireAdminAuth: async () => true,
    });
    assert.deepEqual(result, { handled: true, authorized: true });
  });
}

test("debug pages redirect missing or expired sessions to the correct login", () => {
  const guard = fs.readFileSync(new URL("../assets/js/admin-debug-auth.js", import.meta.url), "utf8");
  assert.match(guard, /\/admin\/reporting_login\.html/);
  assert.match(guard, /response\.status === 401/);
  for (const page of ["debug.html", "debug2.html", "debug3.html"]) {
    const html = fs.readFileSync(new URL(`../admin/${page}`, import.meta.url), "utf8");
    assert.match(html, /admin-debug-auth\.js/);
  }
});

test("the debug-page test email action requires administrator authentication", () => {
  const source = fs.readFileSync(new URL("../api/admin/auth-router.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf('if (action === "test_resend")'));
  assert.match(block, /authorizeTestEmail\(\{ req, res, body, requireAdminAuth, kv \}\)/);
});

function fakeTestEmailKv() {
  const counts = new Map();
  const logs = [];
  return {
    logs,
    async incr(key) { const next = (counts.get(key) || 0) + 1; counts.set(key, next); return next; },
    async expire() {},
    async lpush(_key, entry) { logs.unshift(entry); },
    async ltrim() {},
  };
}

function fakeResponse() {
  return {
    code: null, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("test email rejects no or invalid administrator token with 401", async () => {
  for (const authResult of [false, false]) {
    const res = fakeResponse();
    const result = await authorizeTestEmail({
      req:{headers:{}}, res, body:{to:"approved@example.test"}, kv:fakeTestEmailKv(),
      env:{TEST_EMAIL_ALLOWLIST:"approved@example.test"},
      requireAdminAuth:async(_req,response)=>{response.status(401).json({error:"unauthorized"});return authResult;},
    });
    assert.equal(result.ok,false); assert.equal(res.code,401);
  }
});

test("valid admin with unapproved test recipient receives 403 and no fallback", async () => {
  const res=fakeResponse();
  const result=await authorizeTestEmail({req:{headers:{authorization:"Bearer valid"}},res,body:{},kv:fakeTestEmailKv(),env:{TEST_EMAIL_ALLOWLIST:"approved@example.test",REPORTS_CC:"report@example.test"},requireAdminAuth:async()=>true});
  assert.equal(result.ok,false); assert.equal(res.code,403); assert.equal(result.recipient,undefined);
});

test("approved admin test email sends exactly once through mocked Resend and audits metadata", async () => {
  const kv=fakeTestEmailKv(), res=fakeResponse();
  const access=await authorizeTestEmail({req:{headers:{authorization:"Bearer valid","x-forwarded-for":"127.0.0.1"}},res,body:{to:"APPROVED@example.test"},kv,env:{TEST_EMAIL_ALLOWLIST:"approved@example.test"},requireAdminAuth:async()=>true});
  assert.equal(access.ok,true); assert.equal(access.recipient,"approved@example.test");
  const calls=[];
  const resend={emails:{send:async(payload)=>{calls.push(payload);return{id:"mock-message"};}}};
  const payload={to:[access.recipient],subject:"[TEST] administrator test",html:"test only"};
  const sent=await sendApprovedTestEmail({resend,payload});
  assert.equal(calls.length,1); assert.equal(sent.id,"mock-message");
  await recordTestEmailAudit({kv,admin:access.admin,recipient:access.recipient,status:"queued",resultId:sent.id});
  assert.equal(kv.logs.length,1); assert.deepEqual(Object.keys(kv.logs[0]).sort(),["action","administrator","date","recipient","resultId","status"].sort());
});

test("rapid repeated approved test-email attempts return 429", async () => {
  const kv=fakeTestEmailKv();
  let last;
  for(let i=0;i<6;i+=1){const res=fakeResponse();last={res,result:await authorizeTestEmail({req:{headers:{authorization:"Bearer valid","x-forwarded-for":"127.0.0.1"}},res,body:{to:"approved@example.test"},kv,env:{TEST_EMAIL_ALLOWLIST:"approved@example.test"},requireAdminAuth:async()=>true})};}
  assert.equal(last.result.ok,false); assert.equal(last.res.code,429);
});

function fakeCronKv() {
  const values = new Map();
  return {
    values,
    async get(key){return values.get(key)||null;},
    async set(key,value,options){if(options?.nx&&values.has(key))return null;values.set(key,value);return "OK";},
    async del(key){values.delete(key);},
  };
}

function cronResponse(){return{code:null,body:null,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}

const cronEnv={CRON_SECRET:"cron-secret",REPORT_TOKEN:"router-token",SITE_BASE_URL:"https://trusted.example"};
const cronReq=(authorization,host="attacker.example")=>({method:"GET",headers:{authorization,host}});

test("scheduled report rejects anonymous, invalid, and missing configured secrets", async()=>{
  for(const [req,env] of [[cronReq(""),cronEnv],[cronReq("Bearer wrong"),cronEnv],[cronReq("Bearer cron-secret"),{...cronEnv,CRON_SECRET:""}]]){
    const res=cronResponse();await runScheduledReport({kind:"monthly",action:"send_monthly_chair_reports",req,res,kv:fakeCronKv(),env,fetchImpl:async()=>{throw new Error("must not fetch");}});assert.equal(res.code,401);
  }
});

test("valid scheduled report sends once, hides details, and ignores incoming Host",async()=>{
  const kv=fakeCronKv(),urls=[];
  const fetchImpl=async(url,options)=>{urls.push({url,options});return{ok:true,status:200,json:async()=>({ok:true,sent:2,recipients:["secret@example.test"],attachments:["secret.xlsx"]})};};
  const first=cronResponse();await runScheduledReport({kind:"monthly",action:"send_monthly_chair_reports",req:cronReq("Bearer cron-secret"),res:first,kv,env:cronEnv,fetchImpl,now:new Date("2027-06-15T00:00:00Z")});
  const second=cronResponse();await runScheduledReport({kind:"monthly",action:"send_monthly_chair_reports",req:cronReq("Bearer cron-secret"),res:second,kv,env:cronEnv,fetchImpl,now:new Date("2027-06-20T00:00:00Z")});
  assert.equal(urls.length,1);assert.match(urls[0].url,/^https:\/\/trusted\.example\/api\/router/);assert.doesNotMatch(urls[0].url,/attacker/);assert.deepEqual(first.body,{ok:true,period:"2027-06"});assert.equal(second.body.skipped,"already-complete");assert.equal(JSON.stringify(first.body).includes("secret@example"),false);
});

test("failed scheduled report is retryable and uses separate monthly/closing keys",async()=>{
  const kv=fakeCronKv();let calls=0;
  const fetchImpl=async()=>{calls+=1;return calls===1?{ok:false,status:500,json:async()=>({ok:false})}:{ok:true,status:200,json:async()=>({ok:true,errors:0})};};
  const one=cronResponse();await runScheduledReport({kind:"closing",action:"send_end_of_event_reports",req:cronReq("Bearer cron-secret"),res:one,kv,env:cronEnv,fetchImpl,now:new Date("2027-06-15T00:00:00Z")});
  const two=cronResponse();await runScheduledReport({kind:"closing",action:"send_end_of_event_reports",req:cronReq("Bearer cron-secret"),res:two,kv,env:cronEnv,fetchImpl,now:new Date("2027-06-15T01:00:00Z")});
  assert.equal(one.code,500);assert.equal(two.code,200);assert.equal(calls,2);assert.ok(kv.values.has("cron:closing:2027-06-15:complete"));assert.equal(kv.values.has("cron:monthly:2027-06:complete"),false);
});

test("cron accepts only GET and browser parameters cannot override recipients",async()=>{
  const res=cronResponse();await runScheduledReport({kind:"monthly",action:"send_monthly_chair_reports",req:{method:"POST",headers:{authorization:"Bearer cron-secret"},body:{to:"attacker@example.test"}},res,kv:fakeCronKv(),env:cronEnv,fetchImpl:async()=>{throw new Error("must not fetch");}});assert.equal(res.code,405);
  const source=fs.readFileSync(new URL("../api/cron/security.js",import.meta.url),"utf8");assert.doesNotMatch(source,/body\?\.to|searchParams\.get\("to"\)/);
});

test("legacy report senders are archived and current report actions remain",()=>{
  assert.equal(fs.existsSync(new URL("../api/admin/send-full.js",import.meta.url)),false);assert.equal(fs.existsSync(new URL("../api/admin/send-month-to-date.js",import.meta.url)),false);
  const reports=fs.readFileSync(new URL("../api/admin/reports-router.js",import.meta.url),"utf8");for(const action of ["send_item_report","send_monthly_chair_reports","send_end_of_event_reports","send_test_chair_reports"]){assert.match(reports,new RegExp(action));}
});

test("manual order handler independently requires administrator authentication",()=>{
  const source=fs.readFileSync(new URL("../api/admin/manual-orders-router.js",import.meta.url),"utf8");assert.match(source,/authorizeManualMutation/);
});

test("manual mutation rejects no/invalid admin token and accepts a valid admin",async()=>{
  const res=fakeResponse();assert.equal(await authorizeManualMutation({req:{},res,requireAdminAuth:async(_req,response)=>{response.status(401).json({error:"unauthorized"});return false;}}),false);assert.equal(res.code,401);
  assert.equal(await authorizeManualMutation({req:{},res:{},requireAdminAuth:async()=>true}),true);
});

test("manual payments reject Stripe/card and accept legitimate offline methods",()=>{
  for(const denied of ["stripe","card"]){assert.throws(()=>normalizeManualPaymentMethod(denied),/stripe-payment-not-allowed/);}
  for(const allowed of ["check","cash","mail","complimentary","external-card","offline-card","other"]){assert.ok(normalizeManualPaymentMethod(allowed));}
});

test("manual input cannot supply Stripe identifiers or verification fields",()=>{
  for(const body of [{paymentIntent:"pi_fake"},{session_id:"cs_fake"},{chargeId:"ch_fake"},{stripeVerified:true},{webhookStatus:"paid"},{refundStatus:"refunded"}]){assert.ok(findForbiddenStripeField(body));}
  assert.equal(findForbiddenStripeField({purchaser:{name:"Safe"},lines:[{itemId:"meal"}]}),null);
});

test("manual order storage is create-only and retries an ID collision without overwrite",async()=>{
  const stored=new Map([["order:manual_collision",{historical:true}]]),writes=[];
  const kv={async set(key,value,options){writes.push({key,value,options});if(stored.has(key))return null;stored.set(key,value);return "OK";}};
  const result=await createManualOrderOnly({kv,order:{id:"manual_collision",idPrefix:"manual_test",lines:[{itemId:"meal"}]}});
  assert.notEqual(result.id,"manual_collision");assert.deepEqual(stored.get("order:manual_collision"),{historical:true});assert.equal(writes.every(w=>w.options?.nx===true),true);
});

test("manual order audit stores provenance metadata without receipt content",async()=>{
  const logs=[];const kv={async lpush(_key,value){logs.push(value);},async ltrim(){}};
  await recordManualOrderAudit({kv,action:"create",order:{id:"manual_test"},administrator:"Admin User"});
  assert.equal(logs[0].source,"admin-manual");assert.equal(logs[0].stripeVerified,false);assert.equal("lines" in logs[0],false);
});

test("manual order schema preserves receipt, export, chair, and YOY compatibility fields",()=>{
  const source=fs.readFileSync(new URL("../api/admin/manual-orders-router.js",import.meta.url),"utf8");
  for(const field of ["lines","items","line_items","amount_total","attendeeName","itemId","itemName","category","qty","unitPrice","decorationFeeTotal","hotelAmount","orders:index","manual_orders:index","enteredAt","stripeVerified"]){assert.match(source,new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));}
  assert.match(source,/orderSource: "admin-manual"/);assert.match(source,/payment_intent: ""/);assert.match(source,/charge: ""/);
});

test("report item registration authenticates before reading input or writing KV",()=>{
  const source=fs.readFileSync(new URL("../api/admin/reports-router.js",import.meta.url),"utf8");
  const start=source.indexOf('if (action === "register_item")');
  const end=source.indexOf('if (action === "set_reporting_channel")',start);
  const block=source.slice(start,end);
  const authAt=block.indexOf("requireAdminAuth(req, res)");
  const writeAt=block.indexOf("kvHsetSafe");
  assert.ok(authAt>=0);assert.ok(writeAt>authAt);
  assert.match(block,/enforceLockdownIfNeeded\(req, res, "register_item", requestId\)/);
});

test("GET report preview/send authenticates before reading query parameters or generating output",()=>{
  const source=fs.readFileSync(new URL("../api/admin/reports-router.js",import.meta.url),"utf8");
  const start=source.indexOf('if (req.method === "GET" && type === "send_item_report")');
  const end=source.indexOf('if (req.method !== "POST")',start);
  const block=source.slice(start,end);
  const authAt=block.indexOf("requireAdminAuth(req, res)");
  const queryAt=block.indexOf("url.searchParams.get");
  const previewAt=block.indexOf("handleChairPreview");
  assert.ok(authAt>=0);assert.ok(queryAt>authAt);assert.ok(previewAt>authAt);
  assert.match(block,/enforceLockdownIfNeeded\(req, res, "send_item_report", requestId\)/);
});

test("POST report send authenticates before reading body or sending email",()=>{
  const source=fs.readFileSync(new URL("../api/admin/reports-router.js",import.meta.url),"utf8");
  const start=source.indexOf('if (action === "send_item_report")');
  const end=source.indexOf('if (action === "register_item")',start);
  const block=source.slice(start,end);
  const authAt=block.indexOf("requireAdminAuth(req, res)");
  const bodyAt=block.indexOf("body?.kind");
  const sendAt=block.indexOf("sendItemReportEmailInternal");
  assert.ok(authAt>=0);assert.ok(bodyAt>authAt);assert.ok(sendAt>authAt);
  assert.match(block,/enforceLockdownIfNeeded\(req, res, "send_item_report", requestId\)/);
});

test("all YOY aggregate routes authenticate before reading indexes, query input, or KV",()=>{
  const source=fs.readFileSync(new URL("../api/admin/yoy-router.js",import.meta.url),"utf8");
  const authAt=source.indexOf("protectedTypes.has(type)");
  const firstYearReadAt=source.indexOf("await listIndexedYears()",authAt);
  const firstQueryReadAt=source.indexOf("url.searchParams",authAt);
  const firstKvReadAt=source.indexOf("await kvGetSafe",authAt);
  assert.ok(authAt>=0);
  assert.match(source,/"year_index"[\s\S]*"years_index"[\s\S]*"year_summary"[\s\S]*"year_multi"[\s\S]*"catalog_items_yoy"/);
  assert.match(source.slice(authAt,firstYearReadAt),/await requireAdminAuth\(req, res\)/);
  assert.ok(firstQueryReadAt>authAt);
  assert.ok(firstKvReadAt>authAt);
});

test("public settings expose only maintenance UI fields and protect operational details",()=>{
  const source=fs.readFileSync(new URL("../api/admin/settings-router.js",import.meta.url),"utf8");
  const start=source.indexOf('if (type === "settings")');
  const end=source.indexOf('if (type === "feature_flags")',start);
  const block=source.slice(start,end);
  const publicReturn=block.indexOf("if (!authHeader)");
  const authAt=block.indexOf("requireAdminAuth(req, res)");
  const lockdownAt=block.indexOf("getLockdownStateSafe",authAt);
  assert.ok(publicReturn>=0);
  assert.ok(authAt>publicReturn);
  assert.ok(lockdownAt>authAt);
  const publicBlock=block.slice(publicReturn,authAt);
  assert.match(publicBlock,/MAINTENANCE_ON/);
  assert.match(publicBlock,/MAINTENANCE_MESSAGE/);
  for(const secret of ["overrides","effective:","lockdown","RESEND_FROM","REPORTS_CC","REPLY_TO"]){assert.doesNotMatch(publicBlock,new RegExp(secret));}
});

test("checkout mode authenticates before reading payment-channel configuration",()=>{
  const source=fs.readFileSync(new URL("../api/admin/settings-router.js",import.meta.url),"utf8");
  const start=source.indexOf('if (type === "checkout_mode")');
  const end=source.indexOf("return false;",start);
  const block=source.slice(start,end);
  const authAt=block.indexOf("requireAdminAuth(req, res)");
  const settingsAt=block.indexOf("getCheckoutSettingsAuto");
  const channelAt=block.indexOf("getEffectiveOrderChannel");
  assert.ok(authAt>=0);
  assert.ok(settingsAt>authAt);
  assert.ok(channelAt>authAt);
});

test("public contact validation rejects bots, invalid email, oversized fields, and oversized bodies",()=>{
  const good={name:"Test User",email:"test@example.test",topic:"general",message:"Synthetic test"};
  assert.ok(validateContactInput(good).value);
  assert.equal(validateContactInput({...good,website:"bot"}).error,"bot-detected");
  assert.equal(validateContactInput({...good,email:"invalid"}).error,"invalid-fields");
  assert.equal(validateContactInput({...good,message:"x".repeat(4001)}).error,"invalid-fields");
  assert.equal(validateContactInput({...good,padding:"x".repeat(17000)}).error,"invalid-body");
});

test("supplies request validation bounds all fields and requires a valid address",()=>{
  const good={item:{id:"s1",name:"Synthetic item",category:"supplies"},purchaser:{name:"Test User",email:"test@example.test",phone:"555-0100",courtName:"Test Court",courtNumber:"1"},notes:"Synthetic test"};
  assert.ok(validateSuppliesInput(good).value);
  assert.equal(validateSuppliesInput({...good,company:"bot"}).error,"bot-detected");
  assert.equal(validateSuppliesInput({...good,purchaser:{...good.purchaser,email:"bad"}}).error,"invalid-fields");
  assert.equal(validateSuppliesInput({...good,notes:"x".repeat(2001)}).error,"invalid-fields");
});

test("public form rate limiting allows five attempts and rejects rapid repeats without email",async()=>{
  let count=0,expires=0;const store={async incr(){return ++count;},async expire(){expires++;}};
  const req={headers:{"x-forwarded-for":"192.0.2.1"}};
  for(let i=0;i<5;i++) assert.equal((await enforcePublicFormRateLimit(store,req,"test")).ok,true);
  assert.equal((await enforcePublicFormRateLimit(store,req,"test")).ok,false);
  assert.equal(expires,1);
  assert.equal((await enforcePublicFormRateLimit(null,req,"test")).unavailable,true);
});

test("known broken public and administrator routes use existing destinations",()=>{
  const files=["admin/addons.html","admin/catalog.html","admin/charity.html","admin/settings.html","admin/tours.html","contact-2.html","product-catalog.html","shop-cart.html","index.html"];
  const joined=files.map((file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8")).join("\n");
  assert.doesNotMatch(joined,/\/admin\/login\.html/);
  assert.doesNotMatch(joined,/supreme-addons\.html/);
  assert.doesNotMatch(joined,/href=["']\/linda\//);
  assert.match(joined,/\/admin\/reporting_login\.html/);
  assert.match(joined,/grand-court-addons\.html/);
  assert.equal(fs.existsSync(new URL("../admin/reporting_login.html",import.meta.url)),true);
  assert.equal(fs.existsSync(new URL("../grand-court-addons.html",import.meta.url)),true);
});

test("public purchasable items come only from canonical server catalogs",()=>{
  const checks={
    "banquet.html":/list\s*=\s*window\.BANQUETS/,
    "product-catalog.html":/rawItems\s*=\s*[\s\S]{0,120}(?:DataStore\.getItems|window\.CATALOG_ITEMS)/,
    "charity.html":/rawItems\s*=\s*\(window\.CHARITY_ITEMS/,
    "supplies.html":/rawItems\s*=\s*\(window\.SUPPLIES_ITEMS/,
    "assets/js/grand-court-addons.js":/addons\s*=\s*window\.SUPREME_ADDONS/,
    "assets/js/tours.js":/tours\s*=\s*window\.SUPREME_TOURS/,
  };
  for(const [file,fallback] of Object.entries(checks)){
    const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8");
    assert.doesNotMatch(source,fallback,`${file} must not render a static purchasable fallback`);
  }
});

test("router error responses log details but return only stable public identifiers",()=>{
  for(const file of ["api/router.js","api/lib/http.js"]){
    const source=fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8");
    const start=source.indexOf("function errResponse");
    const end=source.indexOf("\n}",start)+2;
    const block=source.slice(start,end);
    assert.match(block,/console\.error/);
    assert.match(block,/requestId/);
    assert.doesNotMatch(block,/error:\s*(?:safe|err)/);
    assert.doesNotMatch(block,/\.\.\.extra/);
    assert.doesNotMatch(source,/function toSafeError/);
  }
});

test("obsolete and delete-marker artifacts are not deployable while secured debug tools remain",()=>{
  for(const file of ["api/router.legacy.js","api/admin/core.original.js","admin/delte.html","api/deleteme.html","api/admin/deleteme.html","api/admin/core/deleteme.html","api/cron/deleteme.html","api/lib/deleteme.html","api/orders/deleteme.html","api/routes/deleteme.html","assets/css/deleteme.html","assets/img/delteme.html","assets/js/deleteme.html","assets/js/lib/deleteme.html","assets/shop-charity/delteme.html","assets/shop-supplies/deleteme.html"]){
    assert.equal(fs.existsSync(new URL(`../${file}`,import.meta.url)),false,`${file} must not be deployable`);
  }
  for(const file of ["admin/debug.html","admin/debug2.html","admin/debug3.html","api/admin/debug-router.js"]){assert.equal(fs.existsSync(new URL(`../${file}`,import.meta.url)),true);}
});

test("administrator login logs never contain bearer tokens or token fragments",()=>{
  const router=fs.readFileSync(new URL("../api/admin/auth-router.js",import.meta.url),"utf8");
  const security=fs.readFileSync(new URL("../api/admin/security.js",import.meta.url),"utf8");
  assert.doesNotMatch(router,/console\.log\([^\n]*admin_login result/);
  assert.doesNotMatch(security,/tokenPrefix/);
  assert.doesNotMatch(security,/token\.slice\s*\(/);
  assert.match(security,/\[admin-login\] SUCCESS/);
  assert.match(security,/ttlSeconds/);
});

test("catalog images stay web-sized and stale public artifacts stay archived",()=>{
  const images=["assets/shop-charity/rose-charm-pendant-main.jpeg","assets/shop/coin_front.jpg","assets/shop-charity/rose-charm-main.jpeg","assets/shop-charity/adf-pin-main.jpeg","assets/shop/coin_back.jpg","assets/shop-charity/coin_back.jpg","assets/shop/coin_full.png","assets/shop-charity/bracelet-charm-thumb.png","assets/shop-charity/bracelet-charm-main.jpeg"];
  for(const file of images){
    if (!fs.existsSync(new URL(`../${file}`,import.meta.url))) continue;
    const size=fs.statSync(new URL(`../${file}`,import.meta.url)).size;
    assert.ok(size<1024*1024,`${file} must remain under 1 MB`);
  }
  for(const file of ["assets/shop/asdhgf.html","product-catalog_under cunstruction.html"]){assert.equal(fs.existsSync(new URL(`../${file}`,import.meta.url)),false);}
});

test("Vercel security headers protect all routes without enforcing CSP yet",()=>{
  const config=JSON.parse(fs.readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
  const global=config.headers.find((entry)=>entry.source==="/(.*)");
  assert.ok(global);
  const headers=Object.fromEntries(global.headers.map(({key,value})=>[key,value]));
  assert.equal(headers["X-Content-Type-Options"],"nosniff");
  assert.equal(headers["Referrer-Policy"],"strict-origin-when-cross-origin");
  assert.match(headers["Permissions-Policy"],/camera=\(\)/);
  assert.equal(headers["X-Frame-Options"],"SAMEORIGIN");
  assert.match(headers["Content-Security-Policy-Report-Only"],/https:\/\/js\.stripe\.com/);
  assert.equal(headers["Content-Security-Policy"],undefined);
});
