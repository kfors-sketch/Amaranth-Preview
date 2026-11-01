import { kv } from "@vercel/kv";
import { runScheduledReport } from "./security.js";

export default async function handler(req, res) {
  return runScheduledReport({
    kind: "monthly",
    action: "send_monthly_chair_reports",
    req,
    res,
    kv,
  });
}
