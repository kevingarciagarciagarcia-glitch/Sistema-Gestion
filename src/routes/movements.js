import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

function round(num) {
  return Math.round(num * 10000) / 10000;
}

function getStockTable(itemType) {
  return itemType === 'product' ? 'product_warehouse_stock' : 'supply_warehouse_stock';
}

function getItemColumn(itemType) {
  return itemType === 'product' ? 'product_id' : 'supply_id';
}

async function adjustWarehouseStock(executor, itemType, itemId, warehouseId, delta) {
  const table = getStockTable(itemType);
  const column = getItemColumn(itemType);
  const existing = await executor.prepare(`SELECT * FROM ${table} WHERE ${column} = ? AND warehouse_id = ?`).get(itemId, warehouseId);
  if (existing) {
    await executor.prepare(`UPDATE ${table} SET quantity = ? WHERE id = ?`).run(round(existing.quantity + delta), existing.id);
  } else {
    await executor.prepare(`INSERT INTO ${table} (${column}, warehouse_id, quantity) VALUES (?, ?, ?)`).run(itemId, warehouseId, round(delta));
  }
}

async function getWarehouseStock(itemType, itemId, warehouseId) {
  const table = getStockTable(itemType);
  const column = getItemColumn(itemType);
  const row = await db.prepare(`SELECT quantity FROM ${table} WHERE ${column} = ? AND warehouse_id = ?`).get(itemId, warehouseId);
  return row ? row.quantity : 0;
}

// factor: 1 unidad de esta opción equivale a `factor` unidades base del producto
function getUnitOptionsForProduct(product, conversionsByProduct, unitsById) {
  const options = [];
  if (product.unit_id && unitsById[product.unit_id]) {
    options.push({ unitId: product.unit_id, unitName: unitsById[product.unit_id].name, factor: 1 });
  }

  (conversionsByProduct[product.id] || []).forEach((c) => {
    options.push({
      unitId: c.target_unit_id,
      unitName: unitsById[c.target_unit_id]?.name,
      factor: round(c.base_quantity / c.target_quantity)
    });
  });

  return options;
}

const DIMENSION_CATEGORIES = ['Producto Terminado', 'Producto en Producción'];
const SPEC_CATEGORIES = ['Materia Prima'];

function getFixedCategoryName(categoryId, categoriesById) {
  if (!categoryId) return null;
  const category = categoriesById[categoryId];
  if (!category) return null;
  const top = category.parent_id ? categoriesById[category.parent_id] : category;
  return top ? top.name : null;
}

function buildProductSearchMeta(product, categoriesById) {
  const fixedCategory = getFixedCategoryName(product.category_id, categoriesById);
  const extraFields = [];
  const detailParts = [];

  if (DIMENSION_CATEGORIES.includes(fixedCategory)) {
    extraFields.push(product.color, product.width, product.length, product.thickness);
    if (product.color) detailParts.push(`Color: ${product.color}`);
    if (product.width !== null && product.width !== undefined) detailParts.push(`A: ${product.width}`);
    if (product.length !== null && product.length !== undefined) detailParts.push(`L: ${product.length}`);
    if (product.thickness !== null && product.thickness !== undefined) detailParts.push(`E: ${product.thickness}`);
  }
  if (SPEC_CATEGORIES.includes(fixedCategory)) {
    extraFields.push(product.spec_code, product.spec_brand, product.spec_presentation);
    if (product.spec_code) detailParts.push(`Código: ${product.spec_code}`);
    if (product.spec_brand) detailParts.push(`Marca: ${product.spec_brand}`);
    if (product.spec_presentation) detailParts.push(`Presentación: ${product.spec_presentation}`);
  }

  const searchText = [product.sku, product.name, ...extraFields]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ')
    .toLowerCase();

  return { searchText, detail: detailParts.join(' · ') };
}

function buildSupplySearchMeta(supply) {
  const detailParts = [];
  if (supply.associated_machine) detailParts.push(`Máquina: ${supply.associated_machine}`);
  if (supply.condition) detailParts.push(`Condición: ${supply.condition}`);
  if (supply.supplier) detailParts.push(`Proveedor: ${supply.supplier}`);

  const searchText = [supply.code, supply.description, supply.associated_machine, supply.condition, supply.supplier]
    .filter((v) => v !== null && v !== undefined && v !== '')
    .join(' ')
    .toLowerCase();

  return { searchText, detail: detailParts.join(' · ') };
}

