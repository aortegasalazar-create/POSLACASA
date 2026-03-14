import sqlite3

def inicializar_pos():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS productos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            categoria TEXT,
            precio REAL NOT NULL,
            stock INTEGER DEFAULT 0
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS ventas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            total REAL,
            metodo_pago TEXT,
            costo_envio REAL DEFAULT 0
        )
    ''')

    # NUEVA TABLA: pedidos de Uber Eats, Rappi y DiDi Food
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS pedidos_delivery (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            plataforma TEXT NOT NULL,
            pedido_externo_id TEXT,
            cliente_nombre TEXT,
            items TEXT,
            total REAL,
            costo_envio REAL DEFAULT 0,
            estado TEXT DEFAULT 'nuevo',
            notas TEXT
        )
    ''')

    conexion.commit()
    conexion.close()
    print("Base de datos actualizada con exito.")

if __name__ == "__main__":
    inicializar_pos()
