import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';
import { logActivity } from '../activityLog.js';

const router = Router();

const TYPES = ['natural', 'juridico', 'sin_ruc'];
const ROLES = ['cliente', 'proveedor', 'empleado', 'accionista'];
const ROLE_LABELS = { cliente: 'Cliente', proveedor: 'Proveedor', empleado: 'Empleado', accionista: 'Accionista' };

const PROVINCES = [
  'Azuay', 'Bolívar', 'Cañar', 'Carchi', 'Chimborazo', 'Cotopaxi', 'El Oro', 'Esmeraldas',
  'Galápagos', 'Guayas', 'Imbabura', 'Loja', 'Los Ríos', 'Manabí', 'Morona Santiago', 'Napo',
  'Orellana', 'Pastaza', 'Pichincha', 'Santa Elena', 'Santo Domingo de los Tsáchilas',
  'Sucumbíos', 'Tungurahua', 'Zamora Chinchipe'
];

async function getRolesByPerson(personId) {
  const rows = await db.prepare('SELECT role FROM person_roles WHERE person_id = ?').all(personId);
  return rows.map((r) => r.role);
}

async function saveRoles(personId, body) {
  await db.prepare('DELETE FROM person_roles WHERE person_id = ?').run(personId);
  const selected = Array.isArray(body.roles) ? body.roles : (body.roles ? [body.roles] : []);
  for (const role of selected) {
    if (ROLES.includes(role)) {
      await db.prepare('INSERT INTO person_roles (person_id, role) VALUES (?, ?)').run(personId, role);
    }
  }
}

function parsePersonFields(body) {
  const { type, ruc, cedula, name, commercial_name, phone, email, province, address } = body;

  if (!TYPES.includes(type)) {
    return { error: 'Selecciona un tipo de persona válido' };
  }
  if (!name?.trim()) {
    return { error: 'El nombre es obligatorio' };
  }
  if (type === 'natural' && !cedula?.trim()) {
    return { error: 'La cédula es obligatoria para una persona natural' };
  }
  if (type === 'juridico' && !ruc?.trim()) {
    return { error: 'El RUC es obligatorio para una persona jurídica' };
  }

  return {
    fields: {
      type,
      ruc: type === 'sin_ruc' ? null : (ruc?.trim() || null),
      cedula: type === 'juridico' ? null : (cedula?.trim() || null),
      name: name.trim(),
      commercial_name: commercial_name?.trim() || null,
      phone: phone?.trim() || null,
      email: email?.trim() || null,
      province: province?.trim() || null,
      address: address?.trim() || null
    }
  };
}

router.get('/', requirePermission('personas', 'consultar'), asyncHandler(async (req, res) => {
  const search = req.query.q?.trim() || '';
  const people = await db.prepare(`
    SELECT * FROM people
    WHERE name ILIKE ? OR commercial_name ILIKE ? OR ruc ILIKE ? OR cedula ILIKE ?
    ORDER BY name
  `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);

  const roleRows = await db.prepare('SELECT person_id, role FROM person_roles').all();
  const rolesByPerson = {};
  roleRows.forEach((r) => {
    if (!rolesByPerson[r.person_id]) rolesByPerson[r.person_id] = [];
    rolesByPerson[r.person_id].push(ROLE_LABELS[r.role]);
  });

  res.render('people/list', { people, search, rolesByPerson });
}));

router.get('/new', requirePermission('personas', 'agregar'), (req, res) => {
  const modal = req.query.modal === '1';
  res.render('people/form', { person: null, roles: modal ? ['cliente'] : [], ROLE_LABELS, ROLES, PROVINCES, modal });
});

router.post('/', requirePermission('personas', 'agregar'), asyncHandler(async (req, res) => {
  const modal = req.body.modal === '1';
  const modalParam = modal ? '&modal=1' : '';

  const { fields, error } = parsePersonFields(req.body);
  if (error) {
    return res.redirect(`/personas/new?error=${encodeURIComponent(error)}${modalParam}`);
  }

  const info = await db.prepare(`
    INSERT INTO people (type, ruc, cedula, name, commercial_name, phone, email, province, address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(
    fields.type, fields.ruc, fields.cedula, fields.name, fields.commercial_name,
    fields.phone, fields.email, fields.province, fields.address
  );

  await saveRoles(info.lastInsertRowid, req.body);
  await logActivity(req, `Creó la persona "${fields.name}"`);

  if (modal) {
    return res.render('people/created', { id: info.lastInsertRowid, name: fields.name });
  }
  res.redirect('/personas');
}));

router.get('/:id/edit', requirePermission('personas', 'modificar'), asyncHandler(async (req, res) => {
  const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  if (!person) return res.redirect('/personas');

  res.render('people/form', {
    person,
    roles: await getRolesByPerson(person.id),
    ROLE_LABELS,
    ROLES,
    PROVINCES
  });
}));

router.post('/:id', requirePermission('personas', 'modificar'), asyncHandler(async (req, res) => {
  const { fields, error } = parsePersonFields(req.body);
  if (error) {
    return res.redirect(`/personas/${req.params.id}/edit?error=${encodeURIComponent(error)}`);
  }

  await db.prepare(`
    UPDATE people
    SET type = ?, ruc = ?, cedula = ?, name = ?, commercial_name = ?, phone = ?, email = ?, province = ?, address = ?
    WHERE id = ?
  `).run(
    fields.type, fields.ruc, fields.cedula, fields.name, fields.commercial_name,
    fields.phone, fields.email, fields.province, fields.address, req.params.id
  );

  await saveRoles(req.params.id, req.body);
  await logActivity(req, `Editó la persona "${fields.name}"`);
  res.redirect('/personas');
}));

router.post('/:id/delete', requirePermission('personas', 'eliminar'), asyncHandler(async (req, res) => {
  const person = await db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
  await db.prepare('DELETE FROM people WHERE id = ?').run(req.params.id);
  await logActivity(req, `Eliminó la persona "${person?.name || req.params.id}"`);
  res.redirect('/personas');
}));

export default router;
