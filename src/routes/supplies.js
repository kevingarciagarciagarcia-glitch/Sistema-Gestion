import { Router } from 'express';
import multer from 'multer';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { buildTemplateWorkbook, importFromBuffer } from '../bulkImport.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function getSupplyOr404(id) {
  return db.prepare('SELECT * FROM supplies WHERE id = ?').get(id);
}

async function getCategoryOptions() {
  const top = await db.prepare("SELECT * FROM categories WHERE name = 'Suministros Varios' AND parent_id IS NULL").get();
  if (!top) return [];

  const subcategories = await db.prepare('SELECT * FROM categories WHERE parent_id = ? ORDER BY name').all(top.id);

  const options = [{ id: top.id, label: top.name }];
  subcategories.forEach((sub) => options.push({ id: sub.id, label: `— ${sub.name}` }));
  return options;
}

function getUnits() {
  return db.prepare('SELECT * FROM units ORDER BY name').all();
}

router.get('/', requirePermission('suministros', 'consultar'), asyncHandler(async (req, res) => {
  const search = req.query.q?.trim() || '';
  const supplies = await db.prepare(`
    SELECT s.*, c.name AS category_name, u.name AS unit_name
    FROM supplies s
    LEFT JOIN categories c ON c.id = s.category_id
    LEFT JOIN units u ON u.id = s.unit_id
    WHERE s.code ILIKE ? OR s.description ILIKE ?
    ORDER BY s.description
  `).all(`%${search}%`, `%${search}%`);

  const importResult = req.session.importResult || null;
  delete req.session.importResult;

  res.render('supplies/list', { supplies, search, importResult });
}));

router.get('/plantilla', requirePermission('suministros', 'agregar'), asyncHandler(async (req, res) => {
  const workbook = await buildTemplateWorkbook('suministros');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla-suministros.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}));

router.post('/importar', requirePermission('suministros', 'agregar'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.redirect('/inventario/suministros?error=Selecciona un archivo Excel para importar');
  }

  try {
    req.session.importResult = await importFromBuffer('suministros', req.file.buffer);
  } catch (err) {
    req.session.importResult = { created: 0, errors: ['No se pudo leer el archivo. Verifica que sea el formato de la plantilla descargada.'] };
  }

  res.redirect('/inventario/suministros');
}));

router.get('/new', requirePermission('suministros', 'agregar'), asyncHandler(async (req, res) => {
  res.render('supplies/form', {
    supply: null,
    categoryOptions: await getCategoryOptions(),
    units: await getUnits()
  });
}));

router.post('/', requirePermission('suministros', 'agregar'), asyncHandler(async (req, res) => {
  const {
    code, description, category_id, unit_id, min_stock, quantity,
    associated_machine, condition, supplier, supplier_contact
  } = req.body;

  if (!code?.trim() || !description?.trim()) {
    return res.redirect('/inventario/suministros/new?error=Código y descripción son obligatorios');
  }

  try {
    await db.prepare(`
      INSERT INTO supplies (
        code, description, category_id, unit_id, min_stock, quantity,
        associated_machine, condition, supplier, supplier_contact
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code.trim(),
      description.trim(),
      category_id || null,
      unit_id || null,
      Number(min_stock) || 0,
      Number(quantity) || 0,
      associated_machine?.trim() || null,
      condition?.trim() || null,
      supplier?.trim() || null,
      supplier_contact?.trim() || null
    );
  } catch (err) {
    return res.redirect('/inventario/suministros/new?error=Ya existe un suministro con ese código');
  }

  res.redirect('/inventario/suministros');
}));

router.get('/:id/edit', requirePermission('suministros', 'modificar'), asyncHandler(async (req, res) => {
  const supply = await getSupplyOr404(req.params.id);
  if (!supply) return res.redirect('/inventario/suministros');

  res.render('supplies/form', {
    supply,
    categoryOptions: await getCategoryOptions(),
    units: await getUnits()
  });
}));

router.post('/:id', requirePermission('suministros', 'modificar'), asyncHandler(async (req, res) => {
  const {
    code, description, category_id, unit_id, min_stock, quantity,
    associated_machine, condition, supplier, supplier_contact
  } = req.body;

  if (!code?.trim() || !description?.trim()) {
    return res.redirect(`/inventario/suministros/${req.params.id}/edit?error=Código y descripción son obligatorios`);
  }

  try {
    await db.prepare(`
      UPDATE supplies
      SET code = ?, description = ?, category_id = ?, unit_id = ?, min_stock = ?, quantity = ?,
          associated_machine = ?, condition = ?, supplier = ?, supplier_contact = ?
      WHERE id = ?
    `).run(
      code.trim(),
      description.trim(),
      category_id || null,
      unit_id || null,
      Number(min_stock) || 0,
      Number(quantity) || 0,
      associated_machine?.trim() || null,
      condition?.trim() || null,
      supplier?.trim() || null,
      supplier_contact?.trim() || null,
      req.params.id
    );
  } catch (err) {
    return res.redirect(`/inventario/suministros/${req.params.id}/edit?error=Ya existe un suministro con ese código`);
  }

  res.redirect('/inventario/suministros');
}));

router.post('/:id/delete', requirePermission('suministros', 'eliminar'), asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM supplies WHERE id = ?').run(req.params.id);
  res.redirect('/inventario/suministros');
}));

export default router;
