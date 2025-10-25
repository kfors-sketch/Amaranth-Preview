// File: /api/admin/send-test.js
// GET /api/admin/send-test?to=you@example.com
// Sends a sample CSV attachment via Resend.
import { Resend } from 'resend';
export const config = { runtime: 'edge' };
export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const to = searchParams.get('to');
  if (!to) return new Response(JSON.stringify({ error: 'Missing ?to=' }), { status: 400 });
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.RESEND_FROM || 'reports@resend.dev';
  if (!RESEND_API_KEY) return new Response(JSON.stringify({ error: 'RESEND_API_KEY not set' }), { status: 500 });
  const resend = new Resend(RESEND_API_KEY);

  const headers = ['date','orderId','purchaser','attendee','category','item','qty','price','gross','fees','net','status','notes'];
  const rows = [
    ['2025-01-10T12:00:00.000Z','T-1001','Jane Smith','Theron','banquet','Banquet – Chicken',2,'35.00','70.00','2.18','67.82','paid',''],
    ['2025-01-10T12:05:00.000Z','T-1002','Karl Forsberg','','addon','Corsage',1,'15.00','15.00','0.75','14.25','paid','white rose']
  ];
  const csv = [headers.join(','), ...rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','))].join('\n');
  const fileName = `amaranth-test-${Date.now()}.csv`;
  try {
    const result = await resend.emails.send({
      from: FROM,
      to,
      subject: 'Amaranth Test Report',
      html: '<p>Hello, this is your test report. CSV attached.</p>',
      attachments: [{
        filename: fileName,
        content: Buffer.from(csv).toString('base64')
      }]
    });
    return new Response(JSON.stringify({ ok: true, id: result?.data?.id || null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}