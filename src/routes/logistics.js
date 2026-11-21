import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

function round(num) {
  return Math.round(num * 100) / 100;
}

async function getOrdersWithProgress() {
  const orders = await db.prepare(`
    SELECT o.*, s.name AS seller_name
    FROM sales_orders o
    LEFT JOIN sellers s ON s.id = o.seller_id
    ORDER BY o.id DESC
  `).all();

  const items = await db.prepare(`
    SELECT i.*, COALESCE(d.dispatched, 0) AS dispatched
    FROM sales_order_items i
    LEFT JOIN (
      SELECT order_item_id, SUM(quantity) AS dispatched
      FROM order_dispatch_items
      GROUP BY order_item_id
    ) d ON d.order_item_id = i.id
    ORDER BY i.order_id, i.item_number
  `).all();

  const itemsByOrder = {};
  items.forEach((it) => {
    if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
    itemsByOrder[it.order_id].push(it);
  });

  orders.forEach((o) => {
    const orderItems = itemsByOrder[o.id] || [];
    const totalRequested = round(orderItems.reduce((s, it) => s + it.quantity, 0));
    const totalDispatched = round(orderItems.reduce((s, it) => s + Math.min(it.dispatched, it.quantity), 0));
    const totalOverDispatched = round(orderItems.reduce((s, it) => s + it.dispatched, 0));
    const anyDispatched = orderItems.some((it) => it.dispatched > 0);
    const allComplete = orderItems.length > 0 && orderItems.every((it) => it.dispatched >= it.quantity);

    o.items = orderItems;
    o.totalRequested = totalRequested;
    o.totalDispatched = totalOverDispatched;
    o.pendingBalance = round(Math.max(0, totalRequested - totalDispatched));
    o.progressPct = totalRequested > 0 ? Math.min(100, round((totalDispatched / totalRequested) * 100)) : 0;
    o.status = !anyDispatched ? 'pendiente' : (allComplete ? 'completo' : 'parcial');
  });

  return orders;
}

const STATUS_LABELS = { pendiente: 'Pendiente', parcial: 'Parcial', completo: 'Completo' };

router.get('/', requirePermission('logistica', 'consultar'), asyncHandler(async (req, res) => {
  const { estado, cliente, from, to, q } = req.query;
  const search = q?.trim().toLowerCase() || '';

  const allOrders = await getOrdersWithProgress();
  let orders = allOrders;

  if (estado) orders = orders.filter((o) => o.status === estado);
  if (cliente?.trim()) orders = orders.filter((o) => o.client.toLowerCase().includes(cliente.trim().toLowerCase()));
  if (from) orders = orders.filter((o) => o.order_date && o.order_date >= from);
  if (to) orders = orders.filter((o) => o.order_date && o.order_date <= to);
  if (search) {
    orders = orders.filter((o) => {
      if (String(o.id).includes(search)) return true;
      if (o.client.toLowerCase().includes(search)) return true;
      return o.items.some((it) => (it.product || '').toLowerCase().includes(search) || (it.product_code || '').toLowerCase().includes(search));
    });
  }

  const kpis = {
    pendiente: allOrders.filter((o) => o.status === 'pendiente').length,
    parcial: allOrders.filter((o) => o.status === 'parcial').length,
    completo: allOrders.filter((o) => o.status === 'completo').length,
    conSaldo: allOrders.filter((o) => o.status !== 'completo').length
  };

  res.render('logistics/list', { orders, kpis, filters: { estado, cliente: cliente || '', from: from || '', to: to || '', q: q || '' }, STATUS_LABELS });
}));

router.get('/:id', requirePermission('logistica', 'consultar'), asyncHandler(async (req, res) => {
  const orders = await getOrdersWithProgress();
  const order = orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.redirect('/logistica');

  const typeLabels = { rollo: 'Rollo', funda: 'Funda', lamina: 'Lámina' };

  const dispatches = await db.prepare(`
    SELECT d.*, u.full_name AS created_by_full_name, u.username AS created_by_username
    FROM order_dispatches d
    LEFT JOIN users u ON u.id = d.created_by
    WHERE d.order_id = ?
    ORDER BY d.id DESC
  `).all(order.id);

  const dispatchIds = dispatches.map((d) => d.id);
  const dispatchItems = dispatchIds.length > 0
    ? await db.prepare(`
        SELECT di.*, i.product, i.product_code
        FROM order_dispatch_items di
        JOIN sales_order_items i ON i.id = di.order_item_id
        WHERE di.dispatch_id = ANY(?)
        ORDER BY di.id
      `).all(dispatchIds)
    : [];

  const dispatchItemsByDispatch = {};
  dispatchItems.forEach((di) => {
    if (!dispatchItemsByDispatch[di.dispatch_id]) dispatchItemsByDispatch[di.dispatch_id] = [];
    dispatchItemsByDispatch[di.dispatch_id].push(di);
  });
  dispatches.forEach((d) => { d.items = dispatchItemsByDispatch[d.id] || []; });

  order.items.forEach((it) => {
    it.pendingBalance = round(Math.max(0, it.quantity - it.dispatched));
  });

  res.render('logistics/order', {
    order, dispatches, typeLabels, STATUS_LABELS, query: req.query,
    colorHexByName: await getColorHexMap()
  });
}));

router.post('/:id/despachar', requirePermission('logistica', 'agregar'), asyncHandler(async (req, res) => {
  const order = await db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.redirect('/logistica');

  const { dispatch_date, reference, observation } = req.body;
  const rawItems = req.body.items ? Object.values(req.body.items) : [];

  const lines = rawItems
    .map((raw) => ({ orderItemId: Number(raw.order_item_id), quantity: Number(raw.quantity) || 0 }))
    .filter((l) => l.quantity > 0);

  if (lines.length === 0) {
    return res.redirect(`/logistica/${order.id}?error=${encodeURIComponent('Ingresa al menos una cantidad a despachar')}`);
  }

  const tx = await db.beginTransaction();
  try {
    const info = await tx.prepare(`
      INSERT INTO order_dispatches (order_id, dispatch_date, reference, observation, created_by)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `).run(order.id, dispatch_date || null, reference?.trim() || null, observation?.trim() || null, req.user.id);

    for (const line of lines) {
      await tx.prepare('INSERT INTO order_dispatch_items (dispatch_id, order_item_id, quantity) VALUES (?, ?, ?)')
        .run(info.lastInsertRowid, line.orderItemId, line.quantity);
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    return res.redirect(`/logistica/${order.id}?error=${encodeURIComponent('No se pudo registrar el despacho')}`);
  }

  await logActivity(req, `Registró un despacho para la orden de pedido #${order.id} ("${order.client}")`);
  res.redirect(`/logistica/${order.id}`);
}));

router.post('/:id/despachos/:dispatchId/delete', requirePermission('logistica', 'eliminar'), asyncHandler(async (req, res) => {
  const dispatch = await db.prepare('SELECT * FROM order_dispatches WHERE id = ? AND order_id = ?').get(req.params.dispatchId, req.params.id);
  if (dispatch) {
    await db.prepare('DELETE FROM order_dispatches WHERE id = ?').run(dispatch.id);
    await logActivity(req, `Eliminó el despacho #${dispatch.id} de la orden de pedido #${req.params.id}`);
  }
  res.redirect(`/logistica/${req.params.id}`);
}));

export default router;
