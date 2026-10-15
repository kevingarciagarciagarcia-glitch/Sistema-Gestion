import { Router } from 'express';
import db from '../db/index.js';
import { verifyPassword } from '../password.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: req.query.error || null, redirect: req.query.redirect || '/' });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password, redirect } = req.body;
  const safeRedirect = redirect && redirect.startsWith('/') ? redirect : '/';

  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username?.trim());

  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.redirect(`/login?error=${encodeURIComponent('Usuario o contraseña incorrectos')}&redirect=${encodeURIComponent(safeRedirect)}`);
  }

  req.session.userId = user.id;
  res.redirect(safeRedirect);
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

export default router;
