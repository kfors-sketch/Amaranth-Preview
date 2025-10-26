// /api/banquets.js
// Public, read-only list of banquets.
// Source: Redis (REDIS_URL) hash "report_items" with JSON values.
// GET -> { ok: true, banquets: [...] }

import { createClient } from 'redis';

let client; // reuse between invocations

async function getClient() {
  if (client?.isOpen) return client;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL not configured');
  client = createClient({ url });
  client.on('error', (e) => console.error('[banquets] redis error', e));
  await client.connect();
  return client;
}

export default async function handler(req, res) {
  // CORS (safe for browser use)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const r = await getClient();

    // Each field in "report_items" is an item id; value is JSON string
    const raw = await r.hGetAll('report_items'); // { id: jsonString, ... }
    const banquets = [];

    for (const [id, val] of Object.entries(raw || {})) {
      try {
        const obj = typeof val === 'string' ? JSON.parse(val) : val;
        if (obj && obj.id) banquets.push(obj);
      } catch (e) {
        console.warn('[banquets] bad JSON for id', id);
      }
    }

    // Sort stable by name to keep UI consistent
    banquets.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    return res.status(200).json({ ok: true, banquets });
  } catch (err) {
    console.error('Error in /api/banquets:', err);
    return res.status(500).json({ error: 'failed-to-read-banquets' });
  }
}
