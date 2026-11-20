import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();
const ITEM_TYPES = ['rollo', 'funda', 'lamina'];
const SOURCE_TYPES = ['inventario', 'personalizado'];

const PRINTING_TYPE_LABELS = { serigrafia: 'Serigrafía', flexografia: 'Flexografía' };
const PRINTING_SIDE_LABELS = { anverso: 'Anverso', reverso: 'Reverso', anverso_reverso: 'Anverso y Reverso' };
const FUELLE_TYPE_LABELS = { lateral: 'Fuelle Lateral', fondo: 'Fuelle Fondo', superior_fondo: 'Fuelle Superior y Fondo' };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function swatchHtml(name, colorHexByName) {
  const hex = (colorHexByName && colorHexByName[String(name).toLowerCase()]) || '#ccc';
  return `<span class="color-swatch" style="width:12px;height:12px;margin-right:2px;vertical-align:middle;background:${hex};" title="${escapeHtml(name)}"></span>`;
}

function printingColorsHtml(text, colorHexByName) {
  return text.split('/').map((s) => s.trim()).filter(Boolean).map((c) => swatchHtml(c, colorHexByName)).join('');
}

function buildCharacteristicsDetail(f, colorHexByName) {
  const parts = [];
  if (f.color) parts.push(`Color: ${swatchHtml(f.color, colorHexByName)}`);
  if (f.width != null || f.length != null) parts.push(`A: ${f.width ?? '—'} · L: ${f.length ?? '—'}`);
  if (f.thickness != null) parts.push(`E: ${f.thickness}`);
  if (f.has_fuelle && f.fuelle_type) {
    const measures = f.fuelle_type === 'superior_fondo'
      ? `Sup: ${f.fuelle_measure_1 ?? '—'} / Fon: ${f.fuelle_measure_2 ?? '—'}`
      : `${f.fuelle_measure_1 ?? '—'}`;
    parts.push(`${FUELLE_TYPE_LABELS[f.fuelle_type]}: ${measures}`);
  }
  if (f.has_printing) {
    const bits = [];
    if (f.printing_type) bits.push(PRINTING_TYPE_LABELS[f.printing_type] || f.printing_type);
    if (f.printing_side) bits.push(PRINTING_SIDE_LABELS[f.printing_side] || f.printing_side);
    parts.push(`Impresión: ${escapeHtml(bits.join(' · ') || 'Sí')}`);
    if (f.printing_colors_text) parts.push(`Colores de Impresión: ${printingColorsHtml(f.printing_colors_text, colorHexByName)}`);
    else if (f.printing_colors) parts.push(`${f.printing_colors} color${Number(f.printing_colors) === 1 ? '' : 'es'}`);
  }
  if (f.printing_reference) parts.push(`Ref: ${escapeHtml(f.printing_reference)}`);
  return parts.join(' · ');
}

function buildSearchDetail(f, colorHexByName) {
  const parts = [];
  if (f.width != null || f.length != null) parts.push(`Medida: ${f.width ?? '—'}x${f.length ?? '—'}`);
  if (f.color) parts.push(`Color: ${swatchHtml(f.color, colorHexByName)}`);
  if (f.has_printing && f.printing_colors_text) {
    parts.push(`Color Impresión: ${printingColorsHtml(f.printing_colors_text, colorHexByName)}`);
  }
  return parts.join(' · ');
}

function nextCodeForExistingSkus(skus) {
  const groups = {};
  for (const raw of skus) {
    const sku = String(raw || '').trim();
    const m = /^(.*?)(\d+)$/.exec(sku);
    if (!m) continue;
    const prefix = m[1];
    const numStr = m[2];
    const num = parseInt(numStr, 10);
    if (!groups[prefix]) groups[prefix] = { count: 0, max: -1, width: numStr.length };
    groups[prefix].count += 1;
    if (num > groups[prefix].max) {
      groups[prefix].max = num;
      groups[prefix].width = numStr.length;
    }
  }

  const prefixes = Object.keys(groups);
  if (prefixes.length === 0) return null;

  prefixes.sort((a, b) => groups[b].count - groups[a].count || groups[b].max - groups[a].max);
  const best = prefixes[0];
  const next = groups[best].max + 1;
  return `${best}${String(next).padStart(groups[best].width, '0')}`;
}

