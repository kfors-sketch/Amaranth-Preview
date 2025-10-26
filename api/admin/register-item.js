// /api/admin/register-item.js
// Upserts a single banquet's metadata into Redis (using REDIS_URL).
// Auth: Bearer REPORT_TOKEN
// Methods:
//   - POST: save/overwrite a single item {id,name,chairEmails[],publishStart,publishEnd}
//   - GET:  list all saved items (debug)

import { createClient } from 'redis';

function send(res, code, body) { return res.status(code).json(body); }
function bad(res, code, msg, details=[]) { console.error('[register-item]', code, msg, details); return send(res, code, { error: msg, details }); }
function ok(res, body={}) { return send(res, 200, { ok: true, ...body }); }

function validate(p){
  const errors = [];
  if (!p || typeof p !== 'object') { errors.push('Body must be JSON'); return errors; }
  if (!p.id) errors.push('Missing id');
  if (p.id && !/^[a-z0-9-]+$/.test(p.id)) errors.push('id must be lowercase letters, numbers, dashes');
  if (!p.name) errors.push('Missing name');
  if (p.chairEmails && !Array.isArray(p.chairEmails)) errors.push('chairEmails must be an array');
  if (p.publishStart && isNaN(new Date(p.publishStart))) errors.push('publishStart invalid');
  if (p.publishEnd && isNaN(new Date(p.publishEnd))) errors.push('publishEnd invalid');
  if (p.publishStart && p.publishEnd && new Date(p.publishStart) > new Date(p.publishEnd)) {
    errors.push('publishStart must be before publishEnd');
  }
  return errors;
}

let client; // reuse between invocations
async function getClient(){
  if (client?.isOpen) return client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not configured');
  client = createClient({ url });
  client.on('error', err => console.error('[redis] error', err));
  await client.connect();
  return client;
}

export default async function handler(req, res){
  // CORS (browser-friendly)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Auth
  const expected = process.env.REPORT_TOKEN;
  if (!expected) return bad(res, 500, 'REPORT_TOKEN not configured');
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== expected) return bad(res, 401, 'Unauthorized');

  try{
    const r = await getClient();

    if (req.method === 'GET') {
      const ids = await r.sMembers('report_items:index');
      const map = {};
      if (ids?.length) {
        const raw = await r.hGetAll('report_items');
        for (const k of Object.keys(raw||{})) {
          try { map[k] = JSON.parse(raw[k]); } catch { map[k] = raw[k]; }
        }
      }
      return ok(res, { items: map });
    }

    if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

    const body = req.body || {};
    const errors = validate(body);
    if (errors.length) return bad(res, 400, 'Validation failed', errors);

    const record = {
      id: body.id,
      name: body.name,
      chairEmails: Array.isArray(body.chairEmails) ? body.chairEmails.filter(Boolean) : [],
      publishStart: body.publishStart || '',
      publishEnd: body.publishEnd || '',
      updatedAt: new Date().toISOString(),
    };

    // store JSON string in hash 'report_items' keyed by id
    await r.hSet('report_items', record.id, JSON.stringify(record));
    await r.sAdd('report_items:index', record.id);

    return ok(res, { id: record.id });
  }catch(e){
    console.error('[register-item] fatal', e);
    return bad(res, 500, 'Failed to save item');
  }
}
