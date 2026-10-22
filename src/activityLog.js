import db from './db/index.js';

export async function logActivity(req, description) {
  await db.prepare(`
    INSERT INTO activity_log (user_id, username, description)
    VALUES (?, ?, ?)
  `).run(req.user?.id || null, req.user?.username || null, description);
}