async function getInventoryItemsFormData() {
  const products = await db.prepare(`
    SELECT p.*, ppc.printing_colors_text
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id)
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    WHERE top.name = 'Producto Terminado'
    ORDER BY p.name
  `).all();

  const colorHexByName = await getColorHexMap();
  const colors = await db.prepare('SELECT * FROM colors ORDER BY name').all();

  const items = products.map((p) => {
    const fields = {
      product_code: p.sku,
      color: p.color, width: p.width, length: p.length, thickness: p.thickness,
      has_fuelle: p.has_fuelle, fuelle_type: p.fuelle_type, fuelle_measure_1: p.fuelle_measure_1, fuelle_measure_2: p.fuelle_measure_2,
      has_printing: p.has_printing, printing_type: p.printing_type, printing_side: p.printing_side,
      printing_colors: p.printing_colors, printing_colors_text: p.printing_colors_text, printing_reference: p.printing_reference
    };
    const medida = (p.width != null || p.length != null) ? `${p.width ?? ''}x${p.length ?? ''}` : '';
    return {
      id: p.id, sku: p.sku, name: p.name,
      searchText: [p.sku, p.name, p.color, medida].filter(Boolean).join(' ').toLowerCase(),
      detail: buildCharacteristicsDetail(fields, colorHexByName),
      searchDetail: buildSearchDetail(fields, colorHexByName),
      fields
    };
  });

  const categories = await db.prepare(`
    SELECT c.id, c.name
    FROM categories c
    JOIN categories top ON top.id = c.parent_id
    WHERE top.name = 'Producto Terminado'
    ORDER BY c.name
  `).all();

  const nextCodeByCategory = {};
  for (const cat of categories) {
    const skus = await db.prepare('SELECT sku FROM products WHERE category_id = ?').all(cat.id);
    nextCodeByCategory[cat.id] = nextCodeForExistingSkus(skus.map((r) => r.sku));
  }

  const units = await db.prepare('SELECT * FROM units ORDER BY name').all();

  return { items, colors, categories, nextCodeByCategory, units };
}

function getSellers() {
  return db.prepare('SELECT * FROM sellers ORDER BY name').all();
}

async function getClients() {
  const rows = await db.prepare(`
    SELECT p.id, p.name, p.commercial_name, p.ruc, p.cedula
    FROM people p
    JOIN person_roles r ON r.person_id = p.id
    WHERE r.role = 'cliente'
    ORDER BY p.name
  `).all();

  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    detail: [p.commercial_name, p.ruc || p.cedula].filter(Boolean).join(' · '),
    searchText: [p.name, p.commercial_name, p.ruc, p.cedula].filter((v) => v).join(' ').toLowerCase()
  }));
}

async function getOrderOr404(id) {
  const order = await db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(id);
  if (!order) return null;

  order.items = await db.prepare('SELECT * FROM sales_order_items WHERE order_id = ? ORDER BY item_number').all(id);
  order.subtotal = order.items.reduce((sum, it) => sum + it.line_total, 0);
  return order;
}

function round(num) {
  return Math.round(num * 100) / 100;
}

