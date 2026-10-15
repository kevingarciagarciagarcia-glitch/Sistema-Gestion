import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

router.get('/', requirePermission('vendedores', 'consultar'), asyncHandler(async (req, res) => {
  const sellers = await db.prepare(`
    SELECT s.*, COUNT(o.id)::int AS order_count
    FROM sellers s
    LEFT JOIN sales_orders o ON o.seller_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `).all();

  res.render('sellers/list', { sellers });
}));

router.post('/', requirePermission('vendedores', 'agregar'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/pedidos/vendedores?error=El nombre es obligatorio');
  }

  try {
    await db.prepare('INSERT INTO sellers (name) VALUES (?)').run(name.trim());
  } catch (err) {
    return res.redirect('/pedidos/vendedores?error=Ya existe un vendedor con ese nombre');
  }

  res.redirect('/pedidos/vendedores');
}));

router.post('/:id/delete', requirePermission('vendedores', 'eliminar'), asyncHandler(async (req, res) => {
  const { n } = await db.prepare('SELECT COUNT(*)::int AS n FROM sales_orders WHERE seller_id = ?').get(req.params.id);
  if (n > 0) {
    return res.redirect('/pedidos/vendedores?error=No se puede eliminar: hay órdenes de pedido con este vendedor');
  }

  await db.prepare('DELETE FROM sellers WHERE id = ?').run(req.params.id);
  res.redirect('/pedidos/vendedores');
}));

export default router;
