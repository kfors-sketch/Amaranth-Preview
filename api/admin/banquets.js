// /api/admin/banquets.js
// Saves the full banquets list to Vercel KV (protected by REPORT_TOKEN)

import { kv } from '@vercel/kv';

function bad(res, code, msg, details = []) {
  return res.status(code).json({ error: msg, details });
}

function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}

// Minimal validation of each banquet object
function validateBanquet(b) {
  const errors = [];
  if (!b || typeof b !== 'object') { errors.push('Item is not an object'); return errors; }
  if (!b.id) errors.push('Missing id');
  if (b.id && !/^[a-z0-9-]+$/.test(b.id)) errors.push(`Invalid id "${b.id}" (lowercase letters, numbers, dashes only)`);
  if (!b.name) errors.push(`Missing name for id "${b.id || '?'}"`);
  if (b.chairEmails && !Array.isArray(b.chairEmails)) errors.push(`chairEmails must be an array for id "${b.id}"`);
  if (b.publishStart && isNaN(new Date(b.publishStart))) errors.push(`publishStart is invalid for id "${b.id}"`);
  if (b.publishEnd && isNaN(new Date(b.publishEnd))) errors.push(`publishEnd is invalid for id "${b.id}"`);
  if (b.publishStart && b.publishEnd && new Date(b.publishStart) > new Date(b.publishEnd)) {
    errors.push(`publishStart must be before publishEnd for id "${b.id}"`);
  }
  return errors;
}

export default async function handler(req, res) {
  // CORS (optional; useful if you ever open this to another origin)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Auth: Bearer <REPORT_TOKEN>
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = process.env.REPORT_TOKEN;
  if (!expected) {
    return bad(res, 500, 'REPORT_TOKEN not configured in environment');
  }
  if (token !== expected) {
    return bad(res, 401, 'Unauthorized: invalid or missing token');
  }

  // Support GET (optional) to read what’s stored
  if (req.method === 'GET') {
    try {
      const raw = await kv.get('banquets'); // stored as JSON string or array
      const banquets = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
      return ok(res, { banquets });
    } catch (e) {
      console.error('KV read error', e);
      return bad(res, 500, 'Failed to read banquets from KV');
    }
  }

  if (req.method !== 'POST') {
    return bad(res, 405, 'Method not allowed');
  }

  try {
    const body = req.body || {};
    const list = Array.isArray(body?.banquets) ? body.banquets : null;
    if (!list) return bad(res, 400, 'Body must include { banquets: [...] }');

    // Validate all
    const allErrors = [];
    list.forEach((b, idx) => {
      const errs = validateBanquet(b);
      if (errs.length) allErrors.push(`Index ${idx} (${b?.id ?? '?'}) → ${errs.join('; ')}`);
    });
    if (allErrors.length) return bad(res, 400, 'Validation failed', allErrors);

    // Save into KV (store as JSON string to be safe)
    await kv.set('banquets', JSON.stringify(list));

    return ok(res, { saved: list.length });
  } catch (e) {
    console.error('Save error', e);
    return bad(res, 500, 'Failed to save banquets');
  }
}
