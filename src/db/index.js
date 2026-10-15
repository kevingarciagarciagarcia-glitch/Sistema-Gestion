import pg from 'pg';
import { hashPassword } from '../password.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Falta la variable de entorno DATABASE_URL con la cadena de conexión a PostgreSQL.');
}

const useSsl = process.env.PGSSL === 'false'
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({ connectionString, ssl: useSsl });

// Traduce placeholders estilo SQLite (?) al formato $1, $2... que usa pg.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql, executor = pool) {
  const pgSql = toPgSql(sql);
  return {
    async get(...params) {
      const result = await executor.query(pgSql, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await executor.query(pgSql, params);
      return result.rows;
    },
    async run(...params) {
      const result = await executor.query(pgSql, params);
      return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id };
    }
  };
}

async function exec(sql) {
  await pool.query(sql);
}

// Transacción explícita: todas las consultas hechas con tx.prepare(...) comparten
// la misma conexión, para que BEGIN/COMMIT/ROLLBACK apliquen a todas ellas.
async function beginTransaction() {
  const client = await pool.connect();
  await client.query('BEGIN');
  return {
    prepare: (sql) => prepare(sql, client),
    async commit() {
      await client.query('COMMIT');
      client.release();
    },
    async rollback() {
      await client.query('ROLLBACK');
      client.release();
    }
  };
}

const db = { prepare, exec, beginTransaction };

async function initSchema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
      is_fixed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS units (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_fixed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS profile_permissions (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      window_key TEXT NOT NULL,
      action TEXT NOT NULL,
      UNIQUE (profile_id, window_key, action)
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
      description TEXT,
      width DOUBLE PRECISION,
      length DOUBLE PRECISION,
      thickness DOUBLE PRECISION,
      color TEXT,
      has_printing INTEGER NOT NULL DEFAULT 0,
      printing_type TEXT CHECK (printing_type IN ('serigrafia', 'flexografia')),
      printing_side TEXT CHECK (printing_side IN ('anverso', 'reverso', 'anverso_reverso')),
      printing_reference TEXT,
      printing_colors INTEGER,
      has_fuelle INTEGER NOT NULL DEFAULT 0,
      fuelle_type TEXT CHECK (fuelle_type IN ('lateral', 'fondo', 'superior_fondo')),
      fuelle_measure_1 DOUBLE PRECISION,
      fuelle_measure_2 DOUBLE PRECISION,
      spec_code TEXT,
      spec_brand TEXT,
      spec_presentation TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS supplies (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      min_stock DOUBLE PRECISION NOT NULL DEFAULT 0,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      associated_machine TEXT,
      condition TEXT,
      supplier TEXT,
      supplier_contact TEXT,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS movements (
      id SERIAL PRIMARY KEY,
      item_type TEXT NOT NULL DEFAULT 'product' CHECK (item_type IN ('product', 'supply')),
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      supply_id INTEGER REFERENCES supplies(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('in', 'out', 'traspaso')),
      quantity DOUBLE PRECISION NOT NULL CHECK (quantity > 0),
      input_unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
      input_quantity DOUBLE PRECISION,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      from_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      to_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      reason TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      CHECK (
        (item_type = 'product' AND product_id IS NOT NULL AND supply_id IS NULL) OR
        (item_type = 'supply' AND supply_id IS NOT NULL AND product_id IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS supply_warehouse_stock (
      id SERIAL PRIMARY KEY,
      supply_id INTEGER NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      UNIQUE (supply_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS product_unit_conversions (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      base_quantity DOUBLE PRECISION NOT NULL CHECK (base_quantity > 0),
      target_unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
      target_quantity DOUBLE PRECISION NOT NULL CHECK (target_quantity > 0)
    );

    CREATE TABLE IF NOT EXISTS product_warehouse_stock (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      UNIQUE (product_id, warehouse_id)
    );

    CREATE TABLE IF NOT EXISTS sellers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id SERIAL PRIMARY KEY,
      client TEXT NOT NULL,
      proforma_number TEXT,
      order_date TEXT,
      delivery_date TEXT,
      city TEXT,
      branch TEXT,
      seller_id INTEGER REFERENCES sellers(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      item_number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('rollo', 'funda', 'lamina')),
      product TEXT NOT NULL,
      color TEXT,
      width DOUBLE PRECISION,
      length DOUBLE PRECISION,
      thickness DOUBLE PRECISION,
      quantity DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_kg DOUBLE PRECISION,
      unit_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      line_total DOUBLE PRECISION NOT NULL DEFAULT 0
    );
  `);

  const FIXED_CATEGORIES = ['Materia Prima', 'Producto Terminado', 'Producto en Producción', 'Suministros Varios'];
  const existingCategoryNames = (await prepare('SELECT name FROM categories').all()).map((c) => c.name);
  for (const name of FIXED_CATEGORIES) {
    if (existingCategoryNames.includes(name)) {
      await prepare('UPDATE categories SET is_fixed = 1 WHERE name = ? AND parent_id IS NULL').run(name);
    } else {
      await prepare('INSERT INTO categories (name, is_fixed) VALUES (?, 1)').run(name);
    }
  }

  const { n: unitCount } = await prepare('SELECT COUNT(*) AS n FROM units').get();
  if (Number(unitCount) === 0) {
    for (const name of ['Unidad', 'Caja', 'Kilogramo', 'Gramo', 'Litro', 'Metro']) {
      await prepare('INSERT INTO units (name) VALUES (?)').run(name);
    }
  }

  let adminProfile = await prepare("SELECT * FROM profiles WHERE name = 'Administrador'").get();
  if (!adminProfile) {
    const info = await prepare('INSERT INTO profiles (name, description, is_fixed) VALUES (?, ?, 1) RETURNING id')
      .run('Administrador', 'Acceso total a todos los módulos y ventanas del sistema.');
    adminProfile = { id: info.lastInsertRowid };
  } else if (!adminProfile.is_fixed) {
    await prepare('UPDATE profiles SET is_fixed = 1 WHERE id = ?').run(adminProfile.id);
  }

  const { n: userCount } = await prepare('SELECT COUNT(*) AS n FROM users').get();
  if (Number(userCount) === 0) {
    await prepare(`
      INSERT INTO users (username, password_hash, full_name, profile_id, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run('admin', hashPassword('admin123'), 'Administrador', adminProfile.id);
  }
}

export const ready = initSchema();

export { pool };
export default db;
