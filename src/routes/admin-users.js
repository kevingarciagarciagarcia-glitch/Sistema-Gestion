import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { hashPassword } from '../password.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

function getProfiles() {
  return db.prepare('SELECT * FROM profiles ORDER BY name').all();
}

router.get('/', requirePermission('usuarios', 'consultar'), asyncHandler(async (req, res) => {
  const users = await db.prepare(`
    SELECT u.*, p.name AS profile_name
    FROM users u
    LEFT JOIN profiles p ON p.id = u.profile_id
    ORDER BY u.username
  `).all();

  res.render('admin/users-list', { users });
}));

router.get('/new', requirePermission('usuarios', 'agregar'), asyncHandler(async (req, res) => {
  res.render('admin/user-form', { user: null, profiles: await getProfiles() });
}));

router.post('/', requirePermission('usuarios', 'agregar'), asyncHandler(async (req, res) => {
  const { username, full_name, password, profile_id, is_active } = req.body;

  if (!username?.trim() || !password) {
    return res.redirect('/administracion/usuarios/new?error=Usuario y contraseña son obligatorios');
  }

  try {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, profile_id, is_active)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      username.trim(),
      hashPassword(password),
      full_name?.trim() || null,
      profile_id || null,
      is_active ? 1 : 0
    );
  } catch (err) {
    return res.redirect('/administracion/usuarios/new?error=Ya existe un usuario con ese nombre');
  }

  res.redirect('/administracion/usuarios');
}));

router.get('/:id/edit', requirePermission('usuarios', 'modificar'), asyncHandler(async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/administracion/usuarios');

  res.render('admin/user-form', { user, profiles: await getProfiles() });
}));

router.post('/:id', requirePermission('usuarios', 'modificar'), asyncHandler(async (req, res) => {
  const { username, full_name, password, profile_id, is_active } = req.body;

  if (!username?.trim()) {
    return res.redirect(`/administracion/usuarios/${req.params.id}/edit?error=El usuario es obligatorio`);
  }

  try {
    if (password) {
      await db.prepare(`
        UPDATE users SET username = ?, password_hash = ?, full_name = ?, profile_id = ?, is_active = ?
        WHERE id = ?
      `).run(username.trim(), hashPassword(password), full_name?.trim() || null, profile_id || null, is_active ? 1 : 0, req.params.id);
    } else {
      await db.prepare(`
        UPDATE users SET username = ?, full_name = ?, profile_id = ?, is_active = ?
        WHERE id = ?
      `).run(username.trim(), full_name?.trim() || null, profile_id || null, is_active ? 1 : 0, req.params.id);
    }
  } catch (err) {
    return res.redirect(`/administracion/usuarios/${req.params.id}/edit?error=Ya existe un usuario con ese nombre`);
  }

  res.redirect('/administracion/usuarios');
}));

router.post('/:id/delete', requirePermission('usuarios', 'eliminar'), asyncHandler(async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.redirect('/administracion/usuarios?error=No puedes eliminar tu propio usuario');
  }

  await db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/administracion/usuarios');
}));

export default router;
