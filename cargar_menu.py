import sqlite3

def cargar_datos():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()

    # Lista de tus productos reales
    productos = [
        ('Chilaquiles Tradicionales', 'Chilaquiles', 118.00, 100),
        ('Mini Chilaquiles', 'Chilaquiles', 68.00, 100),
        ('Gordita Sencilla', 'Gorditas', 23.00, 200),
        ('Gordita Especial (Queso/Pastor)', 'Gorditas', 28.00, 200),
        ('Refresco', 'Bebidas', 30.00, 50),
        ('Extra Proteina', 'Extras', 20.00, 0),
        ('Extra Huevo', 'Extras', 15.00, 0)
    ]

    cursor.executemany('''
        INSERT INTO productos (nombre, categoria, precio, stock) 
        VALUES (?, ?, ?, ?)
    ''', productos)

    conexion.commit()
    conexion.close()
    print("✨ ¡Menú de La Casa del Chilaquil cargado con éxito!")

if __name__ == "__main__":
    cargar_datos()
