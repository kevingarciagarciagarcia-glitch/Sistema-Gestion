import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission, hasPermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

const FIXED_CATEGORY_WINDOW_KEYS = {
  'Materia Prima': 'stock_materia_prima',
  'Producto en Producción': 'stock_produccion',
  'Producto Terminado': 'stock_terminado'
};

function round(num) {
  return Math.round(num * 100) / 100;
}

function buildDimensions(p) {
  const parts = [p.width, p.length, p.thickness].filter((v) => v !== null && v !== undefined);
  if (parts.length === 0) return '—';
  return parts.join(' x ');
}

router.get('/', requirePermission('stock', 'consultar'), asyncHandler(async (req, res) => {
  const warehouses = await db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const allCategories = await db.prepare('SELECT * FROM categories ORDER BY name').all();
  const suppliesCategory = allCategories.find((c) => !c.parent_id && c.name === 'Suministros Varios');
  const categories = allCategories.filter((c) => !suppliesCategory
    || (c.id !== suppliesCategory.id && c.parent_id !== suppliesCategory.id));
  const allTopCategories = categories.filter((c) => !c.parent_id);
  const allSubcategories = categories.filter((c) => c.parent_id);

  const isTopCategoryAllowed = (top) => {
    const windowKey = FIXED_CATEGORY_WINDOW_KEYS[top.name];
    return !windowKey || hasPermission(req.user, windowKey, 'consultar');
  };
  const topCategories = allTopCategories.filter(isTopCategoryAllowed);
  const subcategories = allSubcategories.filter((c) => topCategories.some((t) => t.id === c.parent_id));
  const fullCategoryAccess = topCategories.length === allTopCategories.length;
  const allowedCategoryIds = topCategories.flatMap((top) => [
    top.id,
    ...allSubcategories.filter((s) => s.parent_id === top.id).map((s) => s.id)
  ]);

  const { today } = await db.prepare(`
    SELECT to_char(now() AT TIME ZONE 'America/Guayaquil', 'YYYY-MM-DD') AS today
  `).get();

  const warehouseId = req.query.bodega ? Number(req.query.bodega) : null;
  const cutoff = req.query.fecha_corte?.trim() || today;
  const requestedSubcategoryId = req.query.subcategoria ? Number(req.query.subcategoria) : null;
  const requestedCategoryId = req.query.categoria ? Number(req.query.categoria) : null;
  const subcategoryId = subcategories.some((c) => c.id === requestedSubcategoryId) ? requestedSubcategoryId : null;
  const categoryId = topCategories.some((c) => c.id === requestedCategoryId) ? requestedCategoryId : null;
  const search = req.query.q?.trim() || '';
  const measures = req.query.medidas?.trim() || '';
  const color = req.query.color?.trim() || '';
  const onlyAvailable = req.query.solo_disponible === '1';

  let categoryIds = null;
  if (subcategoryId) {
    categoryIds = [subcategoryId];
  } else if (categoryId) {
    const subIds = subcategories.filter((c) => c.parent_id === categoryId).map((c) => c.id);
    categoryIds = [categoryId, ...subIds];
  }

  if (!fullCategoryAccess) {
    categoryIds = categoryIds
      ? categoryIds.filter((id) => allowedCategoryIds.includes(id))
      : allowedCategoryIds;
  }

  const mvParams = [];
  let mvSelect;
  if (warehouseId) {
    mvSelect = `
      SELECT product_id, SUM(
        CASE
          WHEN type = 'in' AND warehouse_id = ? THEN quantity
          WHEN type = 'out' AND warehouse_id = ? THEN -quantity
          WHEN type = 'traspaso' AND to_warehouse_id = ? THEN quantity
          WHEN type = 'traspaso' AND from_warehouse_id = ? THEN -quantity
          ELSE 0
        END
      ) AS stock_actual
      FROM movements
      WHERE item_type = 'product' AND created_at <= ?
      GROUP BY product_id
    `;
    mvParams.push(warehouseId, warehouseId, warehouseId, warehouseId, `${cutoff} 23:59:59`);
  } else {
    mvSelect = `
      SELECT product_id, SUM(
        CASE WHEN type = 'in' THEN quantity WHEN type = 'out' THEN -quantity ELSE 0 END
      ) AS stock_actual
      FROM movements
      WHERE item_type = 'product' AND created_at <= ?
      GROUP BY product_id
    `;
    mvParams.push(`${cutoff} 23:59:59`);
  }

  const whereConditions = ['1 = 1'];
  const whereParams = [];
  if (categoryIds && categoryIds.length === 0) {
    whereConditions.push('0 = 1');
  } else if (categoryIds) {
    whereConditions.push(`p.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
    whereParams.push(...categoryIds);
  }
  if (search) {
    whereConditions.push('(p.name ILIKE ? OR p.sku ILIKE ?)');
    whereParams.push(`%${search}%`, `%${search}%`);
  }
  if (measures) {
    whereConditions.push(`(COALESCE(p.width::text, '') || 'x' || COALESCE(p.length::text, '')) ILIKE ?`);
    whereParams.push(`%${measures.replace(/x/gi, 'x')}%`);
  }
  if (color) {
    whereConditions.push('p.color ILIKE ?');
    whereParams.push(`%${color}%`);
  }

  const items = await db.prepare(`
    SELECT p.id, p.sku, p.name, p.color, p.width, p.length, p.thickness, p.has_printing, p.unit_id,
           u.name AS unit_name,
           ppc.printing_colors_text,
           COALESCE(mv.stock_actual, 0) AS stock_actual,
           COALESCE(pend.solicitado, 0) AS stock_solicitado
    FROM products p
    LEFT JOIN units u ON u.id = p.unit_id
    LEFT JOIN (
      SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
      FROM product_printing_colors
      GROUP BY product_id
    ) ppc ON ppc.product_id = p.id
    LEFT JOIN (${mvSelect}) mv ON mv.product_id = p.id
    LEFT JOIN (
      SELECT oi.product_id, SUM(GREATEST(oi.quantity - COALESCE(d.dispatched, 0), 0)) AS solicitado
      FROM sales_order_items oi
      LEFT JOIN (
        SELECT order_item_id, SUM(quantity) AS dispatched
        FROM order_dispatch_items
        GROUP BY order_item_id
      ) d ON d.order_item_id = oi.id
      WHERE oi.product_id IS NOT NULL
      GROUP BY oi.product_id
    ) pend ON pend.product_id = p.id
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY p.name
  `).all(...mvParams, ...whereParams);

  items.forEach((it) => {
    it.dimensions = buildDimensions(it);
    it.stock_actual = round(Number(it.stock_actual));
    it.stock_solicitado = round(Number(it.stock_solicitado));
    it.stock_disponible = round(it.stock_actual - it.stock_solicitado);
  });

  const filteredItems = onlyAvailable ? items.filter((it) => it.stock_disponible > 0) : items;

  res.render('stock/list', {
    items: filteredItems,
    warehouses,
    topCategories,
    subcategories,
    filters: {
      bodega: warehouseId || '',
      fecha_corte: cutoff,
      categoria: categoryId || '',
      subcategoria: subcategoryId || '',
      q: search,
      medidas: measures,
      color,
      solo_disponible: onlyAvailable
    },
    colorHexByName: await getColorHexMap()
  });
}));

export default router;