function parseOrderItems(body) {
  const rawItems = body.items ? Object.values(body.items) : [];
  const items = [];
  let itemNumber = 1;

  for (const raw of rawItems) {
    const product = raw.product?.trim();
    if (!product) continue;

    if (!ITEM_TYPES.includes(raw.type)) {
      return { error: `Selecciona el tipo (Rollo, Funda o Lámina) para "${product}"` };
    }

    const sourceType = SOURCE_TYPES.includes(raw.source_type) ? raw.source_type : 'personalizado';
    const hasFuelle = raw.has_fuelle === '1' || raw.has_fuelle === 'true';
    const hasPrinting = raw.has_printing === '1' || raw.has_printing === 'true';
    const quantity = Number(raw.quantity) || 0;
    const unitPrice = Number(raw.unit_price) || 0;

    items.push({
      item_number: itemNumber++,
      source_type: sourceType,
      product_id: sourceType === 'inventario' && raw.product_id ? Number(raw.product_id) : null,
      product_code: raw.product_code?.trim() || null,
      type: raw.type,
      product,
      color: raw.color?.trim() || null,
      width: raw.width ? Number(raw.width) : null,
      length: raw.length ? Number(raw.length) : null,
      thickness: raw.thickness ? Number(raw.thickness) : null,
      has_fuelle: hasFuelle ? 1 : 0,
      fuelle_type: hasFuelle && raw.fuelle_type ? raw.fuelle_type : null,
      fuelle_measure_1: hasFuelle && raw.fuelle_measure_1 ? Number(raw.fuelle_measure_1) : null,
      fuelle_measure_2: hasFuelle && raw.fuelle_measure_2 ? Number(raw.fuelle_measure_2) : null,
      has_printing: hasPrinting ? 1 : 0,
      printing_type: hasPrinting && raw.printing_type ? raw.printing_type : null,
      printing_side: hasPrinting && raw.printing_side ? raw.printing_side : null,
      printing_colors: hasPrinting && raw.printing_colors ? Number(raw.printing_colors) : null,
      printing_colors_text: hasPrinting ? (raw.printing_colors_text?.trim() || null) : null,
      printing_reference: hasPrinting ? (raw.printing_reference?.trim() || null) : null,
      quantity,
      qty_per_bundle: raw.qty_per_bundle ? Number(raw.qty_per_bundle) : null,
      qty_per_package: raw.qty_per_package ? Number(raw.qty_per_package) : null,
      total_kg: raw.total_kg ? Number(raw.total_kg) : null,
      unit_price: unitPrice,
      line_total: round(quantity * unitPrice),
      observation: raw.observation?.trim() || null
    });
  }

  if (items.length === 0) {
    return { error: 'Agrega al menos una línea de producto' };
  }

  return { items };
}

async function saveOrderItems(orderId, items) {
  await db.prepare('DELETE FROM sales_order_items WHERE order_id = ?').run(orderId);

  for (const it of items) {
    await db.prepare(`
      INSERT INTO sales_order_items (
        order_id, item_number, source_type, product_id, product_code, type, product, color, width, length, thickness,
        has_fuelle, fuelle_type, fuelle_measure_1, fuelle_measure_2,
        has_printing, printing_type, printing_side, printing_colors, printing_colors_text, printing_reference,
        quantity, qty_per_bundle, qty_per_package, total_kg, unit_price, line_total, observation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, it.item_number, it.source_type, it.product_id, it.product_code, it.type, it.product, it.color,
      it.width, it.length, it.thickness,
      it.has_fuelle, it.fuelle_type, it.fuelle_measure_1, it.fuelle_measure_2,
      it.has_printing, it.printing_type, it.printing_side, it.printing_colors, it.printing_colors_text, it.printing_reference,
      it.quantity, it.qty_per_bundle, it.qty_per_package, it.total_kg, it.unit_price, it.line_total, it.observation
    );
  }
}

router.get('/', requirePermission('ordenes', 'consultar'), asyncHandler(async (req, res) => {
  const search = req.query.q?.trim() || '';
  const orders = await db.prepare(`
    SELECT o.*, s.name AS seller_name, COALESCE(SUM(i.line_total), 0) AS subtotal
    FROM sales_orders o
    LEFT JOIN sellers s ON s.id = o.seller_id
    LEFT JOIN sales_order_items i ON i.order_id = o.id
    WHERE o.client ILIKE ? OR o.proforma_number ILIKE ?
    GROUP BY o.id, s.name
    ORDER BY o.id DESC
  `).all(`%${search}%`, `%${search}%`);

  const orderIds = orders.map((o) => o.id);
  const items = orderIds.length > 0
    ? await db.prepare('SELECT * FROM sales_order_items WHERE order_id = ANY(?) ORDER BY order_id, item_number').all(orderIds)
    : [];

  const colorHexByName = await getColorHexMap();
  items.forEach((it) => { it.characteristicsDetail = buildCharacteristicsDetail(it, colorHexByName); });

  const itemsByOrder = {};
  items.forEach((it) => {
    if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
    itemsByOrder[it.order_id].push(it);
  });
  orders.forEach((o) => { o.items = itemsByOrder[o.id] || []; });

  res.render('orders/list', { orders, search });
}));

router.get('/new', requirePermission('ordenes', 'agregar'), asyncHandler(async (req, res) => {
  const { items: inventoryItems, colors, categories, nextCodeByCategory, units } = await getInventoryItemsFormData();
  res.render('orders/form', {
    order: null, sellers: await getSellers(), clients: await getClients(),
    inventoryItems, colors, categories, nextCodeByCategory, units, colorHexByName: await getColorHexMap()
  });
}));

router.post('/', requirePermission('ordenes', 'agregar'), asyncHandler(async (req, res) => {
  const { client, client_id, proforma_number, order_date, delivery_date, city, branch, seller_id } = req.body;

  if (!client?.trim() || !seller_id) {
    return res.redirect('/pedidos/new?error=Cliente y vendedor son obligatorios');
  }

  const { items, error } = parseOrderItems(req.body);
  if (error) {
    return res.redirect(`/pedidos/new?error=${encodeURIComponent(error)}`);
  }

  const info = await db.prepare(`
    INSERT INTO sales_orders (client, client_id, proforma_number, order_date, delivery_date, city, branch, seller_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(
    client.trim(),
    client_id || null,
    proforma_number?.trim() || null,
    order_date || null,
    delivery_date || null,
    city?.trim() || null,
    branch?.trim() || null,
    seller_id
  );

  await saveOrderItems(info.lastInsertRowid, items);
  await logActivity(req, `Creó la orden de pedido #${info.lastInsertRowid} para "${client.trim()}"`);
  res.redirect(`/pedidos/${info.lastInsertRowid}`);
}));

router.get('/:id/edit', requirePermission('ordenes', 'modificar'), asyncHandler(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  if (!order) return res.redirect('/pedidos');

  const { items: inventoryItems, colors, categories, nextCodeByCategory, units } = await getInventoryItemsFormData();
  const colorHexByName = await getColorHexMap();
  order.items.forEach((it) => { it.characteristicsDetail = buildCharacteristicsDetail(it, colorHexByName); });

  res.render('orders/form', {
    order, sellers: await getSellers(), clients: await getClients(),
    inventoryItems, colors, categories, nextCodeByCategory, units, colorHexByName
  });
}));

