import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';
import { getColorHexMap } from '../colorPalette.js';

const router = Router();

function round(num) {
  return Math.round(num * 10000) / 10000;
}

function buildDimensions(p) {
  const parts = [p.width, p.length, p.thickness].filter((v) => v !== null && v !== undefined);
  if (parts.length === 0) return '—';
  return parts.join(' x ');
}

function buildBackUrl(body) {
  const params = new URLSearchParams();
  if (body.bodega) params.set('bodega', body.bodega);
  if (body.categoria) params.set('categoria', body.categoria);
  if (body.subcategoria) params.set('subcategoria', body.subcategoria);
  if (body.q) params.set('q', body.q);
  return `/inventario/toma-fisica?${params.toString()}`;
}

async function adjustWarehouseStock(tx, productId, warehouseId, delta) {
  const existing = await tx.prepare('SELECT * FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId);
  if (existing) {
    await tx.prepare('UPDATE product_warehouse_stock SET quantity = ? WHERE id = ?').run(round(existing.quantity + delta), existing.id);
  } else {
    await tx.prepare('INSERT INTO product_warehouse_stock (product_id, warehouse_id, quantity) VALUES (?, ?, ?)').run(productId, warehouseId, round(delta));
  }
}

router.get('/', requirePermission('toma_fisica', 'consultar'), asyncHandler(async (req, res) => {
  const warehouses = await db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const allCategories = await db.prepare('SELECT * FROM categories ORDER BY name').all();
  const suppliesCategory = allCategories.find((c) => !c.parent_id && c.name === 'Suministros Varios');
  const categories = allCategories.filter((c) => !suppliesCategory
    || (c.id !== suppliesCategory.id && c.parent_id !== suppliesCategory.id));
  const topCategories = categories.filter((c) => !c.parent_id);
  const subcategories = categories.filter((c) => c.parent_id);

  const warehouseId = req.query.bodega ? Number(req.query.bodega) : null;
  const requestedSubcategoryId = req.query.subcategoria ? Number(req.query.subcategoria) : null;
  const requestedCategoryId = req.query.categoria ? Number(req.query.categoria) : null;
  const subcategoryId = subcategories.some((c) => c.id === requestedSubcategoryId) ? requestedSubcategoryId : null;
  const categoryId = topCategories.some((c) => c.id === requestedCategoryId) ? requestedCategoryId : null;
  const search = req.query.q?.trim() || '';

  let categoryIds = null;
  if (subcategoryId) {
    categoryIds = [subcategoryId];
  } else if (categoryId) {
    const subIds = subcategories.filter((c) => c.parent_id === categoryId).map((c) => c.id);
    categoryIds = [categoryId, ...subIds];
  }

  let items = [];
  if (warehouseId) {
    const whereConditions = ['1 = 1'];
    const whereParams = [];
    if (categoryIds) {
      whereConditions.push(`p.category_id IN (${categoryIds.map(() => '?').join(', ')})`);
      whereParams.push(...categoryIds);
    }
    if (search) {
      whereConditions.push(`(
        p.name ILIKE ?
        OR p.sku ILIKE ?
        OR p.color ILIKE ?
        OR (COALESCE(p.width::text, '') || 'x' || COALESCE(p.length::text, '')) ILIKE ?
      )`);
      whereParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    items = await db.prepare(`
      SELECT p.id, p.sku, p.name, p.color, p.width, p.length, p.thickness, p.has_printing, p.unit_id,
             u.name AS unit_name,
             ppc.printing_colors_text,
             COALESCE(pws.quantity, 0) AS stock_sistema
      FROM products p
      LEFT JOIN units u ON u.id = p.unit_id
      LEFT JOIN (
        SELECT product_id, string_agg(color_name, ' / ' ORDER BY position) AS printing_colors_text
        FROM product_printing_colors
        GROUP BY product_id
      ) ppc ON ppc.product_id = p.id
      LEFT JOIN product_warehouse_stock pws ON pws.product_id = p.id AND pws.warehouse_id = ?
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY p.name
    `).all(warehouseId, ...whereParams);

    items.forEach((it) => {
      it.dimensions = buildDimensions(it);
      it.stock_sistema = round(Number(it.stock_sistema));
    });
  }

  res.render('toma-fisica/list', {
    items,
    warehouses,
    topCategories,
    subcategories,
    filters: {
      bodega: warehouseId || '',
      categoria: categoryId || '',
      subcategoria: subcategoryId || '',
      q: search
    },
    colorHexByName: await getColorHexMap()
  });
}));

router.post('/aplicar', requirePermission('toma_fisica', 'agregar'), asyncHandler(async (req, res) => {
  const warehouseId = req.body.bodega ? Number(req.body.bodega) : null;
  const nota = req.body.nota?.trim() || '';
  const contada = req.body.contada || {};

  if (!warehouseId) {
    return res.redirect(`${buildBackUrl(req.body)}&error=${encodeURIComponent('Selecciona la bodega')}`);
  }

  const warehouse = await db.prepare('SELECT * FROM warehouses WHERE id = ?').get(warehouseId);
  if (!warehouse) {
    return res.redirect(`${buildBackUrl(req.body)}&error=${encodeURIComponent('La bodega seleccionada no existe')}`);
  }

  const productIds = Object.keys(contada)
    .map(Number)
    .filter((id) => Number.isInteger(id) && contada[id] !== '' && contada[id] !== undefined && !Number.isNaN(Number(contada[id])));

  if (productIds.length === 0) {
    return res.redirect(`${buildBackUrl(req.body)}&error=${encodeURIComponent('No ingresaste ninguna cantidad contada')}`);
  }

  const reason = nota ? `Toma física - ${nota}` : 'Toma física';
  const increases = [];
  const decreases = [];
  let batchIn = null;
  let batchOut = null;

  const tx = await db.beginTransaction();
  try {
    for (const productId of productIds) {
      const counted = Math.max(0, round(Number(contada[productId])));
      const product = await tx.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      if (!product) continue;

      const stockRow = await tx.prepare('SELECT * FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId);
      const current = stockRow ? stockRow.quantity : 0;
      const delta = round(counted - current);
      if (delta === 0) continue;

      if (delta > 0) increases.push({ product, delta });
      else decreases.push({ product, delta: -delta });
    }

    if (increases.length === 0 && decreases.length === 0) {
      await tx.rollback();
      return res.redirect(`${buildBackUrl(req.body)}&error=${encodeURIComponent('No hay cambios para aplicar')}`);
    }

    if (increases.length > 0) {
      const batchInfo = await tx.prepare(`
        INSERT INTO movement_batches (type, warehouse_id, reason, created_by)
        VALUES ('in', ?, ?, ?)
        RETURNING id
      `).run(warehouseId, reason, req.user.id);
      batchIn = batchInfo.lastInsertRowid;

      for (const { product, delta } of increases) {
        const freshProduct = await tx.prepare('SELECT quantity FROM products WHERE id = ?').get(product.id);
        await tx.prepare('UPDATE products SET quantity = ? WHERE id = ?').run(round(freshProduct.quantity + delta), product.id);
        await adjustWarehouseStock(tx, product.id, warehouseId, delta);
        await tx.prepare(`
          INSERT INTO movements (batch_id, item_type, product_id, type, quantity, input_unit_id, input_quantity, warehouse_id, reason, created_by)
          VALUES (?, 'product', ?, 'in', ?, ?, ?, ?, ?, ?)
        `).run(batchIn, product.id, delta, product.unit_id, delta, warehouseId, reason, req.user.id);
      }
    }

    if (decreases.length > 0) {
      const batchInfo = await tx.prepare(`
        INSERT INTO movement_batches (type, warehouse_id, reason, created_by)
        VALUES ('out', ?, ?, ?)
        RETURNING id
      `).run(warehouseId, reason, req.user.id);
      batchOut = batchInfo.lastInsertRowid;

      for (const { product, delta } of decreases) {
        const freshProduct = await tx.prepare('SELECT quantity FROM products WHERE id = ?').get(product.id);
        await tx.prepare('UPDATE products SET quantity = ? WHERE id = ?').run(round(freshProduct.quantity - delta), product.id);
        await adjustWarehouseStock(tx, product.id, warehouseId, -delta);
        await tx.prepare(`
          INSERT INTO movements (batch_id, item_type, product_id, type, quantity, input_unit_id, input_quantity, warehouse_id, reason, created_by)
          VALUES (?, 'product', ?, 'out', ?, ?, ?, ?, ?, ?)
        `).run(batchOut, product.id, delta, product.unit_id, delta, warehouseId, reason, req.user.id);
      }
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    return res.redirect(`${buildBackUrl(req.body)}&error=${encodeURIComponent('No se pudo aplicar la toma física')}`);
  }

  const totalAjustes = increases.length + decreases.length;
  await logActivity(req, `Registró una toma física en ${warehouse.name} con ${totalAjustes} ajuste(s) (${increases.length} incrementos, ${decreases.length} disminuciones)`);

  const params = new URLSearchParams(buildBackUrl(req.body).split('?')[1]);
  params.set('ok', '1');
  if (batchIn) params.set('lote_in', batchIn);
  if (batchOut) params.set('lote_out', batchOut);
  res.redirect(`/inventario/toma-fisica?${params.toString()}`);
}));

export default router;
