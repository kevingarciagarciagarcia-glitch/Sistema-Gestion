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

async function getWarehouseStock(executor, itemType, itemId, warehouseId) {
  const table = getStockTable(itemType);
  const column = getItemColumn(itemType);
  const row = await executor.prepare(`SELECT quantity FROM ${table} WHERE ${column} = ? AND warehouse_id = ?`).get(itemId, warehouseId);
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
    if (product.width !== null && product.width !== undefined && product.length !== null && product.length !== undefined) {
      extraFields.push(`${product.width}x${product.length}`);
    }
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

async function findConversionFactor(executor, item, chosenUnitId) {
  if (Number(chosenUnitId) === Number(item.unit_id)) return 1;

  const conv = await executor.prepare(`
    SELECT * FROM product_unit_conversions WHERE product_id = ? AND target_unit_id = ?
  `).get(item.id, chosenUnitId);

  if (!conv) return null;

  return conv.base_quantity / conv.target_quantity;
}

async function getItemsFormData() {
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

  return { items, warehouses, itemUnitOptions };
}

function parseLinesFromBody(body, type) {
  const rawItems = body.items ? Object.values(body.items) : [];
  const lines = [];

  for (const raw of rawItems) {
    if (!raw.item_type || !raw.item_id) continue;

    if (!['product', 'supply'].includes(raw.item_type)) {
      return { error: 'Hay un elemento inválido en una de las líneas' };
    }
    if (raw.item_type === 'supply' && type === 'traspaso') {
      return { error: 'Los suministros solo admiten entradas y salidas' };
    }

    const enteredQty = Number(raw.quantity);
    if (!raw.unit_id || !enteredQty || enteredQty <= 0) {
      return { error: 'Completa la cantidad y la unidad de cada línea agregada' };
    }

    lines.push({ item_type: raw.item_type, item_id: raw.item_id, quantity: enteredQty, unit_id: raw.unit_id });
  }

  if (lines.length === 0) {
    return { error: 'Agrega al menos un producto o suministro' };
  }

  const seen = new Set();
  for (const line of lines) {
    const key = `${line.item_type}:${line.item_id}`;
    if (seen.has(key)) {
      return { error: 'Un mismo producto o suministro aparece en más de una línea: suma la cantidad en una sola línea' };
    }
    seen.add(key);
  }

  return { lines };
}

async function resolveLines(executor, lines, type, { warehouse_id, from_warehouse_id, to_warehouse_id }) {
  const resolved = [];

  for (const line of lines) {
    const item = line.item_type === 'product'
      ? await executor.prepare('SELECT * FROM products WHERE id = ?').get(line.item_id)
      : await executor.prepare('SELECT * FROM supplies WHERE id = ?').get(line.item_id);

    if (!item) {
      return { error: 'Uno de los elementos no fue encontrado' };
    }

    const label = item.name || item.description;

    const factor = line.item_type === 'product'
      ? await findConversionFactor(executor, item, line.unit_id)
      : (Number(line.unit_id) === Number(item.unit_id) ? 1 : null);

    if (factor === null) {
      return { error: `No existe una conversión de unidad para "${label}"` };
    }

    const convertedQty = round(line.quantity * factor);

    if (type === 'traspaso') {
      const stockAtOrigin = await getWarehouseStock(executor, line.item_type, item.id, from_warehouse_id);
      if (convertedQty > stockAtOrigin) {
        return { error: `No hay suficiente stock en la bodega origen para "${label}"` };
      }
    } else if (type === 'out' && convertedQty > item.quantity) {
      return { error: `No hay suficiente stock para la salida de "${label}"` };
    }

    resolved.push({ ...line, item, convertedQty });
  }

  return { resolved };
}

async function applyResolvedLines(tx, batchId, type, { warehouse_id, from_warehouse_id, to_warehouse_id }, reason, userId, resolved) {
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
        r.convertedQty, r.unit_id, r.quantity, from_warehouse_id, to_warehouse_id, reason?.trim() || null, userId
      );
    } else {
      const freshItem = await tx.prepare(`SELECT quantity FROM ${itemTable} WHERE id = ?`).get(r.item.id);
      const newQuantity = round(type === 'in' ? freshItem.quantity + r.convertedQty : freshItem.quantity - r.convertedQty);
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
        type, r.convertedQty, r.unit_id, r.quantity, warehouse_id, reason?.trim() || null, userId
      );
    }
  }
}

