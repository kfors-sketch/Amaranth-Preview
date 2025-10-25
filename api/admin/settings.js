// /api/admin/settings.js
// GET  => returns { overrides, env, effective }
// POST => saves overrides { RESEND_FROM, REPORTS_CC, MAINTENANCE_ON, MAINTENANCE_MESSAGE }

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;
const REPORT_TOKEN = process.env.REPORT_TOKEN;

function unauthorized(msg='Unauthorized'){
  return new Response(JSON.stringify({ error: msg }), { status: 401, headers: { 'Content-Type': 'application/json' } });
}
function bad(msg='Bad Request'){
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}
function ok(body, status=200){
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function getRedis(){
  if(!REDIS_URL) throw new Error('REDIS_URL not set');
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err)=> console.error('Redis error', err));
  if(!client.isOpen) await client.connect();
  return client;
}

function requireToken(req){
  if(!REPORT_TOKEN) return true; // if not set, allow (dev-friendly)
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1] || '';
  return token && token === REPORT_TOKEN;
}

const KEY = 'amaranth:settings';

export default async function handler(req) {
  try{
    if(req.method === 'OPTIONS') return ok({});

    if(req.method === 'GET'){
      const client = await getRedis().catch(()=> null);
      let overrides = {};
      if(client){
        const raw = await client.hGetAll(KEY);
        overrides = Object.fromEntries(Object.entries(raw || {}).map(([k,v])=>{
          if(k === 'MAINTENANCE_ON') return [k, v === 'true'];
          return [k, v];
        }));
      }
      const env = {
        RESEND_FROM: process.env.RESEND_FROM || '',
        REPORTS_CC: process.env.REPORTS_CC || '',
        MAINTENANCE_ON: (process.env.MAINTENANCE_ON || 'false') === 'true',
        MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ''
      };
      const effective = {
        RESEND_FROM: overrides.RESEND_FROM ?? env.RESEND_FROM,
        REPORTS_CC: overrides.REPORTS_CC ?? env.REPORTS_CC,
        MAINTENANCE_ON: (overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) ? true : false,
        MAINTENANCE_MESSAGE: overrides.MAINTENANCE_MESSAGE ?? env.MAINTENANCE_MESSAGE
      };
      return ok({ overrides, env, effective });
    }

    if(req.method === 'POST'){
      if(!requireToken(req)) return unauthorized();

      const body = await req.json().catch(()=> ({}));
      const { RESEND_FROM, REPORTS_CC, MAINTENANCE_ON, MAINTENANCE_MESSAGE } = body || {};
      const client = await getRedis();

      const toStore = {};
      if(typeof RESEND_FROM === 'string') toStore.RESEND_FROM = RESEND_FROM;
      if(typeof REPORTS_CC === 'string') toStore.REPORTS_CC = REPORTS_CC;
      if(typeof MAINTENANCE_ON !== 'undefined') toStore.MAINTENANCE_ON = String(!!MAINTENANCE_ON);
      if(typeof MAINTENANCE_MESSAGE === 'string') toStore.MAINTENANCE_MESSAGE = MAINTENANCE_MESSAGE;

      // allow clearing by sending empty string
      const del = [];
      for(const [k,v] of Object.entries(toStore)){
        if(v === '') del.push(k);
      }
      if(del.length) await client.hDel(KEY, del);
      const toSet = Object.fromEntries(Object.entries(toStore).filter(([k,v])=> v !== ''));
      if(Object.keys(toSet).length) await client.hSet(KEY, toSet);

      const raw = await client.hGetAll(KEY);
      const overrides = Object.fromEntries(Object.entries(raw || {}).map(([k,v])=>{
        if(k === 'MAINTENANCE_ON') return [k, v === 'true'];
        return [k, v];
      }));
      const env = {
        RESEND_FROM: process.env.RESEND_FROM || '',
        REPORTS_CC: process.env.REPORTS_CC || '',
        MAINTENANCE_ON: (process.env.MAINTENANCE_ON || 'false') === 'true',
        MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE || ''
      };
      const effective = {
        RESEND_FROM: overrides.RESEND_FROM ?? env.RESEND_FROM,
        REPORTS_CC: overrides.REPORTS_CC ?? env.REPORTS_CC,
        MAINTENANCE_ON: (overrides.MAINTENANCE_ON ?? env.MAINTENANCE_ON) ? true : false,
        MAINTENANCE_MESSAGE: overrides.MAINTENANCE_MESSAGE ?? env.MAINTENANCE_MESSAGE
      };

      return ok({ overrides, env, effective }, 200);
    }

    return bad('Method not allowed');
  }catch(e){
    return ok({ error: String(e?.message || e) }, 500);
  }
}
