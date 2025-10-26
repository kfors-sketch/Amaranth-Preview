// /api/admin/register-item.js
// Upserts a single banquet's metadata into Vercel KV.
// Auth: Bearer REPORT_TOKEN
// Methods:
//   - POST: save/overwrite a single item
//   - GET:  list all saved items (debug)

import { kv } from '@vercel/kv';

function send(res, code, body) {
  return res.status(code).json(body);
}
function bad(res, code, msg, details = []) {
  console.error('[register-item] error', code, msg, details);
  return send(res, code, { error: msg, details });
}
function ok(res, body = {}) {
  return send(res, 200, { ok: true, ...body });
}

function validatePayload(p) {
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

export default async function handler(req, res) {
  // --- Basic CORS (helps when calling from browser) ---
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // --- Auth ---
  const expected = process.env.REPORT_TOKEN;
  if (!expected) return bad(res, 500, 'REPORT_TOKEN not configured');

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== expected) return bad(res, 401, 'Unauthorized');

  // --- GET: list current items (debug) ---
  if (req.method === 'GET') {
    try {
      const map = (await kv.hgetall('report_items')) || {};
      for (const k of Object.keys(map)) {
        if (typeof map[k] === 'string') {
          try { map[k] = JSON.parse(map[k]); } catch {}
        }
      }
      console.debug('[register-item] GET items count:', Object.keys(map).length);
      return ok(res, { items: map });
    } catch (e) {
      console.error('[register-item] KV read error', e);
      return bad(res, 500, 'Failed to read items');
    }
  }

  if (req.method !== 'POST') {
    return bad(res, 405, 'Method not allowed');
  }

  // --- POST: save/overwrite single item ---
  try {
    const body = req.body || {};
    console.debug('[register-item] POST body id:', body?.id);

    const errors = validatePayload(body);
    if (errors.length) return bad(res, 400, 'Validation failed', errors);

    const record = {
      id: body.id,
      name: body.name,
      chairEmails: Array.isArray(body.chairEmails) ? body.chairEmails.filter(Boolean) : [],
      publishStart: body.publishStart || '',
      publishEnd: body.publishEnd || '',
      updatedAt: new Date().toISOString(),
    };

    // store as JSON in a single hash keyed by 'report_items'
    await kv.hset('report_items', { [record.id]: JSON.stringify(record) });
    // (optional) keep an index set if you want quick iteration by id
    await kv.sadd('report_items:index', record.id);

    console.debug('[register-item] saved', record.id);
    return ok(res, { id: record.id });
  } catch (e) {
    console.error('[register-item] save error', e);
    return bad(res, 500, 'Failed to save item');
  }
}
