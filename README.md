# Sistema de Gestión

Proyecto personal para practicar programación: una aplicación web modular construida con Node.js, organizada por módulos de negocio independientes.

## Estado

✅ Funcional — módulos implementados: **Inventario** y **Pedidos**.

## Descripción

La aplicación requiere **inicio de sesión** (`/login`). Una vez dentro, la pantalla de inicio (`/`) lista los módulos a los que el usuario tiene acceso según su **perfil**. Cada módulo vive bajo su propio prefijo de URL y tiene su propia navegación interna.

### Autenticación y permisos

- Pantalla de bienvenida/login (`/login`) con usuario y contraseña.
- Cada usuario tiene un **perfil** asignado (rol), y cada perfil define a qué **ventanas** de cada **módulo** tiene acceso y con qué **acciones** (Consultar, Agregar, Modificar, Eliminar — según lo que esa ventana realmente soporte).
- El perfil **Administrador** es fijo: siempre tiene acceso total a todo el sistema y no se puede editar ni eliminar. Usuario por defecto creado la primera vez que arranca el servidor: **`admin` / `admin123`** (se recomienda cambiar la contraseña desde "Administración → Usuarios").
- Módulo **Administración** (`/administracion`, visible solo para quien tenga permiso):
  - **Perfiles**: crear/editar perfiles y, para cada uno, asignar permisos mediante una matriz por módulo (checkboxes de Consultar/Agregar/Modificar/Eliminar por cada ventana, con un "Seleccionar Todo" por módulo y secciones colapsables).
  - **Usuarios**: crear/editar usuarios, asignarles un perfil, activarlos/desactivarlos y cambiar su contraseña.
- Las pestañas de navegación y las tarjetas de módulos en el inicio se filtran automáticamente según los permisos del usuario conectado (lo que no se tiene acceso, ni se muestra). Un intento de entrar directamente por URL a algo sin permiso muestra una pantalla de "Acceso denegado".

### Módulo: Inventario (`/inventario`)

- Gestionar **productos** (SKU, nombre, categoría, unidad de medida, cantidad, stock mínimo, descripción, dimensiones, especificaciones y datos de impresión) con hasta **4 conversiones de unidad propias por producto** (ej: 1 Millar equivale a 1000 Unidad).
- Sección **Especificaciones** en el formulario de producto: Código, Marca, Presentación.
- **3 vistas de inventario separadas**, una por cada categoría principal fija, cada una con sus propias columnas:
  - **Materia Prima**: SKU, Nombre, Código, Marca, Subcategoría, Unidad, Presentación, Stock, Mínimo.
  - **Producto Terminado**: SKU, Nombre, Color, Ancho, Largo, Espesor, Fuelle, Referencia (de impresión), Subcategoría, Unidad, Stock, Mínimo.
  - **Producto en Producción**: igual que Producto Terminado, más una columna de Descripción (después de Referencia).
- **Suministros Varios** (`/inventario/suministros`): un inventario **totalmente aislado** del de productos (tabla y formulario propios), pensado para repuestos de maquinaria o suministros de oficina. Columnas: Código, Descripción del Artículo, Categoría, Unidad de medida, Stock mínimo, Stock actual, Máquina asociada, Condición, Proveedor, Contacto de proveedor. Su categoría se restringe únicamente a la categoría fija "Suministros Varios" y sus propias subcategorías (ej: "Repuestos de Maquinaria", "Suministros de Oficina") — no comparte categorías, especificaciones ni dimensiones con los productos de Materia Prima/Producción/Terminado. Sí se integra con el módulo de **Movimientos**: admite Entrada y Salida (bodega incluida) igual que los productos, con su propio stock por bodega; el traspaso entre bodegas queda reservado a productos por ahora.
- Gestionar **categorías** y **subcategorías** de productos. Hay 4 categorías principales **fijas** (Materia Prima, Producto Terminado, Producto en Producción, Suministros Varios) que se crean automáticamente y no se pueden eliminar; las subcategorías dentro de ellas sí son libres de crear y eliminar.
- Gestionar la **lista de unidades de medida** disponibles.
- Gestionar **bodegas** (nombre y descripción).
- Registrar **movimientos de stock** para **productos y suministros por igual**: **Entrada**, **Salida** o **Traspaso entre bodegas** (traspaso solo disponible para productos; los suministros solo manejan Entrada/Salida). El buscador del formulario de movimiento combina productos y suministros en una sola lista (con una etiqueta `[Producto]`/`[Suministro]`), y la unidad se autocompleta según el elemento elegido — con sus conversiones si es producto, o su única unidad fija si es un suministro. Entrada/Salida piden una bodega; Traspaso pide bodega origen y destino (deben ser distintas) y mueve el stock entre ellas sin afectar la cantidad total.
- **Formato imprimible por movimiento**: al registrar un movimiento (o desde "Ver / Imprimir" en la lista), se abre un comprobante con los datos del movimiento (incluye Producto y Categoría) y tres firmas — **Elaborado por** (autocompletado con el usuario que lo registró), **Aprobado por** y **Recibido por** (en blanco, para firma física). Un botón "🖨 Imprimir" oculta el encabezado/navegación al imprimir, dejando solo el comprobante. Según la categoría del producto, el comprobante agrega secciones adicionales: **Dimensiones** (Color, Ancho, Largo, Espesor, Fuelle) e **Impresión** (Tipo, Lado, Referencia, Cantidad de colores) para Producto Terminado/Producción, o **Especificaciones** (Código, Marca, Presentación) para Materia Prima.
- Ver un **dashboard** con totales del inventario, alertas de bajo stock y los últimos movimientos.
- **Carga masiva por Excel**: en Materia Prima, Producción, Producto Terminado y Suministros Varios hay dos botones — **"Plantilla Excel"** descarga un `.xlsx` con las columnas exactas de esa pestaña (más una hoja "Instrucciones" con los valores válidos para cada campo), e **"Importar"** sube esa plantilla ya llena para crear los elementos en bloque. El resultado se muestra como un resumen (creados vs. filas con error y el motivo de cada una); las filas con error no detienen el resto de la carga. Subcategoría y Unidad de Medida deben coincidir exactamente con un nombre ya existente en el sistema.

