// File: /api/admin/send-report.js
// POST a JSON body containing { to, subject?, scope?, csv, filename?, html? }
// - csv: string contents of the CSV attachment (required)
// - to: single email or array of emails (required)
// - scope: 'current' | 'full' (optional, for your own record)
// Requires env: RESEND_API_KEY, RESEND_FROM
import { Resend } from 'resend';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Allow': 'POST', 'Content-Type': 'application/json' }
    });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400 });
  }

  const { to, csv, subject, filename, html, scope } = payload || {};
  if (!to) return new Response(JSON.stringify({ error: 'Missing "to"' }), { status: 400 });
  if (!csv) return new Response(JSON.stringify({ error: 'Missing "csv"' }), { status: 400 });

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || 'reports@resend.dev'; // set RESEND_FROM in Vercel
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not set' }), { status: 500 });
  }

  const resend = new Resend(RESEND_API_KEY);

  const safeTo = Array.isArray(to) ? to : [String(to)];
  const nowIso = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const fileName = filename || `amaranth-report-${scope || 'current'}-${nowIso}.csv`;

  const emailSubject = subject || (scope === 'full' ? 'Amaranth Full Report' : 'Amaranth Current Report');
  const htmlBody = html || `<p>Hello,</p><p>Your ${scope || 'current'} report is attached.</p><p>— Amaranth</p>`;

  try {
    const result = await resend.emails.send({
      from: FROM,
      to: safeTo,
      subject: emailSubject,
      html: htmlBody,
      attachments: [
        {
          filename: fileName,
          content: Buffer.from(csv).toString('base64'),
          path: undefined
        }
      ]
    });
    return new Response(JSON.stringify({ ok: true, id: result?.data?.id || null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}