<script>
document.addEventListener('DOMContentLoaded', function () {
  if (!window.DataStore) return;
  const s = DataStore.getSettings();

  // Update nav label for Product Catalog
  document.querySelectorAll('a[href$="product-catalog.html"]').forEach(a => {
    if (s.productCatalogLabel) a.textContent = s.productCatalogLabel;
  });

  // Apply wallpaper if set in Admin
  if (s.wallpaperUrl) {
    const w = document.querySelector('.wallpaper');
    if (w) w.style.backgroundImage = `url('${s.wallpaperUrl}')`;
  }

  // Apply fee overrides
  if (typeof s.feePercent === 'number') window.SITE_SETTINGS.feePercent = s.feePercent;
  if (typeof s.feeFlat === 'number') window.SITE_SETTINGS.feeFlat = s.feeFlat;


  // ✅ Disable current page link in nav (Option B)
  function normalize(path) {
    try {
      const u = new URL(path, window.location.origin);
      path = u.pathname;
    } catch (e) { }
    if (path === '/' || path === '') path = '/home.html';
    if (path.endsWith('/')) path += 'home.html';

    // Map old PA paths
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
    if (/^https?:\/\//i.test(link.getAttribute('href') || '')) return;

    const href = link.getAttribute('href') || '/home.html';
    const linkTarget = normalize(href);

    // Disable current page link
    if (linkTarget === currentPage) {
      link.classList.add('nav-current');
      link.removeAttribute('href');
      link.style.pointerEvents = 'none';
      link.style.opacity = '0.6';
    }
  });
});

</script>