// Resuelve el ítem + cantidad convertida de una línea nueva, sin validar stock todavía
// (para usar junto con applyLineDelta, que valida el efecto neto real).
async function resolveLineQuantity(executor, line) {
  const item = line.item_type === 'product'
    ? await executor.prepare('SELECT * FROM products WHERE id = ?').get(line.item_id)
    : await executor.prepare('SELECT * FROM supplies WHERE id = ?').get(line.item_id);

  if (!item) return { error: 'Uno de los elementos no fue encontrado' };

  const label = item.name || item.description;
  const factor = line.item_type === 'product'
    ? await findConversionFactor(executor, item, line.unit_id)
    : (Number(line.unit_id) === Number(item.unit_id) ? 1 : null);

  if (factor === null) {
    return { error: `No existe una conversión de unidad para "${label}"` };
  }

  return { item, convertedQty: round(line.quantity * factor) };
}

// Aplica el cambio NETO de stock al pasar de oldQty -> newQty para un mismo ítem
// (oldQty=0 equivale a una línea nueva, newQty=0 equivale a eliminar la línea).
// Valida que el resultado nunca quede negativo, considerando el stock actual real.
async function applyLineDelta(tx, type, warehouseContext, itemType, itemId, label, oldQty, newQty) {
  const itemTable = itemType === 'product' ? 'products' : 'supplies';

  if (type === 'traspaso') {
    const delta = round(newQty - oldQty);
    if (delta === 0) return { ok: true };

    const fromStock = await getWarehouseStock(tx, itemType, itemId, warehouseContext.from_warehouse_id);
    if (round(fromStock - delta) < 0) {
      return { ok: false, error: `No hay suficiente stock en la bodega origen para "${label}"` };
    }
    const toStock = await getWarehouseStock(tx, itemType, itemId, warehouseContext.to_warehouse_id);
    if (round(toStock + delta) < 0) {
      return { ok: false, error: `No hay suficiente stock en la bodega destino para "${label}"` };
    }

    await adjustWarehouseStock(tx, itemType, itemId, warehouseContext.from_warehouse_id, -delta);
    await adjustWarehouseStock(tx, itemType, itemId, warehouseContext.to_warehouse_id, delta);
    return { ok: true };
  }

  const signedDelta = round((type === 'in' ? 1 : -1) * (newQty - oldQty));
  if (signedDelta === 0) return { ok: true };

  const item = await tx.prepare(`SELECT quantity FROM ${itemTable} WHERE id = ?`).get(itemId);
  const newTotal = round(item.quantity + signedDelta);
  if (newTotal < 0) {
    return { ok: false, error: `No hay suficiente stock para aplicar el cambio en "${label}"` };
  }
  const warehouseStock = await getWarehouseStock(tx, itemType, itemId, warehouseContext.warehouse_id);
  if (round(warehouseStock + signedDelta) < 0) {
    return { ok: false, error: `No hay suficiente stock en esa bodega para aplicar el cambio en "${label}"` };
  }

  await tx.prepare(`UPDATE ${itemTable} SET quantity = ? WHERE id = ?`).run(newTotal, itemId);
  await adjustWarehouseStock(tx, itemType, itemId, warehouseContext.warehouse_id, signedDelta);
  return { ok: true };
}

