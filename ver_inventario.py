import sqlite3

conexion = sqlite3.connect('pos_lacasa.db')
cursor = conexion.cursor()

# Le pedimos que nos enseñe todo lo que hay en la tabla productos
cursor.execute('SELECT nombre, precio, stock FROM productos')
productos = cursor.fetchall()

print("\n--- INVENTARIO ACTUAL POSLACASA ---")
for p in productos:
    print(f"Producto: {p[0]} | Precio: ${p[1]} | Stock: {p[2]}")
print("------------------------------------\n")

conexion.close()
