import db from './db/index.js';

export async function getColorHexMap() {
  const colors = await db.prepare('SELECT name, hex FROM colors').all();
  return Object.fromEntries(colors.map((c) => [c.name.toLowerCase(), c.hex]));
}
