import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

router.get('/', requirePermission('dashboard', 'consultar'), asyncHandler(async (req, res) => {
  const { total_products, total_units } = await db.prepare(`
    SELECT
      COUNT(*)::int AS total_products,
      COALESCE(SUM(quantity), 0) AS total_units
    FROM products
  `).get();

  const lowStock = await db.prepare(`
    SELECT p.*, c.name AS category_name, u.name AS unit_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN units u ON u.id = p.unit_id
    WHERE p.quantity <= p.min_stock
    ORDER BY p.quantity ASC
  `).all();

  const recentMovements = await db.prepare(`
    SELECT m.*, COALESCE(p.name, s.description) AS product_name
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN supplies s ON s.id = m.supply_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 10
  `).all();

  res.render('dashboard', {
    totalProducts: total_products,
    totalUnits: total_units,
    lowStock,
    recentMovements,
    colorHexByName: await getColorHexMap()
  });
}));

export default router;
