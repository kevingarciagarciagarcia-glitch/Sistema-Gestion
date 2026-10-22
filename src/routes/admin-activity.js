import { Router } from 'express';
import db from '../db/index.js';
import { requirePermission } from '../auth.js';
import { asyncHandler } from '../asyncHandler.js';

const router = Router();

router.get('/', requirePermission('actividad', 'consultar'), asyncHandler(async (req, res) => {
  const search = req.query.q?.trim() || '';
  const from = req.query.from?.trim() || '';
  const to = req.query.to?.trim() || '';

  const conditions = [];
  const params = [];

  if (search) {
    conditions.push('(username ILIKE ? OR description ILIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (from) {
    conditions.push('created_at >= ?');
    params.push(`${from} 00:00:00`);
  }
  if (to) {
    conditions.push('created_at <= ?');
    params.push(`${to} 23:59:59`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const entries = await db.prepare(`
    SELECT * FROM activity_log
    ${where}
    ORDER BY id DESC
    LIMIT 300
  `).all(...params);

  res.render('admin/activity-list', { entries, search, from, to });
}));

export default router;
