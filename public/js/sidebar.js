(function () {
  function toggle() {
    var hidden = document.documentElement.classList.toggle('sidebar-hidden');
    try { localStorage.setItem('sidebarHidden', hidden ? '1' : '0'); } catch (e) {}
  }

  document.addEventListener('DOMContentLoaded', function () {
    var toggleBtn = document.getElementById('sidebarToggle');
    var openBtn = document.getElementById('sidebarOpenBtn');
    var backdrop = document.getElementById('sidebarBackdrop');
    if (toggleBtn) toggleBtn.addEventListener('click', toggle);
    if (openBtn) openBtn.addEventListener('click', toggle);
    if (backdrop) backdrop.addEventListener('click', toggle);
  });
})();
