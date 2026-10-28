import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';

const router = Router();

router.get('/', requirePermission('colores', 'consultar'), asyncHandler(async (req, res) => {
  const colors = await db.prepare('SELECT * FROM colors ORDER BY name').all();
  res.render('colors/list', { colors });
}));

router.post('/', requirePermission('colores', 'agregar'), asyncHandler(async (req, res) => {
  const { name, hex } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/inventario/colores?error=El nombre es obligatorio');
  }

  try {
    await db.prepare('INSERT INTO colors (name, hex) VALUES (?, ?)').run(name.trim(), hex?.trim() || null);
  } catch (err) {
    return res.redirect('/inventario/colores?error=Ya existe un color con ese nombre');
  }

  await logActivity(req, `Creó el color "${name.trim()}" en la paleta`);
  res.redirect('/inventario/colores');
}));

router.post('/:id/delete', requirePermission('colores', 'eliminar'), asyncHandler(async (req, res) => {
  const color = await db.prepare('SELECT * FROM colors WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM colors WHERE id = ?').run(req.params.id);
  await logActivity(req, `Eliminó el color "${color?.name || req.params.id}" de la paleta`);
  res.redirect('/inventario/colores');
}));

export default router;
