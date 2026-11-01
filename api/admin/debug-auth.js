export const DEBUG_ROUTE_TYPES = Object.freeze([
  "smoketest", "lastmail", "debug_mail_recent", "debug_token",
  "debug_stripe", "debug_resend", "debug_scheduler",
  "debug_orders_health", "debug_itemcfg_health", "debug_scheduler_dry_run",
  "debug_chair_preview", "debug_order_preview", "debug_webhook_preview",
]);

const DEBUG_ROUTE_SET = new Set(DEBUG_ROUTE_TYPES);

export function isDebugRouteType(type) {
  return DEBUG_ROUTE_SET.has(String(type || ""));
}

export async function authorizeDebugRoute({ type, requireAdminAuth, req, res }) {
  if (!isDebugRouteType(type)) return { handled: false, authorized: false };
  if (typeof requireAdminAuth !== "function") {
    res.status(401).json({ error: "unauthorized" });
    return { handled: true, authorized: false };
  }
  const authorized = await requireAdminAuth(req, res);
  return { handled: true, authorized: !!authorized };
}

