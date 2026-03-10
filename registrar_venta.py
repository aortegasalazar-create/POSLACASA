import sqlite3
from datetime import datetime

def generar_ticket_archivo(id_venta, producto, cant, sub, envio, total):
    nombre_archivo = f"ticket_{id_venta}.txt"
    fecha = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    contenido = f"""
    LA CASA DEL CHILAQUIL
    Ticket No: {id_venta}
    Fecha: {fecha}
    ---------------------------
    Cant: {cant}
    Item: {producto}
    
    Subtotal: ${sub:.2f}
    Envio:    ${envio:.2f}
    ---------------------------
    TOTAL:    ${total:.2f}
    
    ¡Gracias por su compra!
    """
    with open(nombre_archivo, "w") as f:
        f.write(contenido)
    return nombre_archivo

def realizar_venta():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()

    # Mostrar menú
    cursor.execute('SELECT id, nombre, precio, stock FROM productos')
    productos = cursor.fetchall()
    print("\n--- MENU DISPONIBLE ---")
    for p in productos:
        print(f"[{p[0]}] {p[1]} - ${p[2]}")

    try:
        id_prod = int(input("\nID del producto: "))
        cantidad = int(input("¿Cuántas unidades?: "))

        cursor.execute('SELECT nombre, precio, stock FROM productos WHERE id = ?', (id_prod,))
        prod = cursor.fetchone()

        if prod and prod[2] >= cantidad:
            subtotal = prod[1] * cantidad
            
            # Envío
            print("\n¿Es para envío?")
            tipo = input("[1] No / [2] Si: ")
            costo_envio = float(input("Costo envio: ")) if tipo == "2" else 0
            
            total = subtotal + costo_envio

            confirmar = input(f"\nTotal: ${total}. ¿Confirmar? (s/n): ")
            if confirmar.lower() == 's':
                # Guardar en BD
                cursor.execute('INSERT INTO ventas (total, metodo_pago, costo_envio) VALUES (?, ?, ?)', 
                               (total, 'Efectivo', costo_envio))
                id_venta = cursor.lastrowid
                
                # Restar Stock
                cursor.execute('UPDATE productos SET stock = stock - ? WHERE id = ?', (cantidad, id_prod))
                
                # GENERAR TICKET EN TEXTO
                archivo = generar_ticket_archivo(id_venta, prod[0], cantidad, subtotal, costo_envio, total)
                
                conexion.commit()
                print(f"\n✅ Venta guardada. Ticket generado: {archivo}")
            else:
                print("\n❌ Cancelada.")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        conexion.close()

if __name__ == "__main__":
    realizar_venta()