async function findConversionFactor(item, chosenUnitId) {
  if (Number(chosenUnitId) === Number(item.unit_id)) return 1;

  const conv = await db.prepare(`
    SELECT * FROM product_unit_conversions WHERE product_id = ? AND target_unit_id = ?
  `).get(item.id, chosenUnitId);

  if (!conv) return null;

  return conv.base_quantity / conv.target_quantity;
}

router.get('/', requirePermission('movimientos', 'consultar'), asyncHandler(async (req, res) => {
  const movements = await db.prepare(`
    SELECT m.*,
           COALESCE(p.sku, s.code) AS item_code,
           COALESCE(p.name, s.description) AS item_name,
           COALESCE(p.unit_id, s.unit_id) AS item_unit_id,
           baseUnit.name AS unit_name, inputUnit.name AS input_unit_name,
           w.name AS warehouse_name, fromW.name AS from_warehouse_name, toW.name AS to_warehouse_name
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN units baseUnit ON baseUnit.id = COALESCE(p.unit_id, s.unit_id)
    LEFT JOIN units inputUnit ON inputUnit.id = m.input_unit_id
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN warehouses fromW ON fromW.id = m.from_warehouse_id
    LEFT JOIN warehouses toW ON toW.id = m.to_warehouse_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 200
  `).all();

  res.render('movements/list', { movements });
}));

router.get('/new', requirePermission('movimientos', 'agregar'), asyncHandler(async (req, res) => {
  const products = await db.prepare('SELECT * FROM products ORDER BY name').all();
  const supplies = await db.prepare('SELECT * FROM supplies ORDER BY description').all();
  const units = await db.prepare('SELECT * FROM units ORDER BY name').all();
  const warehouses = await db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const allConversions = await db.prepare('SELECT * FROM product_unit_conversions').all();
  const categories = await db.prepare('SELECT * FROM categories').all();
  const unitsById = Object.fromEntries(units.map((u) => [u.id, u]));
  const categoriesById = Object.fromEntries(categories.map((c) => [c.id, c]));

  const conversionsByProduct = {};
  allConversions.forEach((c) => {
    if (!conversionsByProduct[c.product_id]) conversionsByProduct[c.product_id] = [];
    conversionsByProduct[c.product_id].push(c);
  });

  const itemUnitOptions = {};
  const items = [];

  products.forEach((p) => {
    itemUnitOptions[`product:${p.id}`] = getUnitOptionsForProduct(p, conversionsByProduct, unitsById);
    const { searchText, detail } = buildProductSearchMeta(p, categoriesById);
    items.push({ type: 'product', id: p.id, sku: p.sku, name: p.name, quantity: p.quantity, searchText, detail });
  });

  supplies.forEach((s) => {
    itemUnitOptions[`supply:${s.id}`] = (s.unit_id && unitsById[s.unit_id])
      ? [{ unitId: s.unit_id, unitName: unitsById[s.unit_id].name, factor: 1 }]
      : [];
    const { searchText, detail } = buildSupplySearchMeta(s);
    items.push({ type: 'supply', id: s.id, sku: s.code, name: s.description, quantity: s.quantity, searchText, detail });
  });

  res.render('movements/form', { items, warehouses, itemUnitOptions });
}));

