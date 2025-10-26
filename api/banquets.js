// Simple GET endpoint to provide banquet data
export default async function handler(req, res) {
  // Handle only GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Load from KV or fallback to static import
    let banquets = [];

    try {
      // Attempt to read from Vercel KV (if configured)
      if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        const r = await fetch(`${process.env.KV_REST_API_URL}/get/banquets`, {
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
          cache: 'no-store',
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.result) banquets = JSON.parse(j.result);
        }
      }
    } catch (err) {
      console.warn('KV fetch failed, using fallback:', err);
    }

    // Fallback: static file import
    if (!Array.isArray(banquets) || !banquets.length) {
      const mod = await import('../../assets/js/banquets.js');
      banquets = mod.BANQUETS || [];
    }

    res.status(200).json({ banquets });
  } catch (err) {
    console.error('Error in /api/banquets:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