### Módulo: Pedidos (`/pedidos`)

- **Órdenes de Pedido**: encabezado con Cliente, N° Proforma, Fecha de Pedido, Fecha de Entrega, Ciudad, Sucursal y Vendedor (seleccionado de un catálogo). El número de orden (N° OP) es autogenerado.
- Cada orden tiene una tabla de **líneas de producto** con filas dinámicas (botón "+ Agregar línea" y "✕" para quitar una): N°, Tipo (Rollo / Funda / Lámina), Producto, Color, A, L, E, Cantidad, Total Kg, Precio Unitario y Precio Total. El Precio Total de cada línea y el **Subtotal** de la orden se calculan automáticamente (Cantidad × Precio Unitario) y se muestran en vivo mientras se llena el formulario.
- Vista de **detalle** de cada orden (de solo lectura, con botón para imprimir) además del formulario de edición.
- **Vendedores**: catálogo simple (nombre) usado por el desplegable de Vendedor en las órdenes; no se puede eliminar un vendedor con órdenes registradas.

Futuros módulos (ventas, compras, etc.) se agregarán como tarjetas nuevas en la pantalla de inicio, cada uno bajo su propio prefijo de URL.

### Tecnologías

- **Node.js** + **Express** como servidor web.
- **EJS** para las vistas renderizadas en el servidor.
- **PostgreSQL** (vía el paquete `pg`) como base de datos — pensado para desplegarse contra un proveedor administrado (Neon, Supabase, Railway, Render, etc.).
- **`express-session`** para las sesiones de usuario; contraseñas con hash `scrypt` del módulo nativo `node:crypto` (sin dependencias extra de criptografía).
- **`exceljs`** para generar y leer los archivos `.xlsx` de la carga masiva; **`multer`** para recibir el archivo subido.

## Cómo empezar

