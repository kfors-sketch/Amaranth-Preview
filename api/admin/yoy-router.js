// /api/admin/yoy-router.js
import {
  kvGetSafe,
  REQ_OK,
  REQ_ERR,
} from "./core.js";

import {
  listIndexedYears,
  getYearSummary,
  getMultiYearSummary,
} from "./yearly-reports.js";

// Keep these local so router.js does not need to own year-over-year catalog helpers.
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

export async function handleYoyRoute(req, res, ctx = {}) {
  const { url, type, requestId, requireAdminAuth } = ctx;
  if (req.method !== "GET") return false;

  const protectedTypes = new Set([
    "year_index",
    "years_index",
    "year_summary",
    "year_multi",
    "catalog_items_yoy",
  ]);

  if (protectedTypes.has(type)) {
    if (typeof requireAdminAuth !== "function" || !(await requireAdminAuth(req, res))) {
      return true;
    }
  }

  if (type === "year_index") {
    const years = await listIndexedYears();

    const slots = [];
    const seen = new Set();

    const addSlots = (list, category) => {
      if (!Array.isArray(list)) return;
      for (const item of list) {
        const key = String(item?.id || item?.slotKey || item?.slot || "").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const label = item?.name || item?.label || item?.slotLabel || key;
        slots.push({ key, label, category });
      }
    };

    const banquets = (await kvGetSafe("banquets", [])) || [];
    const addons = (await kvGetSafe("addons", [])) || [];

    addSlots(banquets, "banquet");
    addSlots(addons, "addon");

    const products = (await kvGetSafe("products", [])) || [];
    addSlots(products, "catalog");

    const cats = await getCatalogCategoriesSafe();
    for (const c of cats) {
      const cat = normalizeCat(c?.cat);
      if (cat === "catalog") continue;
      const key = catalogItemsKeyForCat(cat);
      const list = (await kvGetSafe(key, [])) || [];
      addSlots(list, `catalog:${cat}`);
    }

    return REQ_OK(res, { requestId, years, slots });
  }

  if (type === "years_index") {
    const years = await listIndexedYears();
    return REQ_OK(res, { requestId, years });
  }

  if (type === "year_summary") {
    const yParam = url.searchParams.get("year");
    const year = Number(yParam);
    if (!Number.isFinite(year)) {
      return REQ_ERR(res, 400, "invalid-year", { requestId, year: yParam });
    }
    const summary = await getYearSummary(year);
    return REQ_OK(res, { requestId, ...summary });
  }

  if (type === "year_multi") {
    let yearsParams = url.searchParams.getAll("year");
    if (!yearsParams.length) {
      const csv = url.searchParams.get("years") || "";
      if (csv) {
        yearsParams = csv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const years = yearsParams
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    if (!years.length) {
      const allYears = await listIndexedYears();
      return REQ_OK(res, { requestId, years: allYears, points: [], raw: [] });
    }

    const raw = await getMultiYearSummary(years);

    const points = raw.map((r) => ({
      year: r.year,
      totalOrders: r.totalOrders || 0,
      uniqueBuyers: r.uniqueBuyers || 0,
      repeatBuyers: r.repeatBuyers || 0,
      totalPeople: r.totalPeople || 0,
      totalCents: r.totalCents || 0,
    }));

    return REQ_OK(res, { requestId, years, points, raw });
  }

  if (type === "catalog_items_yoy") {
    const cat = normalizeCat(url.searchParams.get("cat") || "catalog");

    let yearsParams = url.searchParams.getAll("year");
    if (!yearsParams.length) {
      const csv = url.searchParams.get("years") || "";
      if (csv) {
        yearsParams = csv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const years = yearsParams
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const useYears = years.length ? years : await listIndexedYears();

    const key = catalogItemsKeyForCat(cat);
    const items = (await kvGetSafe(key, [])) || [];

    const byYear = {};
    for (const y of useYears) byYear[String(y)] = items;

    return REQ_OK(res, { requestId, cat, years: useYears, byYear });
  }

  return false;
}
