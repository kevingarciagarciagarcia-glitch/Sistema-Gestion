import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

function round(num) {
  return Math.round(num * 10000) / 10000;
}

function movementCode(type, createdAt, id) {
  const prefix = type === 'in' ? 'ING' : type === 'out' ? 'EGR' : 'TRA';
  const yyyymm = String(createdAt).slice(0, 7).replace('-', '');
  return `${prefix} ${yyyymm}${String(id).padStart(6, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function swatchHtml(name, colorHexByName) {
  const hex = (colorHexByName && colorHexByName[String(name).toLowerCase()]) || '#ccc';
  return `<span class="color-swatch" style="width:12px;height:12px;margin-right:2px;vertical-align:middle;background:${hex};" title="${escapeHtml(name)}"></span>`;
}

function buildProductDetail(p, colorHexByName) {
  const parts = [];
  if (p.color) parts.push(`Color: ${swatchHtml(p.color, colorHexByName)}`);
  if (p.width !== null && p.width !== undefined) parts.push(`A: ${p.width}`);
  if (p.length !== null && p.length !== undefined) parts.push(`L: ${p.length}`);
  if (p.thickness !== null && p.thickness !== undefined) parts.push(`E: ${p.thickness}`);
  if (p.has_printing && p.printing_colors_text) {
    const printingColors = p.printing_colors_text.split('/').map((s) => s.trim()).filter(Boolean);
    parts.push(`Impresión: ${printingColors.map((c) => swatchHtml(c, colorHexByName)).join('')}`);
  }
  return parts.join(' · ');
}

router.get('/', requirePermission('kardex', 'consultar'), asyncHandler(async (req, res) => {
  const colorHexByName = await getColorHexMap();

  const products = await db.prepare(`
    SELECT p.id, p.sku, p.name, p.unit_id, p.width, p.length, p.thickness, p.color, p.has_printing,
           ppc.printing_colors_text
    FROM products p
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    ORDER BY p.name
  `).all();
  const warehouses = await db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const units = await db.prepare('SELECT * FROM units').all();
  const unitsById = Object.fromEntries(units.map((u) => [u.id, u]));

  const items = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    searchText: `${p.sku} ${p.name}`.toLowerCase(),
    detail: buildProductDetail(p, colorHexByName)
  }));

  const productId = req.query.product_id ? Number(req.query.product_id) : null;
  const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;
  const code = req.query.code?.trim() || '';
  const from = req.query.from || '';
  const to = req.query.to || '';
  const type = req.query.type || '';

  let rows = [];
  let selectedProduct = null;

  if (productId) {
    selectedProduct = products.find((p) => p.id === productId) || null;
  }

  if (selectedProduct) {
    const allMovements = await db.prepare(`
      SELECT m.*
      FROM movements m
      WHERE m.product_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `).all(productId);

    const unitName = unitsById[selectedProduct.unit_id]?.name || '—';

    let balance = 0;
    const computed = [];

    for (const m of allMovements) {
      let entrada = 0;
      let salida = 0;
      let affectsWarehouse = true;

      if (m.type === 'in') {
        entrada = Number(m.quantity);
        if (warehouseId) affectsWarehouse = Number(m.warehouse_id) === warehouseId;
      } else if (m.type === 'out') {
        salida = Number(m.quantity);
        if (warehouseId) affectsWarehouse = Number(m.warehouse_id) === warehouseId;
      } else {
        // traspaso: sin filtro de bodega no cambia el total del producto
        if (!warehouseId) continue;
        if (Number(m.from_warehouse_id) === warehouseId) {
          salida = Number(m.quantity);
        } else if (Number(m.to_warehouse_id) === warehouseId) {
          entrada = Number(m.quantity);
        } else {
          affectsWarehouse = false;
        }
      }

      if (!affectsWarehouse) continue;

      balance = round(balance + entrada - salida);

      computed.push({
        id: m.id,
        batchId: m.batch_id,
        type: m.type,
        reason: m.reason,
        createdAt: m.created_at,
        entrada,
        salida,
        stockU: balance,
        code: movementCode(m.type, m.created_at, m.id)
      });
    }

    rows = computed
      .filter((r) => {
        if (from && String(r.createdAt).slice(0, 10) < from) return false;
        if (to && String(r.createdAt).slice(0, 10) > to) return false;
        if (type && r.type !== type) return false;
        if (code && !r.code.toLowerCase().includes(code.toLowerCase())) return false;
        return true;
      })
      .reverse();

    rows.forEach((r) => { r.unitName = unitName; });
  }

  res.render('kardex/list', {
    items,
    warehouses,
    selectedProduct,
    rows,
    filters: { product_id: productId || '', warehouse_id: warehouseId || '', code, from, to, type },
    colorHexByName
  });
}));

export default router;