1. Crea una base de datos PostgreSQL (por ejemplo, un proyecto gratuito en [Neon](https://neon.tech) o [Supabase](https://supabase.com)) y copia su cadena de conexión.
2. Copia `.env.example` a `.env` y completa `DATABASE_URL` con esa cadena de conexión (y opcionalmente `SESSION_SECRET` y `PORT`).
3. Instala dependencias y arranca:

```bash
npm install
npm start
```

Luego abre [http://localhost:3000](http://localhost:3000) en el navegador.

Para desarrollo con recarga automática al guardar cambios:

```bash
npm run dev
```

Las tablas y los datos iniciales (categorías fijas, unidades básicas, perfil Administrador y usuario `admin`/`admin123`) se crean automáticamente contra la base indicada en `DATABASE_URL` la primera vez que arranca el servidor. Como se usa la misma base Postgres tanto en desarrollo como en producción, no se necesita Docker ni una instalación local de PostgreSQL.

## Estructura del proyecto

```
src/
  server.js          # Carga el archivo .env (si existe) y luego arranca app.js
  app.js              # Construye la app Express: sesión, middlewares de auth y montaje de módulos
  auth.js             # attachUser, requireAuth, hasPermission, requirePermission
  asyncHandler.js       # Envuelve handlers async para que Express 4 reenvíe sus errores
  password.js          # Hash y verificación de contraseñas (scrypt)
  permissions.js         # Catálogo de módulos/ventanas/acciones del sistema
  db/
    index.js         # Pool de PostgreSQL, esquema de tablas y siembra (incluye perfil Administrador + usuario admin)
  routes/
    auth.js            # Login / logout ("/login", "/logout")
    home.js              # Pantalla de inicio / selector de módulos ("/"), filtrada por permisos
    admin-profiles.js      # Administración → Perfiles y su matriz de permisos ("/administracion/perfiles")
    admin-users.js           # Administración → Usuarios ("/administracion/usuarios")
    dashboard.js                # Módulo Inventario → Dashboard ("/inventario")
    products.js                   # Módulo Inventario → Productos y las 3 vistas por categoría ("/inventario/productos", ".../materia-prima", ".../produccion", ".../terminado")
    categories.js                   # Módulo Inventario → Categorías y subcategorías ("/inventario/categorias")
    units.js                          # Módulo Inventario → Unidades de medida ("/inventario/unidades")
    warehouses.js                       # Módulo Inventario → Bodegas ("/inventario/bodegas")
    supplies.js                           # Módulo Inventario → Suministros Varios, inventario aislado ("/inventario/suministros")
    movements.js                            # Módulo Inventario → Movimientos de stock, incl. traspasos ("/inventario/movimientos")
    orders.js                                 # Módulo Pedidos → Órdenes de pedido ("/pedidos")
    sellers.js                                  # Módulo Pedidos → Vendedores ("/pedidos/vendedores")
  views/              # Plantillas EJS (login, home, 403, admin/, inventario y pedidos)
public/
  css/style.css       # Estilos
.env                  # DATABASE_URL, SESSION_SECRET, PORT (ignorado por git; ver .env.example)
```

## Notas

- Al registrar un movimiento de "salida" se valida que haya stock suficiente antes de descontarlo.
- Los productos con `cantidad <= stock mínimo` aparecen resaltados y listados en el dashboard.
- Las unidades de medida básicas (Unidad, Caja, Kilogramo, Gramo, Litro, Metro) se crean automáticamente la primera vez; se pueden editar o ampliar desde la sección "Unidades".
- Cada producto define sus propias equivalencias en su formulario (sección "Conversiones", hasta 4 filas): cuántas unidades de otro tipo equivalen a una cantidad de su unidad base (ej: 1 Millar equivalen a 1000 Unidad). No existe una tabla de conversión global; cada producto es independiente.
- Al registrar un movimiento se puede elegir **la unidad base del producto o cualquiera de sus conversiones definidas**; el sistema convierte la cantidad automáticamente a la unidad base antes de actualizar el stock. Si se elige una unidad sin conversión definida para ese producto, se rechaza el movimiento.
- En el formulario de movimiento, el producto se elige con un **buscador** (SKU o nombre, con sugerencias en vivo) en vez de un desplegable con todos los productos. La búsqueda también incluye campos adicionales según la categoría del producto: **dimensiones** (color, ancho, largo, espesor) para Producto Terminado y Producto en Producción, y **especificaciones** (código, marca, presentación) para Materia Prima.
- Cada producto puede registrar **ancho, largo, espesor y color**, y opcionalmente datos de **impresión**: al marcar "Lleva impresión" se habilitan y se vuelven obligatorios el tipo (Serigrafía/Flexografía) y el lado (Anverso, Reverso o Anverso y reverso), además de una referencia de texto libre (ej: "Supermaxi") y la cantidad de colores.
- También puede llevar **fuelle**: al marcar "Lleva fuelle" se habilita y se vuelve obligatorio el tipo (Fuelle Lateral, Fuelle Fondo, o Fuelle Superior y Fondo), que a su vez controla cuántos campos de medida aparecen (uno para Lateral o Fondo, dos para Superior y Fondo).
- La lista de productos muestra Color, Ancho, Largo, Espesor y Fuelle con encabezados abreviados (C, A, L, E, F) a modo de referencia rápida.
- No se puede eliminar una **categoría** (ni sus subcategorías) ni una **unidad de medida** mientras algún producto las tenga asignadas (como categoría o como unidad base), ni una unidad usada en alguna conversión de un producto; en esos casos el botón "Eliminar" se reemplaza por la etiqueta "En uso". Lo mismo aplica a una **bodega** con movimientos registrados.
- El botón "+ Nuevo producto" en cada una de las 3 vistas de inventario preselecciona automáticamente la categoría principal correspondiente en el formulario.
- El stock se registra por producto (cantidad total) y, a partir de los movimientos, también por bodega: una Entrada suma al total y a la bodega elegida; una Salida resta del total (se valida contra el total); un Traspaso solo mueve cantidad entre la bodega origen y destino (se valida contra el stock que esa bodega tiene registrado) sin alterar el total del producto.
- Las ventanas de este sistema solo exponen las acciones que realmente implementan: Categorías, Unidades y Bodegas no tienen "Modificar" (no hay edición, solo alta y baja); Movimientos solo tiene "Consultar" y "Agregar" (no hay edición ni borrado de movimientos); Dashboard solo tiene "Consultar". El resto de ventanas de Inventario y ambas de Administración tienen las 4 acciones completas.
- Próximas ideas: exportar reportes a CSV, un reporte de stock por bodega.
