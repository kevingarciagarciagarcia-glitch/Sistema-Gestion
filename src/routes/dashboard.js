import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

function round2(num) {
  return Math.round(num * 100) / 100;
}

router.get('/', requirePermission('dashboard', 'consultar'), asyncHandler(async (req, res) => {
  const { total_terminado } = await db.prepare(`
    SELECT COUNT(*)::int AS total_terminado
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id)
    WHERE top.name = 'Producto Terminado'
  `).get();

  const lowStock = await db.prepare(`
    SELECT p.*, c.name AS category_name, u.name AS unit_name, ppc.printing_colors_text
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id)
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    WHERE p.quantity <= p.min_stock AND top.name = 'Producto Terminado'
    ORDER BY (CASE WHEN p.min_stock > 0 THEN p.quantity / p.min_stock ELSE 0 END) ASC, p.quantity ASC
  `).all();

  lowStock.forEach((p) => {
    p.quantity = round2(p.quantity);
    p.min_stock = round2(p.min_stock);
    p.deficit = round2(p.min_stock - p.quantity);
  });

  const { today, thirty_days_ago: thirtyDaysAgo } = await db.prepare(`
    SELECT to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD') AS today,
           to_char((now() AT TIME ZONE 'America/Guayaquil') - interval '30 days', 'YYYY-MM-DD') AS thirty_days_ago
  `).get();

  const fromDate = req.query.desde || thirtyDaysAgo;
  const toDate = req.query.hasta || today;

  const rotationRows = await db.prepare(`
    SELECT p.id, p.sku, p.name, p.width, p.length, p.color, p.has_printing, ppc.printing_colors_text,
           u.name AS unit_name,
           COALESCE(SUM(m.quantity), 0) AS total_salida
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id)
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    LEFT JOIN movements m ON m.product_id = p.id AND m.item_type = 'product' AND m.type = 'out'
      AND m.created_at >= ? AND m.created_at <= ?
    WHERE top.name = 'Producto Terminado'
    GROUP BY p.id, p.sku, p.name, p.width, p.length, p.color, p.has_printing, ppc.printing_colors_text, u.name
  `).all(`${fromDate} 00:00:00`, `${toDate} 23:59:59`);

  rotationRows.forEach((r) => { r.total_salida = round2(Number(r.total_salida)); });

  const withSales = rotationRows.filter((r) => Number(r.total_salida) > 0);
  const topMostOut = [...withSales].sort((a, b) => b.total_salida - a.total_salida).slice(0, 10);
  const topLeastOut = [...rotationRows].sort((a, b) => a.total_salida - b.total_salida).slice(0, 10);
  const maxMostOut = Math.max(1, ...topMostOut.map((r) => Number(r.total_salida)));
  const maxLeastOut = Math.max(1, ...topLeastOut.map((r) => Number(r.total_salida)));

  const recentMovements = await db.prepare(`
    SELECT m.*, p.name AS product_name, p.width, p.length, p.color, p.has_printing, ppc.printing_colors_text
    FROM movements m
    JOIN products p ON p.id = m.product_id
    JOIN categories c ON c.id = p.category_id
    JOIN categories top ON top.id = COALESCE(c.parent_id, c.id)
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    WHERE m.item_type = 'product' AND top.name = 'Producto Terminado'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 10
  `).all();

  res.render('dashboard', {
    totalTerminado: total_terminado,
    lowStock,
    rotation: { topMostOut, topLeastOut, maxMostOut, maxLeastOut, fromDate, toDate },
    recentMovements,
    colorHexByName: await getColorHexMap()
  });
}));

export default router;
