// /assets/js/admin-slotkeys.js
// Lightweight helper for managing slot labels + auto-generated slot keys
// Used by admin pages (banquets, addons, items, etc.)

(function () {
  const ROUTER_ENDPOINT = "/api/router";
  const ADD_VALUE = "__ADD__";

  // Simple in-memory cache of registries by scope (banquet, addon, item, etc.)
  const registryCache = Object.create(null);

  // ---- String helpers ----

  function normalizeLabel(label) {
    return String(label || "").trim();
  }

  function makeSlotKey(label) {
    // Convert "Sunday Night Banquets!" -> "sunday_night_banquets"
    const base = normalizeLabel(label)
      .toLowerCase()
      // remove any character that's not letter, number, space, or underscore
      .replace(/[^a-z0-9\s_]+/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    return base || "slot_" + Date.now();
  }

  function ensureUniqueKey(baseKey, registryMap) {
    if (!registryMap || !registryMap[baseKey]) return baseKey;

    let i = 2;
    let candidate = baseKey + "_" + i;
    while (registryMap[candidate]) {
      i += 1;
      candidate = baseKey + "_" + i;
    }
    return candidate;
  }

  // ---- Registry helpers ----

  async function loadRegistry(scope) {
    scope = scope || "global";
    if (registryCache[scope]) {
      return registryCache[scope];
    }

    const url = `${ROUTER_ENDPOINT}?action=get_slot_registry&scope=${encodeURIComponent(
      scope
    )}`;

    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error("Network error");

      const data = await res.json();
      // Be tolerant of shapes: either { slots: [...] } or [...]
      const slots = Array.isArray(data?.slots)
        ? data.slots
        : Array.isArray(data)
        ? data
        : [];

      const map = {};
      for (const s of slots) {
        if (s && s.slotKey) {
          map[s.slotKey] = s;
        }
      }

      const registry = { scope, slots, map };
      registryCache[scope] = registry;
      return registry;
    } catch (err) {
      console.error("Failed to load slot registry:", err);
      const empty = { scope, slots: [], map: {} };
      registryCache[scope] = empty;
      return empty;
    }
  }

  async function saveSlot(scope, slotKey, slotLabel) {
    scope = scope || "global";
    const payload = { scope, slotKey, slotLabel };

    const res = await fetch(
      `${ROUTER_ENDPOINT}?action=save_slot_registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        "Failed to save slot registry entry: " +
          res.status +
          " " +
          text
      );
    }

    // Update local cache
    const registry = registryCache[scope] || {
      scope,
      slots: [],
      map: {},
    };
    const entry = { scope, slotKey, slotLabel };
    registry.map[slotKey] = entry;

    // If it already exists in slots, replace, otherwise push
    const idx = registry.slots.findIndex(
      (s) => s.slotKey === slotKey
    );
    if (idx >= 0) registry.slots[idx] = entry;
    else registry.slots.push(entry);

    registryCache[scope] = registry;
    return entry;
  }

  async function addNewSlot(scope) {
    scope = scope || "global";
    const label = normalizeLabel(
      prompt("Enter new label (for reports and graphs):", "")
    );
    if (!label) {
      return null;
    }

    const registry = await loadRegistry(scope);
    const baseKey = makeSlotKey(label);
    const slotKey = ensureUniqueKey(baseKey, registry.map);

    try {
      const entry = await saveSlot(scope, slotKey, label);
      return entry;
    } catch (err) {
      console.error(err);
      alert(
        "Sorry, there was an error saving the new label. Please try again."
      );
      return null;
    }
  }

  // ---- UI helpers ----

  function populateSelectOptions(select, registry) {
    if (!select || !registry) return;

    const current = select.value;
    const addOption = select.querySelector(
      `option[value="${ADD_VALUE}"]`
    );

    // Clear everything except the special "__ADD__" option (if present)
    const keepAdd =
      addOption != null ? addOption.cloneNode(true) : null;
    select.innerHTML = "";

    // Default "choose" option
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "-- choose --";
    select.appendChild(placeholder);

    // Real options from registry
    const slots = registry.slots.slice().sort((a, b) =>
      String(a.slotLabel || "").localeCompare(
        String(b.slotLabel || ""),
        undefined,
        { sensitivity: "base" }
      )
    );

    for (const s of slots) {
      const opt = document.createElement("option");
      opt.value = s.slotKey;
      opt.textContent = s.slotLabel || s.slotKey;
      select.appendChild(opt);
    }

    // Re-add the "+ Add new..." option at the end
    if (keepAdd) {
      select.appendChild(keepAdd);
    } else {
      const addOpt = document.createElement("option");
      addOpt.value = ADD_VALUE;
      addOpt.textContent = "+ Add new label…";
      select.appendChild(addOpt);
    }

    // Restore previous selection if possible
    if (current && registry.map[current]) {
      select.value = current;
    }
  }

  async function initSlotSelect(select) {
    if (!select) return;
    if (select.__slotInitDone) return; // prevent double init
    select.__slotInitDone = true;

    const scope =
      select.getAttribute("data-slot-scope") || "global";

    // Load registry and populate options
    const registry = await loadRegistry(scope);
    populateSelectOptions(select, registry);

    select.addEventListener("change", async (e) => {
      const value = e.target.value;
      if (value !== ADD_VALUE) return;

      // User chose "+ Add new label…"
      const entry = await addNewSlot(scope);
      if (!entry) {
        // Reset selection
        e.target.value = "";
        return;
      }

      // Ensure new entry is part of registry cache
      const reg = registryCache[scope];
      populateSelectOptions(select, reg);

      // Select the newly created key
      select.value = entry.slotKey;
    });
  }

  async function initAllSlotSelects() {
    const selects = document.querySelectorAll(
      "[data-slot-select]"
    );
    for (const select of selects) {
      // Fire and forget; each init handles its own async
      initSlotSelect(select);
    }
  }

  // ---- Expose a tiny API for other admin scripts (optional) ----

  window.AmaranthSlotKeys = {
    loadRegistry,
    saveSlot,
    makeSlotKey,
    ensureUniqueKey,
    initAllSlotSelects,
    ADD_VALUE,
  };

  // Auto-init on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", initAllSlotSelects);
})();