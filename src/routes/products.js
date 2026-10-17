import { Router } from 'express';
import multer from 'multer';
import db from '../db/index.js';
import { hasPermission, requirePermission } from '../auth.js';
import { buildTemplateWorkbook, importFromBuffer } from '../bulkImport.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const PRODUCT_WINDOW_KEYS = ['materia_prima', 'produccion', 'terminado'];
const MAX_CONVERSIONS = 4;
const PRINTING_TYPES = ['serigrafia', 'flexografia'];
const PRINTING_SIDES = ['anverso', 'reverso', 'anverso_reverso'];
const FUELLE_TYPES = ['lateral', 'fondo', 'superior_fondo'];

function getProductOr404(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

async function getCategoryOptions() {
  const categories = await db.prepare('SELECT * FROM categories ORDER BY name').all();
  const topLevel = categories.filter((c) => !c.parent_id);

  const options = [];
  topLevel.forEach((parent) => {
    options.push({ id: parent.id, label: parent.name });
    categories
      .filter((c) => c.parent_id === parent.id)
      .forEach((sub) => options.push({ id: sub.id, label: `— ${sub.name}` }));
  });
  return options;
}

function getUnits() {
  return db.prepare('SELECT * FROM units ORDER BY name').all();
}

async function getFixedCategoryTree(name) {
  const top = await db.prepare('SELECT * FROM categories WHERE name = ? AND parent_id IS NULL').get(name);
  if (!top) return { top: null, categoryIds: [] };

  const subIds = (await db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(top.id)).map((c) => c.id);
  return { top, categoryIds: [top.id, ...subIds] };
}

function listProductsByFixedCategory(categoryName, view) {
  return asyncHandler(async (req, res) => {
    const { top, categoryIds } = await getFixedCategoryTree(categoryName);
    const search = req.query.q?.trim() || '';
    const measures = req.query.medidas?.trim() || '';
    const color = req.query.color?.trim() || '';

    let products = [];
    if (categoryIds.length > 0) {
      const placeholders = categoryIds.map(() => '?').join(', ');
      const conditions = [`p.category_id IN (${placeholders})`, '(p.name ILIKE ? OR p.sku ILIKE ?)'];
      const params = [...categoryIds, `%${search}%`, `%${search}%`];

      if (measures) {
        conditions.push("(COALESCE(p.width::text, '') || 'x' || COALESCE(p.length::text, '')) ILIKE ?");
        params.push(`%${measures.replace(/x/gi, 'x')}%`);
      }
      if (color) {
        conditions.push('p.color ILIKE ?');
        params.push(`%${color}%`);
      }

      products = await db.prepare(`
        SELECT p.*, c.name AS category_name, u.name AS unit_name
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN units u ON u.id = p.unit_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.name
      `).all(...params);
    }

    const importResult = req.session.importResult || null;
    delete req.session.importResult;

    res.render(view, { products, search, measures, color, topCategoryId: top?.id || '', importResult });
  });
}

const BULK_IMPORT_TYPES = {
  'materia-prima': { type: 'materia_prima', windowKey: 'materia_prima' },
  'produccion': { type: 'produccion', windowKey: 'produccion' },
  'terminado': { type: 'terminado', windowKey: 'terminado' }
};

function registerBulkRoutes(slug) {
  const { type, windowKey } = BULK_IMPORT_TYPES[slug];

  router.get(`/${slug}/plantilla`, requirePermission(windowKey, 'agregar'), asyncHandler(async (req, res) => {
    const workbook = await buildTemplateWorkbook(type);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="plantilla-${slug}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  }));

  router.post(`/${slug}/importar`, requirePermission(windowKey, 'agregar'), upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.redirect(`/inventario/productos/${slug}?error=Selecciona un archivo Excel para importar`);
    }

    try {
      req.session.importResult = await importFromBuffer(type, req.file.buffer);
    } catch (err) {
      req.session.importResult = { created: 0, errors: ['No se pudo leer el archivo. Verifica que sea el formato de la plantilla descargada.'] };
    }

    res.redirect(`/inventario/productos/${slug}`);
  }));
}

const FIXED_CATEGORY_SLUGS = {
  'Materia Prima': 'materia-prima',
  'Producto en Producción': 'produccion',
  'Producto Terminado': 'terminado'
};

async function getProductListUrl(categoryId) {
  if (categoryId) {
    const category = await db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
    const top = category?.parent_id
      ? await db.prepare('SELECT * FROM categories WHERE id = ?').get(category.parent_id)
      : category;
    const slug = top ? FIXED_CATEGORY_SLUGS[top.name] : null;
    if (slug) return `/inventario/productos/${slug}`;
  }
  return '/inventario/productos';
}

const FIXED_CATEGORY_WINDOW_KEYS = {
  'Materia Prima': 'materia_prima',
  'Producto en Producción': 'produccion',
  'Producto Terminado': 'terminado'
};

async function getWindowKeyForCategory(categoryId) {
  if (!categoryId) return null;
  const category = await db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  const top = category?.parent_id
    ? await db.prepare('SELECT * FROM categories WHERE id = ?').get(category.parent_id)
    : category;
  return top ? FIXED_CATEGORY_WINDOW_KEYS[top.name] || null : null;
}

function requireProductPermission(action) {
  return asyncHandler(async (req, res, next) => {
    let categoryId = req.body?.category_id || req.query?.category_id;
    if (!categoryId && req.params?.id) {
      const product = await db.prepare('SELECT category_id FROM products WHERE id = ?').get(req.params.id);
      categoryId = product?.category_id;
    }

    const windowKey = await getWindowKeyForCategory(categoryId);
    const keysToCheck = windowKey ? [windowKey] : PRODUCT_WINDOW_KEYS;
    const allowed = keysToCheck.some((key) => hasPermission(req.user, key, action));

    if (!allowed) {
      return res.status(403).render('403', { windowKey: windowKey || 'productos', action });
    }
    next();
  });
}

async function getProductConversions(productId) {
  const rows = await db.prepare(`
    SELECT * FROM product_unit_conversions WHERE product_id = ? ORDER BY id
  `).all(productId);

  const padded = rows.slice(0, MAX_CONVERSIONS);
  while (padded.length < MAX_CONVERSIONS) padded.push(null);
  return padded;
}

async function saveProductConversions(productId, body) {
  await db.prepare('DELETE FROM product_unit_conversions WHERE product_id = ?').run(productId);

  for (let i = 1; i <= MAX_CONVERSIONS; i++) {
    const base = Number(body[`conv_base_${i}`]);
    const unitId = body[`conv_unit_${i}`];
    const target = Number(body[`conv_qty_${i}`]);

    if (base > 0 && target > 0 && unitId) {
      await db.prepare(`
        INSERT INTO product_unit_conversions (product_id, base_quantity, target_unit_id, target_quantity)
        VALUES (?, ?, ?, ?)
      `).run(productId, base, unitId, target);
    }
  }
}

function parseProductExtras(body) {
  const hasPrinting = body.has_printing === 'on' || body.has_printing === '1' || body.has_printing === 'true';
  const hasFuelle = body.has_fuelle === 'on' || body.has_fuelle === '1' || body.has_fuelle === 'true';

  const extras = {
    width: body.width ? Number(body.width) : null,
    length: body.length ? Number(body.length) : null,
    thickness: body.thickness ? Number(body.thickness) : null,
    color: body.color?.trim() || null,
    has_printing: hasPrinting ? 1 : 0,
    printing_type: null,
    printing_side: null,
    printing_reference: null,
    printing_colors: null,
    has_fuelle: hasFuelle ? 1 : 0,
    fuelle_type: null,
    fuelle_measure_1: null,
    fuelle_measure_2: null,
    spec_code: body.spec_code?.trim() || null,
    spec_brand: body.spec_brand?.trim() || null,
    spec_presentation: body.spec_presentation?.trim() || null
  };

  if (hasPrinting) {
    if (!PRINTING_TYPES.includes(body.printing_type)) {
      return { error: 'Selecciona un tipo de impresión válido' };
    }
    if (!PRINTING_SIDES.includes(body.printing_side)) {
      return { error: 'Selecciona el lado de impresión' };
    }
    extras.printing_type = body.printing_type;
    extras.printing_side = body.printing_side;
    extras.printing_reference = body.printing_reference?.trim() || null;
    extras.printing_colors = body.printing_colors ? Number(body.printing_colors) : null;
  }

  if (hasFuelle) {
    if (!FUELLE_TYPES.includes(body.fuelle_type)) {
      return { error: 'Selecciona el tipo de fuelle' };
    }
    extras.fuelle_type = body.fuelle_type;
    extras.fuelle_measure_1 = body.fuelle_measure_1 ? Number(body.fuelle_measure_1) : null;
    extras.fuelle_measure_2 = body.fuelle_type === 'superior_fondo' && body.fuelle_measure_2
      ? Number(body.fuelle_measure_2)
      : null;
  }

  return { extras };
}

router.get('/', requireProductPermission('consultar'), asyncHandler(async (req, res) => {
  const search = req.query.q?.trim() || '';
  const products = await db.prepare(`
    SELECT p.*, c.name AS category_name, parent.name AS parent_category_name, u.name AS unit_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories parent ON parent.id = c.parent_id
    LEFT JOIN units u ON u.id = p.unit_id
    WHERE p.name ILIKE ? OR p.sku ILIKE ?
    ORDER BY p.name
  `).all(`%${search}%`, `%${search}%`);

  res.render('products/list', { products, search });
}));

router.get('/materia-prima', requirePermission('materia_prima', 'consultar'), listProductsByFixedCategory('Materia Prima', 'products/list-materia-prima'));
router.get('/produccion', requirePermission('produccion', 'consultar'), listProductsByFixedCategory('Producto en Producción', 'products/list-produccion'));
router.get('/terminado', requirePermission('terminado', 'consultar'), listProductsByFixedCategory('Producto Terminado', 'products/list-terminado'));

registerBulkRoutes('materia-prima');
registerBulkRoutes('produccion');
registerBulkRoutes('terminado');

router.get('/new', requireProductPermission('agregar'), asyncHandler(async (req, res) => {
  const preselectCategoryId = req.query.category_id ? Number(req.query.category_id) : null;
  res.render('products/form', {
    product: null,
    categoryOptions: await getCategoryOptions(),
    units: await getUnits(),
    conversions: Array(MAX_CONVERSIONS).fill(null),
    preselectCategoryId,
    cancelUrl: await getProductListUrl(preselectCategoryId)
  });
}));

router.post('/', requireProductPermission('agregar'), asyncHandler(async (req, res) => {
  const { sku, name, category_id, unit_id, quantity, min_stock, description } = req.body;
  const categoryParam = category_id ? `&category_id=${category_id}` : '';

  if (!sku?.trim() || !name?.trim() || !unit_id) {
    return res.redirect(`/inventario/productos/new?error=SKU, nombre y unidad de medida son obligatorios${categoryParam}`);
  }

  const { extras, error } = parseProductExtras(req.body);
  if (error) {
    return res.redirect(`/inventario/productos/new?error=${encodeURIComponent(error)}${categoryParam}`);
  }

  let productId;
  try {
    const info = await db.prepare(`
      INSERT INTO products (
        sku, name, category_id, unit_id, quantity, min_stock, description,
        width, length, thickness, color,
        has_printing, printing_type, printing_side, printing_reference, printing_colors,
        has_fuelle, fuelle_type, fuelle_measure_1, fuelle_measure_2,
        spec_code, spec_brand, spec_presentation
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).run(
      sku.trim(),
      name.trim(),
      category_id || null,
      unit_id,
      Number(quantity) || 0,
      Number(min_stock) || 0,
      description?.trim() || null,
      extras.width,
      extras.length,
      extras.thickness,
      extras.color,
      extras.has_printing,
      extras.printing_type,
      extras.printing_side,
      extras.printing_reference,
      extras.printing_colors,
      extras.has_fuelle,
      extras.fuelle_type,
      extras.fuelle_measure_1,
      extras.fuelle_measure_2,
      extras.spec_code,
      extras.spec_brand,
      extras.spec_presentation
    );
    productId = info.lastInsertRowid;
  } catch (err) {
    return res.redirect(`/inventario/productos/new?error=Ya existe un producto con ese SKU${categoryParam}`);
  }

  await saveProductConversions(productId, req.body);

  res.redirect(await getProductListUrl(category_id));
}));

router.get('/:id/edit', requireProductPermission('modificar'), asyncHandler(async (req, res) => {
  const product = await getProductOr404(req.params.id);
  if (!product) return res.redirect('/inventario/productos');

  res.render('products/form', {
    product,
    categoryOptions: await getCategoryOptions(),
    units: await getUnits(),
    conversions: await getProductConversions(product.id),
    preselectCategoryId: null,
    cancelUrl: await getProductListUrl(product.category_id)
  });
}));

router.post('/:id', requireProductPermission('modificar'), asyncHandler(async (req, res) => {
  const { sku, name, category_id, unit_id, quantity, min_stock, description } = req.body;

  if (!sku?.trim() || !name?.trim() || !unit_id) {
    return res.redirect(`/inventario/productos/${req.params.id}/edit?error=SKU, nombre y unidad de medida son obligatorios`);
  }

  const { extras, error } = parseProductExtras(req.body);
  if (error) {
    return res.redirect(`/inventario/productos/${req.params.id}/edit?error=${encodeURIComponent(error)}`);
  }

  try {
    await db.prepare(`
      UPDATE products
      SET sku = ?, name = ?, category_id = ?, unit_id = ?, quantity = ?, min_stock = ?, description = ?,
          width = ?, length = ?, thickness = ?, color = ?,
          has_printing = ?, printing_type = ?, printing_side = ?, printing_reference = ?, printing_colors = ?,
          has_fuelle = ?, fuelle_type = ?, fuelle_measure_1 = ?, fuelle_measure_2 = ?,
          spec_code = ?, spec_brand = ?, spec_presentation = ?
      WHERE id = ?
    `).run(
      sku.trim(),
      name.trim(),
      category_id || null,
      unit_id,
      Number(quantity) || 0,
      Number(min_stock) || 0,
      description?.trim() || null,
      extras.width,
      extras.length,
      extras.thickness,
      extras.color,
      extras.has_printing,
      extras.printing_type,
      extras.printing_side,
      extras.printing_reference,
      extras.printing_colors,
      extras.has_fuelle,
      extras.fuelle_type,
      extras.fuelle_measure_1,
      extras.fuelle_measure_2,
      extras.spec_code,
      extras.spec_brand,
      extras.spec_presentation,
      req.params.id
    );
  } catch (err) {
    return res.redirect(`/inventario/productos/${req.params.id}/edit?error=Ya existe un producto con ese SKU`);
  }

  await saveProductConversions(req.params.id, req.body);

  res.redirect(await getProductListUrl(category_id));
}));

router.post('/:id/delete', requireProductPermission('eliminar'), asyncHandler(async (req, res) => {
  const product = await db.prepare('SELECT category_id FROM products WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.redirect(await getProductListUrl(product?.category_id));
}));

export default router;
