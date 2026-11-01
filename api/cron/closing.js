import { kv } from "@vercel/kv";
import { runScheduledReport } from "./security.js";

export default async function handler(req, res) {
  return runScheduledReport({
    kind: "closing",
    action: "send_end_of_event_reports",
    req,
    res,
    kv,
  });
}
