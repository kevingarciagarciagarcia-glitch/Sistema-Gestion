import ExcelJS from 'exceljs';
import db from './db/index.js';

const SI_NO = { si: 1, sí: 1, no: 0 };
const PRINTING_TYPE_LABELS = { serigrafia: 'Serigrafía', flexografia: 'Flexografía' };
const PRINTING_SIDE_LABELS = { anverso: 'Anverso', reverso: 'Reverso', anverso_reverso: 'Anverso y Reverso' };
const FUELLE_TYPE_LABELS = { lateral: 'Lateral', fondo: 'Fondo', superior_fondo: 'Superior y Fondo' };

function reverseLookup(labelsMap, value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  for (const [key, label] of Object.entries(labelsMap)) {
    if (label.toLowerCase() === normalized) return key;
  }
  return null;
}

function parseSiNo(value) {
  if (!value) return false;
  return !!SI_NO[String(value).trim().toLowerCase()];
}

const FIXED_CATEGORY_NAMES = {
  materia_prima: 'Materia Prima',
  produccion: 'Producto en Producción',
  terminado: 'Producto Terminado',
  suministros: 'Suministros Varios'
};

async function findCategoryId(fixedCategoryName, categoryNameInput) {
  const top = await db.prepare('SELECT * FROM categories WHERE name = ? AND parent_id IS NULL').get(fixedCategoryName);
  if (!top) return null;
  if (!categoryNameInput || !categoryNameInput.trim()) return top.id;

  const input = categoryNameInput.trim().toLowerCase();
  if (top.name.toLowerCase() === input) return top.id;

  const subcategories = await db.prepare('SELECT * FROM categories WHERE parent_id = ?').all(top.id);
  const sub = subcategories.find((c) => c.name.toLowerCase() === input);
  return sub ? sub.id : undefined; // undefined = not found (distinct from null = no input given)
}

async function findUnitId(unitNameInput) {
  if (!unitNameInput || !unitNameInput.trim()) return null;
  const units = await db.prepare('SELECT * FROM units').all();
  const unit = units.find((u) => u.name.toLowerCase() === unitNameInput.trim().toLowerCase());
  return unit ? unit.id : undefined;
}

function sheetRows(worksheet) {
  const rows = [];
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value || '').trim();
  });

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    let hasData = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const value = cell.value && typeof cell.value === 'object' && 'result' in cell.value
        ? cell.value.result
        : cell.value;
      obj[key] = value === null || value === undefined ? '' : String(value).trim();
      if (obj[key]) hasData = true;
    });
    if (hasData) rows.push({ rowNumber, data: obj });
  });

  return rows;
}

const PRODUCT_COMMON_COLUMNS = ['SKU', 'Nombre', 'Subcategoría', 'Unidad de Medida', 'Cantidad en Stock', 'Stock Mínimo', 'Descripción'];
const MATERIA_PRIMA_COLUMNS = [...PRODUCT_COMMON_COLUMNS, 'Código', 'Marca', 'Presentación'];
const PRINTING_DIMENSION_COLUMNS = [
  'Color', 'Ancho', 'Largo', 'Espesor',
  'Lleva Fuelle', 'Tipo de Fuelle', 'Medida Fuelle 1', 'Medida Fuelle 2',
  'Lleva Impresión', 'Tipo de Impresión', 'Lado de Impresión', 'Referencia de Impresión', 'Cantidad de Colores'
];
const TERMINADO_COLUMNS = [...PRODUCT_COMMON_COLUMNS, ...PRINTING_DIMENSION_COLUMNS];
const PRODUCCION_COLUMNS = [...PRODUCT_COMMON_COLUMNS, ...PRINTING_DIMENSION_COLUMNS];
const SUMINISTROS_COLUMNS = [
  'Código', 'Descripción del Artículo', 'Subcategoría', 'Unidad de Medida',
  'Stock Mínimo', 'Stock Actual', 'Máquina Asociada', 'Condición', 'Proveedor', 'Contacto de Proveedor'
];

