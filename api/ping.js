// /api/ping.js
export default function handler(req, res) {
  res.status(200).json({ ok: true, time: Date.now() });
}
export const config = { runtime: "nodejs18.x" };
