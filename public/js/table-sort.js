(function () {
  function getCellValue(row, index) {
    const cell = row.children[index];
    return cell ? cell.textContent.trim() : '';
  }

  function isEmptyValue(value) {
    return value === '' || value === '—';
  }

  function isNumeric(value) {
    if (isEmptyValue(value)) return false;
    const normalized = value.replace(/\./g, '').replace(',', '.');
    return !isNaN(parseFloat(normalized)) && isFinite(normalized);
  }

  function compareValues(a, b, numeric) {
    const aEmpty = isEmptyValue(a);
    const bEmpty = isEmptyValue(b);
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    if (numeric) {
      return parseFloat(a.replace(',', '.')) - parseFloat(b.replace(',', '.'));
    }
    return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
  }

  function clearIndicators(headers) {
    headers.forEach((h) => {
      h.removeAttribute('data-sort-dir');
      const indicator = h.querySelector('.sort-indicator');
      if (indicator) indicator.remove();
    });
  }

  function initSortableTable(table) {
    const headers = Array.from(table.querySelectorAll('thead th[data-sort]'));

    headers.forEach((th) => {
      th.addEventListener('click', () => {
        const index = Array.from(th.parentElement.children).indexOf(th);
        const currentDir = th.getAttribute('data-sort-dir');
        const nextDir = currentDir === 'desc' ? 'asc' : 'desc';

        clearIndicators(headers);
        th.setAttribute('data-sort-dir', nextDir);

        const indicator = document.createElement('span');
        indicator.className = 'sort-indicator';
        indicator.textContent = nextDir === 'desc' ? ' ▼' : ' ▲';
        th.appendChild(indicator);

        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));

        const sampleValues = rows.map((r) => getCellValue(r, index)).filter((v) => !isEmptyValue(v));
        const numeric = sampleValues.length > 0 && sampleValues.every(isNumeric);

        rows.sort((r1, r2) => {
          const cmp = compareValues(getCellValue(r1, index), getCellValue(r2, index), numeric);
          return nextDir === 'desc' ? -cmp : cmp;
        });

        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('table.sortable-table').forEach(initSortableTable);
  });
})();
