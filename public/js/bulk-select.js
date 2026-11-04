(function () {
  function initBulkSelect(table) {
    const selectAll = table.querySelector('[data-select-all]');
    const rowChecks = Array.from(table.querySelectorAll('.row-select'));
    const bar = document.querySelector('[data-bulk-bar]');
    const countEl = bar ? bar.querySelector('[data-bulk-count]') : null;
    const deleteBtn = bar ? bar.querySelector('[data-bulk-delete]') : null;
    const exportBtn = bar ? bar.querySelector('[data-bulk-export]') : null;
    const form = document.querySelector('[data-bulk-form]');
    const exportForm = document.querySelector('[data-bulk-export-form]');

    function submitWithIds(targetForm, checked) {
      targetForm.querySelectorAll('input[name="ids"]').forEach((el) => el.remove());
      checked.forEach((cb) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'ids';
        input.value = cb.value;
        targetForm.appendChild(input);
      });

      const redirectInput = targetForm.querySelector('[data-bulk-redirect]');
      if (redirectInput) redirectInput.value = window.location.pathname + window.location.search;

      targetForm.submit();
    }

    function update() {
      const checked = rowChecks.filter((c) => c.checked);
      if (countEl) countEl.textContent = checked.length;
      if (bar) bar.style.display = checked.length > 0 ? 'flex' : 'none';
      if (selectAll) {
        selectAll.checked = checked.length > 0 && checked.length === rowChecks.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < rowChecks.length;
      }
    }

    rowChecks.forEach((cb) => cb.addEventListener('change', update));

    if (selectAll) {
      selectAll.addEventListener('change', () => {
        rowChecks.forEach((cb) => { cb.checked = selectAll.checked; });
        update();
      });
    }

    if (deleteBtn && form) {
      deleteBtn.addEventListener('click', () => {
        const checked = rowChecks.filter((c) => c.checked);
        if (checked.length === 0) return;
        const confirmMsg = checked.length === 1
          ? '¿Eliminar el producto seleccionado? Esta acción no se puede deshacer.'
          : `¿Eliminar los ${checked.length} productos seleccionados? Esta acción no se puede deshacer.`;
        if (!confirm(confirmMsg)) return;
        submitWithIds(form, checked);
      });
    }

    if (exportBtn && exportForm) {
      exportBtn.addEventListener('click', () => {
        const checked = rowChecks.filter((c) => c.checked);
        if (checked.length === 0) return;
        submitWithIds(exportForm, checked);
      });
    }

    update();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('table[data-bulk-select]').forEach(initBulkSelect);
  });
})();