router.post('/:id', requirePermission('ordenes', 'modificar'), asyncHandler(async (req, res) => {
  const { client, client_id, proforma_number, order_date, delivery_date, city, branch, seller_id } = req.body;

  if (!client?.trim() || !seller_id) {
    return res.redirect(`/pedidos/${req.params.id}/edit?error=Cliente y vendedor son obligatorios`);
  }

  const { items, error } = parseOrderItems(req.body);
  if (error) {
    return res.redirect(`/pedidos/${req.params.id}/edit?error=${encodeURIComponent(error)}`);
  }

  await db.prepare(`
    UPDATE sales_orders
    SET client = ?, client_id = ?, proforma_number = ?, order_date = ?, delivery_date = ?, city = ?, branch = ?, seller_id = ?
    WHERE id = ?
  `).run(
    client.trim(),
    client_id || null,
    proforma_number?.trim() || null,
    order_date || null,
    delivery_date || null,
    city?.trim() || null,
    branch?.trim() || null,
    seller_id,
    req.params.id
  );

  await saveOrderItems(req.params.id, items);
  await logActivity(req, `Editó la orden de pedido #${req.params.id} para "${client.trim()}"`);
  res.redirect(`/pedidos/${req.params.id}`);
}));

router.post('/:id/delete', requirePermission('ordenes', 'eliminar'), asyncHandler(async (req, res) => {
  const order = await db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM sales_orders WHERE id = ?').run(req.params.id);
  await logActivity(req, `Eliminó la orden de pedido #${req.params.id}${order ? ` ("${order.client}")` : ''}`);
  res.redirect('/pedidos');
}));

router.get('/:id', requirePermission('ordenes', 'consultar'), asyncHandler(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  if (!order) return res.redirect('/pedidos');

  const seller = order.seller_id ? await db.prepare('SELECT * FROM sellers WHERE id = ?').get(order.seller_id) : null;
  const colorHexByName = await getColorHexMap();
  order.items.forEach((it) => { it.characteristicsDetail = buildCharacteristicsDetail(it, colorHexByName); });
  res.render('orders/view', { order, seller, colorHexByName });
}));

export default router;
