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

    conexion.commit()
    conexion.close()
    print("✅ Base de datos actualizada con éxito.")

if __name__ == "__main__":
    inicializar_pos()
