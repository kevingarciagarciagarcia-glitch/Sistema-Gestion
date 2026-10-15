import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

router.get('/', requirePermission('bodegas', 'consultar'), asyncHandler(async (req, res) => {
  const warehouses = await db.prepare(`
    SELECT w.*,
      COUNT(DISTINCT m.id)::int AS movement_count,
      COALESCE(SUM(CASE WHEN s.quantity != 0 THEN 1 ELSE 0 END), 0)::int AS stock_rows
    FROM warehouses w
    LEFT JOIN movements m ON m.warehouse_id = w.id OR m.from_warehouse_id = w.id OR m.to_warehouse_id = w.id
    LEFT JOIN product_warehouse_stock s ON s.warehouse_id = w.id
    GROUP BY w.id
    ORDER BY w.name
  `).all();

  res.render('warehouses/list', { warehouses });
}));

router.post('/', requirePermission('bodegas', 'agregar'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/inventario/bodegas?error=El nombre es obligatorio');
  }

  try {
    await db.prepare('INSERT INTO warehouses (name, description) VALUES (?, ?)')
      .run(name.trim(), description?.trim() || null);
  } catch (err) {
    return res.redirect('/inventario/bodegas?error=Ya existe una bodega con ese nombre');
  }

  res.redirect('/inventario/bodegas');
}));

router.post('/:id/delete', requirePermission('bodegas', 'eliminar'), asyncHandler(async (req, res) => {
  const { n: movementCount } = await db.prepare(`
    SELECT COUNT(*)::int AS n FROM movements
    WHERE warehouse_id = ? OR from_warehouse_id = ? OR to_warehouse_id = ?
  `).get(req.params.id, req.params.id, req.params.id);

  if (movementCount > 0) {
    return res.redirect('/inventario/bodegas?error=No se puede eliminar: hay movimientos registrados en esta bodega');
  }

  await db.prepare('DELETE FROM warehouses WHERE id = ?').run(req.params.id);
  res.redirect('/inventario/bodegas');
}));

export default router;
