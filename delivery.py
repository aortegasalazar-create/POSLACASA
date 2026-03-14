import sqlite3
import streamlit as st
from datetime import datetime

DB = 'pos_lacasa.db'

def guardar_pedido_delivery(plataforma, pedido_id, cliente, items_texto, total, costo_envio=0, notas=''):
    conexion = sqlite3.connect(DB)
    cursor = conexion.cursor()
    try:
        cursor.execute(
            '''INSERT INTO pedidos_delivery
               (plataforma, pedido_externo_id, cliente_nombre, items, total, costo_envio, estado, notas)
               VALUES (?, ?, ?, ?, ?, ?, 'nuevo', ?)''',
            (plataforma, pedido_id, cliente, items_texto, total, costo_envio, notas)
        )
        cursor.execute(
            'INSERT INTO ventas (total, metodo_pago, costo_envio) VALUES (?, ?, ?)',
            (total, 'Delivery-' + plataforma, costo_envio)
        )
        conexion.commit()
        return True, 'Pedido guardado correctamente'
    except Exception as e:
        return False, 'Error: ' + str(e)
    finally:
        conexion.close()

def descontar_stock(nombre_producto, cantidad):
    conexion = sqlite3.connect(DB)
    cursor = conexion.cursor()
    try:
        cursor.execute(
            'UPDATE productos SET stock = stock - ? WHERE nombre = ? AND stock >= ?',
            (cantidad, nombre_producto, cantidad)
        )
        conexion.commit()
        return cursor.rowcount > 0
    finally:
        conexion.close()

def mostrar_pedidos_delivery():
    st.markdown('## Pedidos de Delivery')
    plataforma_filtro = st.selectbox('Filtrar por plataforma', ['Todas', 'Uber Eats', 'Rappi', 'DiDi Food'])
    conexion = sqlite3.connect(DB)
    cursor = conexion.cursor()
    if plataforma_filtro == 'Todas':
        cursor.execute('SELECT * FROM pedidos_delivery ORDER BY fecha DESC LIMIT 100')
    else:
        cursor.execute('SELECT * FROM pedidos_delivery WHERE plataforma = ? ORDER BY fecha DESC LIMIT 100', (plataforma_filtro,))
    pedidos = cursor.fetchall()
    conexion.close()
    if not pedidos:
        st.info('No hay pedidos de delivery todavia.')
        return
    for p in pedidos:
        id_p, fecha, plataforma, ext_id, cliente, items, total, envio, estado, notas = p
        with st.container():
            col1, col2, col3, col4 = st.columns([3, 2, 2, 2])
            with col1:
                st.markdown('**[' + plataforma + ']** Pedido #' + str(ext_id or id_p))
                st.caption('Cliente: ' + str(cliente or 'Sin nombre') + '  |  Hora: ' + str(fecha)[:16])
            with col2:
                st.markdown('**Productos:**')
                st.caption(items or '—')
            with col3:
                st.markdown('**Total: $' + str(round(total, 2)) + '**')
                if envio:
                    st.caption('Envio: $' + str(round(envio, 2)))
            with col4:
                st.markdown('**Estado: ' + estado.upper() + '**')
                if estado == 'nuevo':
                    if st.button('Marcar en camino', key='camino_' + str(id_p)):
                        _cambiar_estado(id_p, 'en camino')
                        st.rerun()
                elif estado == 'en camino':
                    if st.button('Marcar entregado', key='entregado_' + str(id_p)):
                        _cambiar_estado(id_p, 'entregado')
                        st.rerun()
                else:
                    st.success('Entregado')
            if notas:
                st.caption('Notas: ' + str(notas))
            st.divider()
    st.markdown('---')
    st.markdown('### Resumen de hoy')
    conexion = sqlite3.connect(DB)
    cursor = conexion.cursor()
    hoy = datetime.now().strftime('%Y-%m-%d')
    cursor.execute('SELECT plataforma, COUNT(*), SUM(total) FROM pedidos_delivery WHERE fecha LIKE ? GROUP BY plataforma', (hoy + '%',))
    resumen = cursor.fetchall()
    conexion.close()
    if resumen:
        cols = st.columns(len(resumen))
        for i, (plat, cantidad, suma) in enumerate(resumen):
            with cols[i]:
                st.metric(plat, '$' + str(round(suma, 2)), str(cantidad) + ' pedidos hoy')
    else:
        st.info('Sin ventas de delivery hoy.')

def ingresar_pedido_manual():
    st.markdown('## Registrar pedido de delivery manualmente')
    st.info('Usa este formulario para capturar pedidos de Uber, Rappi o DiDi mientras configuras la conexion automatica.')
    plataforma = st.selectbox('Plataforma de origen', ['Uber Eats', 'Rappi', 'DiDi Food'])
    pedido_id  = st.text_input('Numero de pedido (el que aparece en la app)')
    cliente    = st.text_input('Nombre del cliente')
    items      = st.text_area('Productos del pedido (ej: 2x Chilaquil Rojo, 1x Agua)')
    total      = st.number_input('Total del pedido ($)', min_value=0.0, step=0.50)
    envio      = st.number_input('Costo de envio ($)', min_value=0.0, step=0.50)
    notas      = st.text_input('Notas especiales (sin cebolla, salsa extra, etc.)')
    if st.button('Guardar pedido', type='primary'):
        if not items or total == 0:
            st.warning('Agrega los productos y el total antes de guardar.')
        else:
            ok, msg = guardar_pedido_delivery(plataforma, pedido_id, cliente, items, total, envio, notas)
            if ok:
                st.success(msg)
                st.balloons()
            else:
                st.error(msg)

def _cambiar_estado(id_pedido, nuevo_estado):
    conexion = sqlite3.connect(DB)
    cursor = conexion.cursor()
    cursor.execute('UPDATE pedidos_delivery SET estado = ? WHERE id = ?', (nuevo_estado, id_pedido))
    conexion.commit()
    conexion.close()
