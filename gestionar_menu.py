import sqlite3

def mostrar_productos():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()
    cursor.execute('SELECT * FROM productos')
    productos = cursor.fetchall()
    print("\n--- PRODUCTOS EN SISTEMA ---")
    for p in productos:
        print(f"ID: {p[0]} | {p[1]} | Precio: ${p[3]} | Stock: {p[4]}")
    conexion.close()

def actualizar_precio():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()
    id_prod = int(input("ID del producto a modificar: "))
    nuevo_precio = float(input("Nuevo precio: "))
    cursor.execute('UPDATE productos SET precio = ? WHERE id = ?', (nuevo_precio, id_prod))
    conexion.commit()
    print("✅ Precio actualizado.")
    conexion.close()

def agregar_producto():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()
    nombre = input("Nombre del nuevo producto: ")
    cat = input("Categoría (Chilaquiles/Gorditas/Bebidas): ")
    precio = float(input("Precio de venta: "))
    stock = int(input("Stock inicial: "))
    cursor.execute('INSERT INTO productos (nombre, categoria, precio, stock) VALUES (?,?,?,?)', 
                   (nombre, cat, precio, stock))
    conexion.commit()
    print(f"✅ {nombre} agregado al menú.")
    conexion.close()

if __name__ == "__main__":
    while True:
        print("\n--- GESTIÓN DE MENÚ POSLACASA ---")
        print("[1] Ver Menú")
        print("[2] Cambiar Precio")
        print("[3] Agregar Nuevo Producto")
        print("[4] Salir")
        opc = input("Selecciona una opción: ")
        
        if opc == "1": mostrar_productos()
        elif opc == "2": actualizar_precio()
        elif opc == "3": agregar_producto()
        elif opc == "4": break
