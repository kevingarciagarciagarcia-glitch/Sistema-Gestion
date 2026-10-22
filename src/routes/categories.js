import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';

const router = Router();

router.get('/', requirePermission('categorias', 'consultar'), asyncHandler(async (req, res) => {
  const categories = await db.prepare(`
    SELECT c.*, COUNT(p.id)::int AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id
    ORDER BY c.name
  `).all();

  const topLevel = categories.filter((c) => !c.parent_id);
  const tree = topLevel.map((parent) => ({
    ...parent,
    subcategories: categories.filter((c) => c.parent_id === parent.id)
  }));

  res.render('categories/list', { tree, topLevel });
}));

router.post('/', requirePermission('categorias', 'agregar'), asyncHandler(async (req, res) => {
  const { name, description, parent_id } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/inventario/categorias?error=El nombre es obligatorio');
  }

  try {
    await db.prepare('INSERT INTO categories (name, description, parent_id) VALUES (?, ?, ?)')
      .run(name.trim(), description?.trim() || null, parent_id || null);
  } catch (err) {
    return res.redirect('/inventario/categorias?error=Ya existe una categoría con ese nombre');
  }

  await logActivity(req, `Creó la categoría "${name.trim()}"`);
  res.redirect('/inventario/categorias');
}));

router.post('/:id/delete', requirePermission('categorias', 'eliminar'), asyncHandler(async (req, res) => {
  const category = await db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (category?.is_fixed) {
    return res.redirect('/inventario/categorias?error=Esta categoría es fija y no se puede eliminar');
  }

  const subcategoryIds = (await db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(req.params.id)).map((c) => c.id);
  const relevantIds = [Number(req.params.id), ...subcategoryIds];
  const placeholders = relevantIds.map(() => '?').join(', ');
  const { n } = await db.prepare(`SELECT COUNT(*)::int AS n FROM products WHERE category_id IN (${placeholders})`).get(...relevantIds);

  if (n > 0) {
    return res.redirect('/inventario/categorias?error=No se puede eliminar: hay productos usando esta categoría');
  }

  await db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  await logActivity(req, `Eliminó la categoría "${category?.name || req.params.id}"`);
  res.redirect('/inventario/categorias');
}));

export default router;
