import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import createPgSessionStore from 'connect-pg-simple';

import { ready, pool } from './db/index.js';
import { attachUser, requireAuth } from './auth.js';
import authRouter from './routes/auth.js';
import homeRouter from './routes/home.js';
import dashboardRouter from './routes/dashboard.js';
import productsRouter from './routes/products.js';
import categoriesRouter from './routes/categories.js';
import unitsRouter from './routes/units.js';
import warehousesRouter from './routes/warehouses.js';
import suppliesRouter from './routes/supplies.js';
import movementsRouter from './routes/movements.js';
import adminProfilesRouter from './routes/admin-profiles.js';
import adminUsersRouter from './routes/admin-users.js';
import ordersRouter from './routes/orders.js';
import sellersRouter from './routes/sellers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const PgSessionStore = createPgSessionStore(session);

app.use(session({
  store: new PgSessionStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-cambiar-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

app.use((req, res, next) => {
  res.locals.query = req.query;
  next();
});

app.use(attachUser);

app.use('/', authRouter);
app.use('/', homeRouter);
app.use('/inventario', requireAuth, dashboardRouter);
app.use('/inventario/productos', requireAuth, productsRouter);
app.use('/inventario/categorias', requireAuth, categoriesRouter);
app.use('/inventario/unidades', requireAuth, unitsRouter);
app.use('/inventario/bodegas', requireAuth, warehousesRouter);
app.use('/inventario/suministros', requireAuth, suppliesRouter);
app.use('/inventario/movimientos', requireAuth, movementsRouter);
app.use('/administracion/perfiles', requireAuth, adminProfilesRouter);
app.use('/administracion/usuarios', requireAuth, adminUsersRouter);
app.use('/pedidos/vendedores', requireAuth, sellersRouter);
app.use('/pedidos', requireAuth, ordersRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Ocurrió un error inesperado. Intenta nuevamente.');
});

const PORT = process.env.PORT || 3000;

ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sistema escuchando en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
