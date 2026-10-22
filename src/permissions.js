export const ACTION_LABELS = {
  consultar: 'Consultar',
  agregar: 'Agregar',
  modificar: 'Modificar',
  eliminar: 'Eliminar'
};

export const MODULES = [
  {
    key: 'inventario',
    label: 'Inventario',
    icon: '📦',
    description: 'Productos, categorías, unidades, bodegas y movimientos de stock.',
    homeUrl: '/inventario',
    windows: [
      { key: 'dashboard', label: 'Dashboard', url: '/inventario', actions: ['consultar'] },
      { key: 'materia_prima', label: 'Materia Prima', url: '/inventario/productos/materia-prima', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'produccion', label: 'Producción', url: '/inventario/productos/produccion', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'terminado', label: 'Producto Terminado', url: '/inventario/productos/terminado', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'categorias', label: 'Categorías', url: '/inventario/categorias', actions: ['consultar', 'agregar', 'eliminar'] },
      { key: 'unidades', label: 'Unidades', url: '/inventario/unidades', actions: ['consultar', 'agregar', 'eliminar'] },
      { key: 'bodegas', label: 'Bodegas', url: '/inventario/bodegas', actions: ['consultar', 'agregar', 'eliminar'] },
      { key: 'movimientos', label: 'Movimientos', url: '/inventario/movimientos', actions: ['consultar', 'agregar'] },
      { key: 'suministros', label: 'Suministros Varios', url: '/inventario/suministros', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] }
    ]
  },
  {
    key: 'pedidos',
    label: 'Pedidos',
    icon: '🧾',
    description: 'Órdenes de pedido de clientes y catálogo de vendedores.',
    homeUrl: '/pedidos',
    windows: [
      { key: 'ordenes', label: 'Órdenes de Pedido', url: '/pedidos', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'vendedores', label: 'Vendedores', url: '/pedidos/vendedores', actions: ['consultar', 'agregar', 'eliminar'] }
    ]
  },
  {
    key: 'personas',
    label: 'Personas',
    icon: '👤',
    description: 'Registro de clientes, proveedores, empleados y accionistas.',
    homeUrl: '/personas',
    windows: [
      { key: 'personas', label: 'Personas', url: '/personas', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] }
    ]
  },
  {
    key: 'administracion',
    label: 'Administración',
    icon: '🛡️',
    description: 'Perfiles de usuario y permisos de acceso a los módulos.',
    homeUrl: '/administracion/perfiles',
    windows: [
      { key: 'perfiles', label: 'Perfiles', url: '/administracion/perfiles', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'usuarios', label: 'Usuarios', url: '/administracion/usuarios', actions: ['consultar', 'agregar', 'modificar', 'eliminar'] },
      { key: 'actividad', label: 'Log de Actividades', url: '/administracion/actividad', actions: ['consultar'] }
    ]
  }
];

export function findWindow(windowKey) {
  for (const mod of MODULES) {
    const win = mod.windows.find((w) => w.key === windowKey);
    if (win) return { module: mod, window: win };
  }
  return null;
}

export function allWindowKeys() {
  return MODULES.flatMap((m) => m.windows.map((w) => w.key));
}
