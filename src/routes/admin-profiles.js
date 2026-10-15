import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { MODULES } from '../permissions.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

async function getProfilePermissions(profileId) {
  const rows = await db.prepare('SELECT window_key, action FROM profile_permissions WHERE profile_id = ?').all(profileId);
  const set = new Set(rows.map((r) => `${r.window_key}:${r.action}`));
  return (windowKey, action) => set.has(`${windowKey}:${action}`);
}

async function saveProfilePermissions(profileId, body) {
  await db.prepare('DELETE FROM profile_permissions WHERE profile_id = ?').run(profileId);

  for (const mod of MODULES) {
    for (const win of mod.windows) {
      for (const action of win.actions) {
        if (body[`perm_${win.key}_${action}`]) {
          await db.prepare('INSERT INTO profile_permissions (profile_id, window_key, action) VALUES (?, ?, ?)')
            .run(profileId, win.key, action);
        }
      }
    }
  }
}

router.get('/', requirePermission('perfiles', 'consultar'), asyncHandler(async (req, res) => {
  const profiles = await db.prepare(`
    SELECT p.*, COUNT(u.id)::int AS user_count
    FROM profiles p
    LEFT JOIN users u ON u.profile_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all();

  res.render('admin/profiles-list', { profiles });
}));

router.get('/new', requirePermission('perfiles', 'agregar'), (req, res) => {
  res.render('admin/profile-form', {
    profile: null,
    isGranted: () => false,
    MODULES
  });
});

router.post('/', requirePermission('perfiles', 'agregar'), asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.redirect('/administracion/perfiles/new?error=El nombre es obligatorio');
  }

  let profileId;
  try {
    const info = await db.prepare('INSERT INTO profiles (name, description) VALUES (?, ?) RETURNING id')
      .run(name.trim(), description?.trim() || null);
    profileId = info.lastInsertRowid;
  } catch (err) {
    return res.redirect('/administracion/perfiles/new?error=Ya existe un perfil con ese nombre');
  }

  await saveProfilePermissions(profileId, req.body);
  res.redirect('/administracion/perfiles');
}));

router.get('/:id/edit', requirePermission('perfiles', 'modificar'), asyncHandler(async (req, res) => {
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return res.redirect('/administracion/perfiles');

  res.render('admin/profile-form', {
    profile,
    isGranted: await getProfilePermissions(profile.id),
    MODULES
  });
}));

router.post('/:id', requirePermission('perfiles', 'modificar'), asyncHandler(async (req, res) => {
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (!profile) return res.redirect('/administracion/perfiles');

  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.redirect(`/administracion/perfiles/${profile.id}/edit?error=El nombre es obligatorio`);
  }

  if (profile.is_fixed) {
    return res.redirect(`/administracion/perfiles/${profile.id}/edit?error=El perfil Administrador no se puede modificar`);
  }

  try {
    await db.prepare('UPDATE profiles SET name = ?, description = ? WHERE id = ?')
      .run(name.trim(), description?.trim() || null, profile.id);
  } catch (err) {
    return res.redirect(`/administracion/perfiles/${profile.id}/edit?error=Ya existe un perfil con ese nombre`);
  }

  await saveProfilePermissions(profile.id, req.body);
  res.redirect('/administracion/perfiles');
}));

router.post('/:id/delete', requirePermission('perfiles', 'eliminar'), asyncHandler(async (req, res) => {
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.params.id);
  if (profile?.is_fixed) {
    return res.redirect('/administracion/perfiles?error=El perfil Administrador no se puede eliminar');
  }

  const { n } = await db.prepare('SELECT COUNT(*)::int AS n FROM users WHERE profile_id = ?').get(req.params.id);
  if (n > 0) {
    return res.redirect('/administracion/perfiles?error=No se puede eliminar: hay usuarios con este perfil');
  }

  await db.prepare('DELETE FROM profiles WHERE id = ?').run(req.params.id);
  res.redirect('/administracion/perfiles');
}));

export default router;
