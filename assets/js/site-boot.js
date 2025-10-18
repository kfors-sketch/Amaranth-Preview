// assets/js/site-boot.js  (NO <script> tags here)
document.addEventListener('DOMContentLoaded', function () {
  // Safety: ensure globals exist so we don't throw
  window.SITE_SETTINGS = window.SITE_SETTINGS || {};

  // If DataStore is available, pull saved settings
  const s = (window.DataStore && DataStore.getSettings)
    ? DataStore.getSettings()
    : {};

  // Update nav label for Product Catalog if admin set one
  if (s.productCatalogLabel) {
    document.querySelectorAll('a[href$="product-catalog.html"]').forEach(a => {
      a.textContent = s.productCatalogLabel;
    });
  }

  // Apply wallpaper if set in Admin (for pages that still use a .wallpaper DIV)
  if (s.wallpaperUrl) {
    const w = document.querySelector('.wallpaper');
    if (w) w.style.backgroundImage = `url('${s.wallpaperUrl}')`;
  }

  // Apply fee overrides (used by Cart.totals)
  if (typeof s.feePercent === 'number') window.SITE_SETTINGS.feePercent = s.feePercent;
  if (typeof s.feeFlat === 'number')    window.SITE_SETTINGS.feeFlat    = s.feeFlat;

  // ---- Disable current-page link in the header nav (grayed out & unclickable)
  function normalize(path) {
    try {
      const u = new URL(path, window.location.origin);
      path = u.pathname;
    } catch (e) { /* ignore */ }

    if (path === '/' || path === '') path = '/home.html';
    if (path.endsWith('/')) path += 'home.html';

    // Map old PA paths to current filenames (kept from your version)
    path = path
      .replace(/^\/pa-2026\/?(index\.html)?$/i, '/home.html')
      .replace(/^\/pa-2026\/shop\.html$/i, '/product-catalog.html')
      .replace(/^\/pa-2026\/banquets\.html$/i, '/banquet.html')
      .replace(/^\/pa-2026\/order\.html$/i, '/order.html');

    const match = path.match(/\/([^\/?#]+)$/);
    return match ? match[1].toLowerCase() : 'home.html';
  }

  const currentPage = normalize(window.location.pathname);

  document.querySelectorAll('.site-nav a').forEach(link => {
    // Skip external links
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) return;

    const linkTarget = normalize(href || '/home.html');

    if (linkTarget === currentPage) {
      link.classList.add('nav-current');
      link.removeAttribute('href');
      link.style.pointerEvents = 'none';
      link.style.opacity = '0.6';
    }
  });
});