// Inserta las filas de movements para un lote YA aplicado al stock (usado al editar,
// donde el stock se ajusta aparte mediante applyLineDelta).
async function insertMovementRows(tx, batchId, type, { warehouse_id, from_warehouse_id, to_warehouse_id }, reason, userId, resolved) {
  for (const r of resolved) {
    if (type === 'traspaso') {
      await tx.prepare(`
        INSERT INTO movements (batch_id, item_type, product_id, supply_id, type, quantity, input_unit_id, input_quantity, from_warehouse_id, to_warehouse_id, reason, created_by)
        VALUES (?, ?, ?, ?, 'traspaso', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, r.item_type,
        r.item_type === 'product' ? r.item.id : null,
        r.item_type === 'supply' ? r.item.id : null,
        r.convertedQty, r.unit_id, r.quantity, from_warehouse_id, to_warehouse_id, reason?.trim() || null, userId
      );
    } else {
      await tx.prepare(`
        INSERT INTO movements (batch_id, item_type, product_id, supply_id, type, quantity, input_unit_id, input_quantity, warehouse_id, reason, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId, r.item_type,
        r.item_type === 'product' ? r.item.id : null,
        r.item_type === 'supply' ? r.item.id : null,
        type, r.convertedQty, r.unit_id, r.quantity, warehouse_id, reason?.trim() || null, userId
      );
    }
  }
}

// Revierte el efecto de stock de una línea de movimiento YA registrada (deshacer).
async function reverseLineEffect(tx, line) {
  const itemType = line.item_type;
  const itemId = line.product_id || line.supply_id;
  const itemTable = itemType === 'product' ? 'products' : 'supplies';

  if (line.type === 'traspaso') {
    await adjustWarehouseStock(tx, itemType, itemId, line.from_warehouse_id, line.quantity);
    await adjustWarehouseStock(tx, itemType, itemId, line.to_warehouse_id, -line.quantity);
  } else {
    const item = await tx.prepare(`SELECT quantity FROM ${itemTable} WHERE id = ?`).get(itemId);
    const reverseDelta = line.type === 'in' ? -line.quantity : line.quantity;
    await tx.prepare(`UPDATE ${itemTable} SET quantity = ? WHERE id = ?`).run(round(item.quantity + reverseDelta), itemId);
    await adjustWarehouseStock(tx, itemType, itemId, line.warehouse_id, reverseDelta);
  }
}

// Antes de revertir, confirma que no se vaya a dejar stock negativo (p.ej. si ya se consumió
// parte de ese stock en un movimiento posterior).
async function canReverseLine(executor, line) {
  const itemType = line.item_type;
  const itemId = line.product_id || line.supply_id;
  const itemTable = itemType === 'product' ? 'products' : 'supplies';
  const item = await executor.prepare(`SELECT name, description FROM ${itemTable} WHERE id = ?`).get(itemId);
  const label = item?.name || item?.description || `#${itemId}`;

  if (line.type === 'traspaso') {
    const stockAtTo = await getWarehouseStock(executor, itemType, itemId, line.to_warehouse_id);
    if (stockAtTo < line.quantity) {
      return { ok: false, error: `No se puede deshacer el traspaso de "${label}": ya no hay suficiente stock en la bodega destino` };
    }
  } else {
    const current = await executor.prepare(`SELECT quantity FROM ${itemTable} WHERE id = ?`).get(itemId);
    const reverseDelta = line.type === 'in' ? -line.quantity : line.quantity;
    if (round(current.quantity + reverseDelta) < 0) {
      return { ok: false, error: `No se puede deshacer el movimiento de "${label}": ya se usó parte de ese stock en otro movimiento` };
    }
    const warehouseStock = await getWarehouseStock(executor, itemType, itemId, line.warehouse_id);
    if (round(warehouseStock + reverseDelta) < 0) {
      return { ok: false, error: `No se puede deshacer el movimiento de "${label}": ya se usó parte de ese stock en esa bodega` };
    }
  }

  return { ok: true };
}

async function getBatchLines(batchId) {
  return db.prepare('SELECT * FROM movements WHERE batch_id = ? ORDER BY id').all(batchId);
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
  const { items, warehouses, itemUnitOptions } = await getItemsFormData();
  res.render('movements/form', { items, warehouses, itemUnitOptions, batch: null, existingLines: [] });
}));

