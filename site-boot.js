<script>
document.addEventListener('DOMContentLoaded', function(){
  if(!window.DataStore) return;
  const s = DataStore.getSettings();
  // Update nav label for Product Catalog
  document.querySelectorAll('a[href$="product-catalog.html"]').forEach(a=>{
    if(s.productCatalogLabel) a.textContent = s.productCatalogLabel;
  });
  // Apply wallpaper if set in Admin
  if (s.wallpaperUrl){
    const w = document.querySelector('.wallpaper');
    if (w) w.style.backgroundImage = `url('${s.wallpaperUrl}')`;
  }
  // Fees (percent + flat) override
  if (typeof s.feePercent === 'number') window.SITE_SETTINGS.feePercent = s.feePercent;
  if (typeof s.feeFlat === 'number') window.SITE_SETTINGS.feeFlat = s.feeFlat;
});
</script>
