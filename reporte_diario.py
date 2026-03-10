import sqlite3

def generar_reporte():
    conexion = sqlite3.connect('pos_lacasa.db')
    cursor = conexion.cursor()

    # 1. Traemos la suma de todo, la suma de envios y el conteo de tickets
    cursor.execute('SELECT SUM(total), SUM(costo_envio), COUNT(id) FROM ventas')
    resultado = cursor.fetchone()
    
    # Si no hay ventas, ponemos ceros para que no de error
    total_general = resultado[0] or 0
    total_envios = resultado[1] or 0
    total_tickets = resultado[2] or 0
    
    # Calculamos cuánto es solo de comida
    ventas_comida = total_general - total_envios

    print("\n" + "╔" + "═"*35 + "╗")
    print("║        REPORTE DE CAJA            ║")
    print("╠" + "═"*35 + "╣")
    print(f"║ 🌮 Ventas Comida:   ${ventas_comida:>10.2f} ║")
    print(f"║ 🛵 Total Envíos:    ${total_envios:>10.2f} ║")
    print(f"║ 💰 TOTAL EN CAJA:   ${total_general:>10.2f} ║")
    print("╠" + "═"*35 + "╣")
    print(f"║ 🧾 Tickets Totales: {total_tickets:>10} ║")
    print("╚" + "═"*35 + "╝\n")

    conexion.close()

if __name__ == "__main__":
    generar_reporte()
