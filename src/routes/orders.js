import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();
const ITEM_TYPES = ['rollo', 'funda', 'lamina'];

function getSellers() {
  return db.prepare('SELECT * FROM sellers ORDER BY name').all();
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

    const quantity = Number(raw.quantity) || 0;
    const unitPrice = Number(raw.unit_price) || 0;

    items.push({
      item_number: itemNumber++,
      type: raw.type,
      product,
      color: raw.color?.trim() || null,
      width: raw.width ? Number(raw.width) : null,
      length: raw.length ? Number(raw.length) : null,
      thickness: raw.thickness ? Number(raw.thickness) : null,
      quantity,
      total_kg: raw.total_kg ? Number(raw.total_kg) : null,
      unit_price: unitPrice,
      line_total: round(quantity * unitPrice)
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
        order_id, item_number, type, product, color, width, length, thickness,
        quantity, total_kg, unit_price, line_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, it.item_number, it.type, it.product, it.color,
      it.width, it.length, it.thickness, it.quantity, it.total_kg, it.unit_price, it.line_total
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
    WHERE o.client LIKE ? OR o.proforma_number LIKE ?
    GROUP BY o.id, s.name
    ORDER BY o.id DESC
  `).all(`%${search}%`, `%${search}%`);

  res.render('orders/list', { orders, search });
}));

router.get('/new', requirePermission('ordenes', 'agregar'), asyncHandler(async (req, res) => {
  res.render('orders/form', { order: null, sellers: await getSellers() });
}));

router.post('/', requirePermission('ordenes', 'agregar'), asyncHandler(async (req, res) => {
  const { client, proforma_number, order_date, delivery_date, city, branch, seller_id } = req.body;

  if (!client?.trim() || !seller_id) {
    return res.redirect('/pedidos/new?error=Cliente y vendedor son obligatorios');
  }

  const { items, error } = parseOrderItems(req.body);
  if (error) {
    return res.redirect(`/pedidos/new?error=${encodeURIComponent(error)}`);
  }

  const info = await db.prepare(`
    INSERT INTO sales_orders (client, proforma_number, order_date, delivery_date, city, branch, seller_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(
    client.trim(),
    proforma_number?.trim() || null,
    order_date || null,
    delivery_date || null,
    city?.trim() || null,
    branch?.trim() || null,
    seller_id
  );

  await saveOrderItems(info.lastInsertRowid, items);
  res.redirect(`/pedidos/${info.lastInsertRowid}`);
}));

router.get('/:id/edit', requirePermission('ordenes', 'modificar'), asyncHandler(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  if (!order) return res.redirect('/pedidos');

  res.render('orders/form', { order, sellers: await getSellers() });
}));

router.post('/:id', requirePermission('ordenes', 'modificar'), asyncHandler(async (req, res) => {
  const { client, proforma_number, order_date, delivery_date, city, branch, seller_id } = req.body;

  if (!client?.trim() || !seller_id) {
    return res.redirect(`/pedidos/${req.params.id}/edit?error=Cliente y vendedor son obligatorios`);
  }

  const { items, error } = parseOrderItems(req.body);
  if (error) {
    return res.redirect(`/pedidos/${req.params.id}/edit?error=${encodeURIComponent(error)}`);
  }

  await db.prepare(`
    UPDATE sales_orders
    SET client = ?, proforma_number = ?, order_date = ?, delivery_date = ?, city = ?, branch = ?, seller_id = ?
    WHERE id = ?
  `).run(
    client.trim(),
    proforma_number?.trim() || null,
    order_date || null,
    delivery_date || null,
    city?.trim() || null,
    branch?.trim() || null,
    seller_id,
    req.params.id
  );

  await saveOrderItems(req.params.id, items);
  res.redirect(`/pedidos/${req.params.id}`);
}));

router.post('/:id/delete', requirePermission('ordenes', 'eliminar'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM sales_orders WHERE id = ?').run(req.params.id);
  res.redirect('/pedidos');
}));

router.get('/:id', requirePermission('ordenes', 'consultar'), asyncHandler(async (req, res) => {
  const order = await getOrderOr404(req.params.id);
  if (!order) return res.redirect('/pedidos');

  const seller = order.seller_id ? await db.prepare('SELECT * FROM sellers WHERE id = ?').get(order.seller_id) : null;
  res.render('orders/view', { order, seller });
}));

export default router;