router.post('/', requirePermission('movimientos', 'agregar'), asyncHandler(async (req, res) => {
  const { type, warehouse_id, from_warehouse_id, to_warehouse_id, reason } = req.body;

  if (!['in', 'out', 'traspaso'].includes(type)) {
    return res.redirect('/inventario/movimientos/new?error=Selecciona el tipo de movimiento');
  }

  const { lines, error: parseError } = parseLinesFromBody(req.body, type);
  if (parseError) {
    return res.redirect(`/inventario/movimientos/new?error=${encodeURIComponent(parseError)}`);
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

  const warehouseContext = { warehouse_id, from_warehouse_id, to_warehouse_id };
  const { resolved, error: resolveError } = await resolveLines(db, lines, type, warehouseContext);
  if (resolveError) {
    return res.redirect(`/inventario/movimientos/new?error=${encodeURIComponent(resolveError)}`);
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

    await applyResolvedLines(tx, batchId, type, warehouseContext, reason, req.user.id, resolved);

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    return res.redirect('/inventario/movimientos/new?error=No se pudo registrar el movimiento');
  }

  const typeLabel = type === 'in' ? 'entrada' : type === 'out' ? 'salida' : 'traspaso';
  const itemsSummary = resolved.map((r) => `${r.item.sku || r.item.code} (${r.quantity})`).join(', ');
  await logActivity(req, `Registró una hoja de ${typeLabel} con ${resolved.length} ítem(s): ${itemsSummary}`);

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
           p.width, p.length, p.color,
           baseUnit.name AS unit_name, inputUnit.name AS input_unit_name
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN units baseUnit ON baseUnit.id = COALESCE(p.unit_id, s.unit_id)
    LEFT JOIN units inputUnit ON inputUnit.id = m.input_unit_id
    WHERE m.batch_id = ?
    ORDER BY m.id
  `).all(req.params.id);

  res.render('movements/batch-view', { batch, lines, colorHexByName: await getColorHexMap() });
}));

router.get('/lote/:id/edit', requirePermission('movimientos', 'modificar'), asyncHandler(async (req, res) => {
  const batch = await db.prepare('SELECT * FROM movement_batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.redirect('/inventario/movimientos');

  const rawLines = await getBatchLines(batch.id);
  const { items, warehouses, itemUnitOptions } = await getItemsFormData();
  const categories = await db.prepare('SELECT * FROM categories').all();
  const categoriesById = Object.fromEntries(categories.map((c) => [c.id, c]));

  const existingLines = [];
  for (const line of rawLines) {
    if (line.item_type === 'product') {
      const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id);
      if (!product) continue;
      const { detail } = buildProductSearchMeta(product, categoriesById);
      existingLines.push({
        itemType: 'product', itemId: product.id,
        label: `[Producto] ${product.sku} — ${product.name}`,
        detail, quantity: line.input_quantity, unitId: line.input_unit_id
      });
    } else {
      const supply = await db.prepare('SELECT * FROM supplies WHERE id = ?').get(line.supply_id);
      if (!supply) continue;
      const { detail } = buildSupplySearchMeta(supply);
      existingLines.push({
        itemType: 'supply', itemId: supply.id,
        label: `[Suministro] ${supply.code} — ${supply.description}`,
        detail, quantity: line.input_quantity, unitId: line.input_unit_id
      });
    }
  }

  res.render('movements/form', { items, warehouses, itemUnitOptions, batch, existingLines });
}));

router.post('/lote/:id', requirePermission('movimientos', 'modificar'), asyncHandler(async (req, res) => {
  const batch = await db.prepare('SELECT * FROM movement_batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.redirect('/inventario/movimientos');

  const { type, warehouse_id, from_warehouse_id, to_warehouse_id, reason } = req.body;
  const editUrl = `/inventario/movimientos/lote/${batch.id}/edit`;

  if (!['in', 'out', 'traspaso'].includes(type)) {
    return res.redirect(`${editUrl}?error=Selecciona el tipo de movimiento`);
  }

  const { lines, error: parseError } = parseLinesFromBody(req.body, type);
  if (parseError) {
    return res.redirect(`${editUrl}?error=${encodeURIComponent(parseError)}`);
  }

  if (type === 'traspaso') {
    if (!from_warehouse_id || !to_warehouse_id) {
      return res.redirect(`${editUrl}?error=Selecciona bodega origen y destino`);
    }
    if (from_warehouse_id === to_warehouse_id) {
      return res.redirect(`${editUrl}?error=La bodega origen y destino deben ser distintas`);
    }
  } else if (!warehouse_id) {
    return res.redirect(`${editUrl}?error=Selecciona la bodega`);
  }

  const oldLines = await getBatchLines(batch.id);
  const newContext = { warehouse_id, from_warehouse_id, to_warehouse_id };
  const oldContext = {
    warehouse_id: batch.warehouse_id,
    from_warehouse_id: batch.from_warehouse_id,
    to_warehouse_id: batch.to_warehouse_id
  };
  const sameContext = type === batch.type
    && String(newContext.warehouse_id || '') === String(oldContext.warehouse_id || '')
    && String(newContext.from_warehouse_id || '') === String(oldContext.from_warehouse_id || '')
    && String(newContext.to_warehouse_id || '') === String(oldContext.to_warehouse_id || '');

  const oldByKey = new Map();
  for (const line of oldLines) {
    const itemId = line.product_id || line.supply_id;
    oldByKey.set(`${line.item_type}:${itemId}`, { itemId, itemType: line.item_type, qty: line.quantity });
  }

  const tx = await db.beginTransaction();
  try {
    const resolved = [];
    const newByKey = new Map();
    for (const line of lines) {
      const { item, convertedQty, error } = await resolveLineQuantity(tx, line);
      if (error) throw new Error(error);
      const key = `${line.item_type}:${item.id}`;
      newByKey.set(key, { item, convertedQty });
      resolved.push({ ...line, item, convertedQty });
    }

    const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
    for (const key of allKeys) {
      const oldEntry = oldByKey.get(key);
      const newEntry = newByKey.get(key);
      const itemType = oldEntry?.itemType || key.split(':')[0];
      const itemId = oldEntry?.itemId || newEntry?.item.id;
      const label = newEntry?.item ? (newEntry.item.name || newEntry.item.description) : `#${itemId}`;

      if (sameContext) {
        const result = await applyLineDelta(tx, type, newContext, itemType, itemId, label, oldEntry?.qty || 0, newEntry?.convertedQty || 0);
        if (!result.ok) throw new Error(result.error);
      } else {
        if (oldEntry) {
          const result = await applyLineDelta(tx, batch.type, oldContext, itemType, itemId, label, oldEntry.qty, 0);
          if (!result.ok) throw new Error(result.error);
        }
        if (newEntry) {
          const result = await applyLineDelta(tx, type, newContext, itemType, itemId, label, 0, newEntry.convertedQty);
          if (!result.ok) throw new Error(result.error);
        }
      }
    }

    await tx.prepare('DELETE FROM movements WHERE batch_id = ?').run(batch.id);
    await tx.prepare(`
      UPDATE movement_batches
      SET type = ?, warehouse_id = ?, from_warehouse_id = ?, to_warehouse_id = ?, reason = ?
      WHERE id = ?
    `).run(
      type,
      type === 'traspaso' ? null : warehouse_id,
      type === 'traspaso' ? from_warehouse_id : null,
      type === 'traspaso' ? to_warehouse_id : null,
      reason?.trim() || null,
      batch.id
    );

    await insertMovementRows(tx, batch.id, type, newContext, reason, batch.created_by, resolved);

    await tx.commit();

    const itemsSummary = resolved.map((r) => `${r.item.sku || r.item.code} (${r.quantity})`).join(', ');
    await logActivity(req, `Editó la hoja de movimiento #${batch.id}: ${itemsSummary}`);
  } catch (err) {
    await tx.rollback();
    return res.redirect(`${editUrl}?error=${encodeURIComponent(err.message || 'No se pudo guardar el movimiento')}`);
  }

  res.redirect(`/inventario/movimientos/lote/${batch.id}`);
}));

router.post('/lote/:id/delete', requirePermission('movimientos', 'eliminar'), asyncHandler(async (req, res) => {
  const batch = await db.prepare('SELECT * FROM movement_batches WHERE id = ?').get(req.params.id);
  if (!batch) return res.redirect('/inventario/movimientos');

  const oldLines = await getBatchLines(batch.id);

  const tx = await db.beginTransaction();
  try {
    for (const line of oldLines) {
      const check = await canReverseLine(tx, line);
      if (!check.ok) throw new Error(check.error);
      await reverseLineEffect(tx, line);
    }

    await tx.prepare('DELETE FROM movement_batches WHERE id = ?').run(batch.id);
    await tx.commit();

    await logActivity(req, `Eliminó la hoja de movimiento #${batch.id} y revirtió su efecto en el stock`);
  } catch (err) {
    await tx.rollback();
    return res.redirect(`/inventario/movimientos/lote/${batch.id}?error=${encodeURIComponent(err.message || 'No se pudo eliminar el movimiento')}`);
  }

  res.redirect('/inventario/movimientos');
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

  res.render('movements/view', { movement, showDimensions, showSpecs, showPrinting, colorHexByName: await getColorHexMap() });
}));

export default router;
