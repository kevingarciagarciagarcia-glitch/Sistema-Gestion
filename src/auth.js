import db from './db/index.js';

export async function attachUser(req, res, next) {
  req.user = null;
  try {
    if (req.session?.userId) {
      const user = await db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.session.userId);
      if (user) {
        user.profile = user.profile_id ? await db.prepare('SELECT * FROM profiles WHERE id = ?').get(user.profile_id) : null;

        if (user.profile?.is_fixed) {
          user.permissions = null;
        } else if (user.profile_id) {
          const rows = await db.prepare('SELECT window_key, action FROM profile_permissions WHERE profile_id = ?').all(user.profile_id);
          user.permissions = new Set(rows.map((r) => `${r.window_key}:${r.action}`));
        } else {
          user.permissions = new Set();
        }

        req.user = user;
      }
    }
    res.locals.currentUser = req.user;
    res.locals.hasPermission = (windowKey, action) => hasPermission(req.user, windowKey, action);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

export function hasPermission(user, windowKey, action) {
  if (!user) return false;
  if (user.profile?.is_fixed) return true;
  if (!user.permissions) return false;
  return user.permissions.has(`${windowKey}:${action}`);
}

export function requirePermission(windowKey, action) {
  return (req, res, next) => {
    if (!req.user) {
      return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    }
    if (!hasPermission(req.user, windowKey, action)) {
      return res.status(403).render('403', { windowKey, action });
    }
    next();
  };
}
