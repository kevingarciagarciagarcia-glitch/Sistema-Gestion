import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';

const router = Router();

router.get('/', requirePermission('unidades', 'consultar'), asyncHandler(async (req, res) => {
  const units = await db.prepare(`
    SELECT u.*,
      COUNT(DISTINCT p.id)::int AS product_count,
      COUNT(DISTINCT c.id)::int AS conversion_count
    FROM units u
    LEFT JOIN products p ON p.unit_id = u.id
    LEFT JOIN product_unit_conversions c ON c.target_unit_id = u.id
    GROUP BY u.id
    ORDER BY u.name
  `).all();

  res.render('units/list', { units });
}));

router.post('/', requirePermission('unidades', 'agregar'), asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/inventario/unidades?error=El nombre es obligatorio');
  }

  try {
    await db.prepare('INSERT INTO units (name) VALUES (?)').run(name.trim());
  } catch (err) {
    return res.redirect('/inventario/unidades?error=Ya existe una unidad con ese nombre');
  }

  await logActivity(req, `Creó la unidad "${name.trim()}"`);
  res.redirect('/inventario/unidades');
}));

router.post('/:id/delete', requirePermission('unidades', 'eliminar'), asyncHandler(async (req, res) => {
  const { n: productsUsingUnit } = await db.prepare('SELECT COUNT(*)::int AS n FROM products WHERE unit_id = ?').get(req.params.id);
  const { n: conversionsUsingUnit } = await db.prepare('SELECT COUNT(*)::int AS n FROM product_unit_conversions WHERE target_unit_id = ?').get(req.params.id);

  if (productsUsingUnit > 0 || conversionsUsingUnit > 0) {
    return res.redirect('/inventario/unidades?error=No se puede eliminar: hay productos o conversiones usando esta unidad');
  }

  const unit = await db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  await logActivity(req, `Eliminó la unidad "${unit?.name || req.params.id}"`);
  res.redirect('/inventario/unidades');
}));

export default router;