const TEMPLATE_CONFIG = {
  materia_prima: { columns: MATERIA_PRIMA_COLUMNS, title: 'Materia Prima' },
  produccion: { columns: PRODUCCION_COLUMNS, title: 'Producto en Producción' },
  terminado: { columns: TERMINADO_COLUMNS, title: 'Producto Terminado' },
  suministros: { columns: SUMINISTROS_COLUMNS, title: 'Suministros Varios' }
};

const INSTRUCTIONS = [
  ['Columna', 'Valores válidos / notas'],
  ['Subcategoría', 'Debe coincidir exactamente con el nombre de la categoría principal o una subcategoría ya existente en esta pestaña. Déjala en blanco para no asignar ninguna.'],
  ['Unidad de Medida', 'Debe coincidir exactamente con el nombre de una unidad ya existente (ver pestaña "Unidades").'],
  ['Lleva Fuelle / Lleva Impresión', 'Escribe "Sí" o "No".'],
  ['Tipo de Fuelle', 'Lateral / Fondo / Superior y Fondo'],
  ['Medida Fuelle 1 / 2', 'Medida Fuelle 2 solo aplica si el Tipo de Fuelle es "Superior y Fondo".'],
  ['Tipo de Impresión', 'Serigrafía / Flexografía'],
  ['Lado de Impresión', 'Anverso / Reverso / Anverso y Reverso'],
  ['SKU / Código', 'Debe ser único; si ya existe, esa fila se rechazará al importar.'],
  ['Filas vacías', 'Se ignoran automáticamente.']
];

export async function buildTemplateWorkbook(type) {
  const config = TEMPLATE_CONFIG[type];
  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet(config.title.slice(0, 31));
  sheet.addRow(config.columns);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((col) => { col.width = 22; });

  const instructions = workbook.addWorksheet('Instrucciones');
  INSTRUCTIONS.forEach((row) => instructions.addRow(row));
  instructions.getRow(1).font = { bold: true };
  instructions.columns = [{ width: 28 }, { width: 70 }];

  return workbook;
}

async function parseCommonProductFields(data, fixedCategoryKey) {
  const errors = [];

  const sku = data['SKU'];
  const name = data['Nombre'];
  if (!sku) errors.push('SKU es obligatorio');
  if (!name) errors.push('Nombre es obligatorio');

  const categoryId = await findCategoryId(FIXED_CATEGORY_NAMES[fixedCategoryKey], data['Subcategoría']);
  if (categoryId === undefined) errors.push(`Subcategoría "${data['Subcategoría']}" no encontrada`);

  const unitId = await findUnitId(data['Unidad de Medida']);
  if (!data['Unidad de Medida']) errors.push('Unidad de Medida es obligatoria');
  else if (unitId === undefined) errors.push(`Unidad "${data['Unidad de Medida']}" no encontrada`);

  return {
    errors,
    sku, name,
    category_id: categoryId || null,
    unit_id: unitId || null,
    quantity: Number(data['Cantidad en Stock']) || 0,
    min_stock: Number(data['Stock Mínimo']) || 0,
    description: data['Descripción']?.trim() || null
  };
}

function parsePrintingDimensionFields(data) {
  const hasFuelle = parseSiNo(data['Lleva Fuelle']);
  const hasPrinting = parseSiNo(data['Lleva Impresión']);

  const fuelleType = hasFuelle ? reverseLookup(FUELLE_TYPE_LABELS, data['Tipo de Fuelle']) : null;
  const printingType = hasPrinting ? reverseLookup(PRINTING_TYPE_LABELS, data['Tipo de Impresión']) : null;
  const printingSide = hasPrinting ? reverseLookup(PRINTING_SIDE_LABELS, data['Lado de Impresión']) : null;

  return {
    width: data['Ancho'] ? Number(data['Ancho']) : null,
    length: data['Largo'] ? Number(data['Largo']) : null,
    thickness: data['Espesor'] ? Number(data['Espesor']) : null,
    color: data['Color']?.trim() || null,
    has_fuelle: hasFuelle && fuelleType ? 1 : 0,
    fuelle_type: hasFuelle && fuelleType ? fuelleType : null,
    fuelle_measure_1: hasFuelle && fuelleType && data['Medida Fuelle 1'] ? Number(data['Medida Fuelle 1']) : null,
    fuelle_measure_2: hasFuelle && fuelleType === 'superior_fondo' && data['Medida Fuelle 2'] ? Number(data['Medida Fuelle 2']) : null,
    has_printing: hasPrinting && printingType && printingSide ? 1 : 0,
    printing_type: hasPrinting && printingType && printingSide ? printingType : null,
    printing_side: hasPrinting && printingType && printingSide ? printingSide : null,
    printing_reference: hasPrinting ? (data['Referencia de Impresión']?.trim() || null) : null,
    printing_colors: hasPrinting && data['Cantidad de Colores'] ? Number(data['Cantidad de Colores']) : null
  };
}

