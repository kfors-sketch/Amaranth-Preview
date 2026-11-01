// /api/admin/catalog-router.js
// Catalog/Product route handler split out of /api/router.js.
// Keeps router.js smaller while preserving the same API endpoints.

import {
  REQ_OK,
  kvGetSafe,
  kvSetSafe,
  kvHgetallSafe,
  kvHsetSafe,
  kvSaddSafe,
} from "./core.js";

const CATALOG_CATEGORIES_KEY = "catalog:categories";

function normalizeCat(catRaw) {
  const cat = String(catRaw || "catalog").trim().toLowerCase();
  const safe = cat.replace(/[^a-z0-9_-]/g, "");
  return safe || "catalog";
}

function catalogItemsKeyForCat(catRaw) {
  const cat = normalizeCat(catRaw);
  if (!cat || cat === "catalog") return "products";
  return `products:${cat}`;
}

async function getCatalogCategoriesSafe() {
  const list = (await kvGetSafe(CATALOG_CATEGORIES_KEY, [])) || [];
  const out = Array.isArray(list) ? list.slice() : [];

  const ensure = (cat, title) => {
    const c = String(cat || "").trim().toLowerCase();
    if (!c) return;
    const has = out.some((x) => String(x?.cat || "").trim().toLowerCase() === c);
    if (!has) out.push({ cat: c, title });
  };

  ensure("catalog", "Product Catalog");
  ensure("supplies", "Supplies");
  ensure("charity", "Charity");

  out.sort((a, b) => {
    const ac = String(a?.cat || "").toLowerCase();
    const bc = String(b?.cat || "").toLowerCase();
    if (ac === "catalog" && bc !== "catalog") return -1;
    if (bc === "catalog" && ac !== "catalog") return 1;
    return String(a?.title || ac).localeCompare(String(b?.title || bc));
  });

  return out;
}

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

const VALID_FREQS = ["daily", "weekly", "biweekly", "monthly", "none"];
function normalizeReportFrequency(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "monthly";
  if (VALID_FREQS.includes(v)) return v;
  return "monthly";
}

function computeMergedFreq(incomingRaw, existingCfg, defaultFreq) {
  const raw =
    incomingRaw ??
    existingCfg?.reportFrequency ??
    existingCfg?.report_frequency ??
    defaultFreq;

  return normalizeReportFrequency(raw);
}

async function saveCatalogLikeItemCfg({ list, kindForItem }) {
  for (const p of list) {
    const id = String(p?.id || "").trim();
    if (!id) continue;

    const existing = await kvHgetallSafe(`itemcfg:${id}`);
    const name = pickNonEmptyString(p?.name, existing?.name, id);

    const chairEmails = normalizeChairEmails(p?.chairEmails, p?.chair?.email);
    const mergedChairEmails = chairEmails.length
      ? chairEmails
      : Array.isArray(existing?.chairEmails)
      ? existing.chairEmails
      : normalizeChairEmails(existing?.chairEmails, "");

    const publishStart = pickNonEmptyString(p?.publishStart, existing?.publishStart, "");
    const publishEnd = pickNonEmptyString(p?.publishEnd, existing?.publishEnd, "");

    const freq = computeMergedFreq(
      p?.reportFrequency ?? p?.report_frequency,
      existing,
      "monthly"
    );

    const cfg = {
      ...existing,
      id,
      name,
      kind: kindForItem,
      chairEmails: mergedChairEmails,
      publishStart,
      publishEnd,
      reportFrequency: freq,
      updatedAt: new Date().toISOString(),
    };

    await kvHsetSafe(`itemcfg:${id}`, cfg);
    await kvSaddSafe("itemcfg:index", id);
  }
}

export async function handleCatalogRoute(req, res, ctx = {}) {
  const { url, type, action, body = {}, requestId, requireAdminAuth, enforceLockdownIfNeeded } = ctx;

  if (req.method === "GET") {
    if (type === "catalog_categories") {
      const categories = await getCatalogCategoriesSafe();
      return REQ_OK(res, { requestId, categories }), true;
    }

    if (type === "catalog_items") {
      const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
      const key = catalogItemsKeyForCat(cat);
      const items = (await kvGetSafe(key, [])) || [];
      return REQ_OK(res, { requestId, cat, items }), true;
    }

    if (type === "catalog_has_active") {
      const cat = normalizeCat(url.searchParams.get("cat") || "catalog");
      const key = catalogItemsKeyForCat(cat);
      const items = (await kvGetSafe(key, [])) || [];
      const hasActive = Array.isArray(items) && items.some((it) => it && it.active);
      return REQ_OK(res, { requestId, cat, hasActive }), true;
    }

    if (type === "products") {
      return REQ_OK(res, {
        requestId,
        products: (await kvGetSafe("products")) || [],
      }), true;
    }
  }

  if (req.method === "POST") {
    if (action !== "save_products" && action !== "save_catalog_items") return false;

    if (typeof requireAdminAuth === "function") {
      if (!(await requireAdminAuth(req, res))) return true;
    }

    if (typeof enforceLockdownIfNeeded === "function") {
      if (!(await enforceLockdownIfNeeded(req, res, action, requestId))) return true;
    }

    if (action === "save_products") {
      const list = Array.isArray(body.products) ? body.products : [];
      await kvSetSafe("products", list);

      try {
        await saveCatalogLikeItemCfg({ list, kindForItem: "catalog" });
      } catch {}

      return REQ_OK(res, { requestId, ok: true, count: list.length }), true;
    }

    if (action === "save_catalog_items") {
      const cat = normalizeCat(url.searchParams.get("cat") || body?.cat || "catalog");
      const key = catalogItemsKeyForCat(cat);

      const list = Array.isArray(body.items)
        ? body.items
        : Array.isArray(body.products)
        ? body.products
        : [];

      await kvSetSafe(key, list);

      try {
        await saveCatalogLikeItemCfg({
          list,
          kindForItem: cat === "catalog" ? "catalog" : `catalog:${cat}`,
        });
      } catch {}

      return REQ_OK(res, { requestId, ok: true, cat, key, count: list.length }), true;
    }
  }

  return false;
}
