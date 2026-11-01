import {
  REQ_OK,
  kvGetSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvHsetSafe,
  kvSaddSafe,
  normalizeReportFrequency,
} from "./core.js";

import { loadTours, saveToursAndItemCfg } from "./tours.js";

function splitEmails(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeChairEmails(raw, fallbackEmail) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  const from = raw || fallbackEmail || "";
  return splitEmails(from);
}

function pickNonEmptyString(a, b, fallback = "") {
  const aa = String(a ?? "").trim();
  if (aa) return aa;
  const bb = String(b ?? "").trim();
  if (bb) return bb;
  return fallback;
}

function computeMergedFreq(incomingRaw, existingCfg, defaultFreq) {
  const raw =
    incomingRaw ??
    existingCfg?.reportFrequency ??
    existingCfg?.report_frequency ??
    defaultFreq;

  return normalizeReportFrequency(raw);
}

async function saveItemsWithItemCfg({ key, list, kind, defaultFrequency }) {
  await kvSetSafe(key, list);

  try {
    for (const item of list) {
      const id = String(item?.id || "").trim();
      if (!id) continue;

      const existing = await kvHgetallSafe(`itemcfg:${id}`);
      const name = pickNonEmptyString(item?.name, existing?.name, id);

      const chairEmails = normalizeChairEmails(
        item?.chairEmails,
        item?.chair?.email
      );
      const mergedChairEmails =
        chairEmails.length
          ? chairEmails
          : Array.isArray(existing?.chairEmails)
          ? existing.chairEmails
          : normalizeChairEmails(existing?.chairEmails, "");

      const publishStart = pickNonEmptyString(
        item?.publishStart,
        existing?.publishStart,
        ""
      );
      const publishEnd = pickNonEmptyString(
        item?.publishEnd,
        existing?.publishEnd,
        ""
      );

      const freq = computeMergedFreq(
        item?.reportFrequency ?? item?.report_frequency,
        existing,
        defaultFrequency
      );

      const cfg = {
        ...existing,
        id,
        name,
        kind,
        chairEmails: mergedChairEmails,
        publishStart,
        publishEnd,
        reportFrequency: freq,
        updatedAt: new Date().toISOString(),
      };

      await kvHsetSafe(`itemcfg:${id}`, cfg);
      await kvSaddSafe("itemcfg:index", id);
    }
  } catch {}
}

export async function handleItemsRoute(req, res, ctx = {}) {
  const { type, action, body = {}, requestId, requireAdminAuth, enforceLockdownIfNeeded } = ctx;

  if (req.method === "GET") {
    if (type === "banquets") {
      return REQ_OK(res, {
        requestId,
        banquets: (await kvGetSafe("banquets")) || [],
      });
    }

    if (type === "addons") {
      return REQ_OK(res, {
        requestId,
        addons: (await kvGetSafe("addons")) || [],
      });
    }

    if (type === "tours") {
      return REQ_OK(res, {
        requestId,
        ok: true,
        tours: await loadTours(),
      });
    }
  }

  if (req.method === "POST") {
    if (action === "save_banquets") {
      if (requireAdminAuth && !(await requireAdminAuth(req, res))) return true;
      if (enforceLockdownIfNeeded && !(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;

      const list = Array.isArray(body.banquets) ? body.banquets : [];
      await saveItemsWithItemCfg({
        key: "banquets",
        list,
        kind: "banquet",
        defaultFrequency: "daily",
      });
      return REQ_OK(res, { requestId, ok: true, count: list.length });
    }

    if (action === "save_addons") {
      if (requireAdminAuth && !(await requireAdminAuth(req, res))) return true;
      if (enforceLockdownIfNeeded && !(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;

      const list = Array.isArray(body.addons) ? body.addons : [];
      await saveItemsWithItemCfg({
        key: "addons",
        list,
        kind: "addon",
        defaultFrequency: "monthly",
      });
      return REQ_OK(res, { requestId, ok: true, count: list.length });
    }

    if (action === "save_tours") {
      if (requireAdminAuth && !(await requireAdminAuth(req, res))) return true;
      if (enforceLockdownIfNeeded && !(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;

      const list = await saveToursAndItemCfg(body.tours);
      return REQ_OK(res, { requestId, ok: true, count: list.length, tours: list });
    }
  }

  return false;
}