async function insertProduct(fields, extra) {
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
    fields.sku.trim(), fields.name.trim(), fields.category_id, fields.unit_id,
    fields.quantity, fields.min_stock, fields.description,
    extra.width ?? null, extra.length ?? null, extra.thickness ?? null, extra.color ?? null,
    extra.has_printing ?? 0, extra.printing_type ?? null, extra.printing_side ?? null,
    extra.printing_reference ?? null, extra.printing_colors ?? null,
    extra.has_fuelle ?? 0, extra.fuelle_type ?? null, extra.fuelle_measure_1 ?? null, extra.fuelle_measure_2 ?? null,
    extra.spec_code ?? null, extra.spec_brand ?? null, extra.spec_presentation ?? null
  );
  return info.lastInsertRowid;
}

async function importProducts(buffer, fixedCategoryKey) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const rows = sheetRows(sheet);

  let created = 0;
  const errors = [];

  for (const { rowNumber, data } of rows) {
    const common = await parseCommonProductFields(data, fixedCategoryKey);
    if (common.errors.length > 0) {
      errors.push(`Fila ${rowNumber}: ${common.errors.join('; ')}`);
      continue;
    }

    const extra = fixedCategoryKey === 'materia_prima'
      ? { spec_code: data['Código']?.trim() || null, spec_brand: data['Marca']?.trim() || null, spec_presentation: data['Presentación']?.trim() || null }
      : parsePrintingDimensionFields(data);

    try {
      await insertProduct(common, extra);
      created += 1;
    } catch (err) {
      errors.push(`Fila ${rowNumber}: ya existe un producto con el SKU "${data['SKU']}"`);
    }
  }

  return { created, errors };
}

async function importSupplies(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  const rows = sheetRows(sheet);

  let created = 0;
  const errors = [];

  for (const { rowNumber, data } of rows) {
    const code = data['Código'];
    const description = data['Descripción del Artículo'];
    const rowErrors = [];

    if (!code) rowErrors.push('Código es obligatorio');
    if (!description) rowErrors.push('Descripción del Artículo es obligatoria');

    const categoryId = await findCategoryId(FIXED_CATEGORY_NAMES.suministros, data['Subcategoría']);
    if (categoryId === undefined) rowErrors.push(`Subcategoría "${data['Subcategoría']}" no encontrada`);

    const unitId = await findUnitId(data['Unidad de Medida']);
    if (data['Unidad de Medida'] && unitId === undefined) rowErrors.push(`Unidad "${data['Unidad de Medida']}" no encontrada`);

    if (rowErrors.length > 0) {
      errors.push(`Fila ${rowNumber}: ${rowErrors.join('; ')}`);
      continue;
    }

    try {
      await db.prepare(`
        INSERT INTO supplies (
          code, description, category_id, unit_id, min_stock, quantity,
          associated_machine, condition, supplier, supplier_contact
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        code.trim(), description.trim(), categoryId || null, unitId || null,
        Number(data['Stock Mínimo']) || 0, Number(data['Stock Actual']) || 0,
        data['Máquina Asociada']?.trim() || null, data['Condición']?.trim() || null,
        data['Proveedor']?.trim() || null, data['Contacto de Proveedor']?.trim() || null
      );
      created += 1;
    } catch (err) {
      errors.push(`Fila ${rowNumber}: ya existe un suministro con el código "${code}"`);
    }
  }

  return { created, errors };
}

export async function importFromBuffer(type, buffer) {
  if (type === 'suministros') return importSupplies(buffer);
  return importProducts(buffer, type);
}
