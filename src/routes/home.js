import { Router } from 'express';
import { requireAuth, hasPermission } from '../auth.js';
import { MODULES } from '../permissions.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const visibleModules = MODULES.filter((mod) =>
    mod.windows.some((win) => hasPermission(req.user, win.key, 'consultar'))
  );

  res.render('home', { visibleModules });
});

export default router;
