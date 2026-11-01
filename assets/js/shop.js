// /assets/js/shop.js
// Simple lightbox for shop thumbnails
(function () {
  const grid = document.querySelector('.shop-grid');
  const lb = document.getElementById('lightbox');
  const lbImg = lb?.querySelector('.lightbox-img');
  const lbCaption = lb?.querySelector('.lightbox-caption');
  const lbClose = lb?.querySelector('.lightbox-close');

  if (!grid || !lb || !lbImg || !lbClose) return;

  // Open image
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.thumb');
    if (!btn) return;

    const img = btn.querySelector('img');
    lbImg.src = img.dataset.full || img.src;
    lbImg.alt = img.alt || '';
    if (lbCaption) lbCaption.textContent = img.alt || '';
    lb.hidden = false;
    lbClose.focus();
  });

  // Close helpers
  function closeLightbox() {
    lb.hidden = true;
    lbImg.src = '';
    lbImg.alt = '';
    if (lbCaption) lbCaption.textContent = '';
  }
  lbClose.addEventListener('click', closeLightbox);
  lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.hidden) closeLightbox(); });
})();