router.post('/', requirePermission('movimientos', 'agregar'), asyncHandler(async (req, res) => {
  const { type, warehouse_id, from_warehouse_id, to_warehouse_id, reason } = req.body;
  const rawItems = req.body.items ? Object.values(req.body.items) : [];

  if (!['in', 'out', 'traspaso'].includes(type)) {
    return res.redirect('/inventario/movimientos/new?error=Selecciona el tipo de movimiento');
  }

  const lines = [];
  for (const raw of rawItems) {
    if (!raw.item_type || !raw.item_id) continue;

    if (!['product', 'supply'].includes(raw.item_type)) {
      return res.redirect('/inventario/movimientos/new?error=Hay un elemento inválido en una de las líneas');
    }
    if (raw.item_type === 'supply' && type === 'traspaso') {
      return res.redirect('/inventario/movimientos/new?error=Los suministros solo admiten entradas y salidas');
    }

    const enteredQty = Number(raw.quantity);
    if (!raw.unit_id || !enteredQty || enteredQty <= 0) {
      return res.redirect('/inventario/movimientos/new?error=Completa la cantidad y la unidad de cada línea agregada');
    }

    lines.push({ item_type: raw.item_type, item_id: raw.item_id, quantity: enteredQty, unit_id: raw.unit_id });
  }

  if (lines.length === 0) {
    return res.redirect('/inventario/movimientos/new?error=Agrega al menos un producto o suministro');
  }

  const seen = new Set();
  for (const line of lines) {
    const key = `${line.item_type}:${line.item_id}`;
    if (seen.has(key)) {
      return res.redirect('/inventario/movimientos/new?error=Un mismo producto o suministro aparece en más de una línea: suma la cantidad en una sola línea');
    }
    seen.add(key);
  }

  if (type === 'traspaso') {
    if (!from_warehouse_id || !to_warehouse_id) {
      return res.redirect('/inventario/movimientos/new?error=Selecciona bodega origen y destino');
    }
    if (from_warehouse_id === to_warehouse_id) {
      return res.redirect('/inventario/movimientos/new?error=La bodega origen y destino deben ser distintas');
    }
  } else if (!warehouse_id) {
    return res.redirect('/inventario/movimientos/new?error=Selecciona la bodega');
  }

  const resolved = [];
  for (const line of lines) {
    const item = line.item_type === 'product'
      ? await db.prepare('SELECT * FROM products WHERE id = ?').get(line.item_id)
      : await db.prepare('SELECT * FROM supplies WHERE id = ?').get(line.item_id);

    if (!item) {
      return res.redirect('/inventario/movimientos/new?error=Uno de los elementos no fue encontrado');
    }

    const label = item.name || item.description;

    const factor = line.item_type === 'product'
      ? await findConversionFactor(item, line.unit_id)
      : (Number(line.unit_id) === Number(item.unit_id) ? 1 : null);

    if (factor === null) {
      return res.redirect(`/inventario/movimientos/new?error=${encodeURIComponent(`No existe una conversión de unidad para "${label}"`)}`);
    }

    const convertedQty = round(line.quantity * factor);

    if (type === 'traspaso') {
      const stockAtOrigin = await getWarehouseStock(line.item_type, item.id, from_warehouse_id);
      if (convertedQty > stockAtOrigin) {
        return res.redirect(`/inventario/movimientos/new?error=${encodeURIComponent(`No hay suficiente stock en la bodega origen para "${label}"`)}`);
      }
    } else if (type === 'out' && convertedQty > item.quantity) {
      return res.redirect(`/inventario/movimientos/new?error=${encodeURIComponent(`No hay suficiente stock para la salida de "${label}"`)}`);
    }

    resolved.push({ ...line, item, convertedQty });
  }

  let batchId;
  const tx = await db.beginTransaction();
  try {
    const batchInfo = await tx.prepare(`
      INSERT INTO movement_batches (type, warehouse_id, from_warehouse_id, to_warehouse_id, reason, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      type,
      type === 'traspaso' ? null : warehouse_id,
      type === 'traspaso' ? from_warehouse_id : null,
      type === 'traspaso' ? to_warehouse_id : null,
      reason?.trim() || null,
      req.user.id
    );
    batchId = batchInfo.lastInsertRowid;

    for (const r of resolved) {
      const itemTable = r.item_type === 'product' ? 'products' : 'supplies';

      if (type === 'traspaso') {
        await adjustWarehouseStock(tx, r.item_type, r.item.id, from_warehouse_id, -r.convertedQty);
        await adjustWarehouseStock(tx, r.item_type, r.item.id, to_warehouse_id, r.convertedQty);
        await tx.prepare(`
          INSERT INTO movements (batch_id, item_type, product_id, supply_id, type, quantity, input_unit_id, input_quantity, from_warehouse_id, to_warehouse_id, reason, created_by)
          VALUES (?, ?, ?, ?, 'traspaso', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId, r.item_type,
          r.item_type === 'product' ? r.item.id : null,
          r.item_type === 'supply' ? r.item.id : null,
          r.convertedQty, r.unit_id, r.quantity, from_warehouse_id, to_warehouse_id, reason?.trim() || null, req.user.id
        );
      } else {
        const newQuantity = round(type === 'in' ? r.item.quantity + r.convertedQty : r.item.quantity - r.convertedQty);
        const warehouseDelta = type === 'in' ? r.convertedQty : -r.convertedQty;

        await tx.prepare(`UPDATE ${itemTable} SET quantity = ? WHERE id = ?`).run(newQuantity, r.item.id);
        await adjustWarehouseStock(tx, r.item_type, r.item.id, warehouse_id, warehouseDelta);
        await tx.prepare(`
          INSERT INTO movements (batch_id, item_type, product_id, supply_id, type, quantity, input_unit_id, input_quantity, warehouse_id, reason, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          batchId, r.item_type,
          r.item_type === 'product' ? r.item.id : null,
          r.item_type === 'supply' ? r.item.id : null,
          type, r.convertedQty, r.unit_id, r.quantity, warehouse_id, reason?.trim() || null, req.user.id
        );
      }
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    return res.redirect('/inventario/movimientos/new?error=No se pudo registrar el movimiento');
  }

  res.redirect(`/inventario/movimientos/lote/${batchId}`);
}));

router.get('/lote/:id', requirePermission('movimientos', 'consultar'), asyncHandler(async (req, res) => {
  const batch = await db.prepare(`
    SELECT b.*, w.name AS warehouse_name, fromW.name AS from_warehouse_name, toW.name AS to_warehouse_name,
           u.full_name AS created_by_full_name, u.username AS created_by_username
    FROM movement_batches b
    LEFT JOIN warehouses w ON w.id = b.warehouse_id
    LEFT JOIN warehouses fromW ON fromW.id = b.from_warehouse_id
    LEFT JOIN warehouses toW ON toW.id = b.to_warehouse_id
    LEFT JOIN users u ON u.id = b.created_by
    WHERE b.id = ?
  `).get(req.params.id);

  if (!batch) return res.redirect('/inventario/movimientos');

  const lines = await db.prepare(`
    SELECT m.*,
           COALESCE(p.sku, s.code) AS item_code,
           COALESCE(p.name, s.description) AS item_name,
           COALESCE(p.unit_id, s.unit_id) AS item_unit_id,
           baseUnit.name AS unit_name, inputUnit.name AS input_unit_name
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN units baseUnit ON baseUnit.id = COALESCE(p.unit_id, s.unit_id)
    LEFT JOIN units inputUnit ON inputUnit.id = m.input_unit_id
    WHERE m.batch_id = ?
    ORDER BY m.id
  `).all(req.params.id);

  res.render('movements/batch-view', { batch, lines });
}));

router.get('/:id', requirePermission('movimientos', 'consultar'), asyncHandler(async (req, res) => {
  const movement = await db.prepare(`
    SELECT m.*,
           COALESCE(p.sku, s.code) AS item_code,
           COALESCE(p.name, s.description) AS item_name,
           COALESCE(p.unit_id, s.unit_id) AS item_unit_id,
           COALESCE(p.category_id, s.category_id) AS category_id,
           c.name AS category_name,
           p.color, p.width, p.length, p.thickness,
           p.has_fuelle, p.fuelle_type, p.fuelle_measure_1, p.fuelle_measure_2,
           p.has_printing, p.printing_type, p.printing_side, p.printing_reference, p.printing_colors,
           p.spec_code, p.spec_brand, p.spec_presentation,
           baseUnit.name AS unit_name, inputUnit.name AS input_unit_name,
           w.name AS warehouse_name, fromW.name AS from_warehouse_name, toW.name AS to_warehouse_name,
           u.full_name AS created_by_full_name, u.username AS created_by_username
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN categories c ON c.id = COALESCE(p.category_id, s.category_id)
    LEFT JOIN units baseUnit ON baseUnit.id = COALESCE(p.unit_id, s.unit_id)
    LEFT JOIN units inputUnit ON inputUnit.id = m.input_unit_id
    LEFT JOIN warehouses w ON w.id = m.warehouse_id
    LEFT JOIN warehouses fromW ON fromW.id = m.from_warehouse_id
    LEFT JOIN warehouses toW ON toW.id = m.to_warehouse_id
    LEFT JOIN users u ON u.id = m.created_by
    WHERE m.id = ?
  `).get(req.params.id);

  if (!movement) return res.redirect('/inventario/movimientos');

  if (movement.batch_id) {
    return res.redirect(`/inventario/movimientos/lote/${movement.batch_id}`);
  }

  const categories = await db.prepare('SELECT * FROM categories').all();
  const categoriesById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const fixedCategoryName = getFixedCategoryName(movement.category_id, categoriesById);

  const showDimensions = movement.item_type === 'product' && DIMENSION_CATEGORIES.includes(fixedCategoryName);
  const showSpecs = movement.item_type === 'product' && SPEC_CATEGORIES.includes(fixedCategoryName);
  const showPrinting = movement.item_type === 'product' && !!movement.has_printing;

  res.render('movements/view', { movement, showDimensions, showSpecs, showPrinting });
}));

export default router;
