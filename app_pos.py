import streamlit as st
import sqlite3
import pandas as pd
from datetime import datetime
from delivery import mostrar_pedidos_delivery, ingresar_pedido_manual

# Configuracion de la pagina
st.set_page_config(page_title="POS La Casa del Chilaquil", layout="wide")

def obtener_conexion():
    return sqlite3.connect("pos_lacasa.db")

st.title("POS La Casa del Chilaquil")
st.sidebar.header("Navegacion")
menu = st.sidebar.radio("Ir a:", [
    "Ventas",
    "Inventario",
    "Pedidos Delivery",
    "Nuevo Pedido Delivery",
    "Reportes"
])

# --- MODULO DE VENTAS ---
if menu == "Ventas":
    st.header("Nueva Venta")
    conn = obtener_conexion()
    df_productos = pd.read_sql_query("SELECT * FROM productos", conn)
    conn.close()

    col1, col2 = st.columns([2, 1])

    with col1:
        seleccion = st.selectbox("Selecciona el producto", df_productos["nombre"])
        cantidad = st.number_input("Cantidad", min_value=1, value=1)

        datos_prod = df_productos[df_productos["nombre"] == seleccion].iloc[0]

        envio = st.checkbox("Es para envio?")
        costo_envio = 0
        if envio:
            costo_envio = st.number_input("Costo de envio $", min_value=0.0, value=30.0)

    with col2:
        st.subheader("Resumen")
        subtotal = datos_prod["precio"] * cantidad
        total = subtotal + costo_envio
        st.write("**Producto:** " + str(seleccion))
        st.write("**Subtotal:** $" + str(round(subtotal, 2)))
        st.write("**Envio:** $" + str(round(costo_envio, 2)))
        st.divider()
        st.header("Total: $" + str(round(total, 2)))

        if st.button("CONFIRMAR VENTA", use_container_width=True):
            conn = obtener_conexion()
            cursor = conn.cursor()
            cursor.execute("INSERT INTO ventas (total, costo_envio) VALUES (?, ?)", (total, costo_envio))
            cursor.execute("UPDATE productos SET stock = stock - ? WHERE id = ?", (cantidad, datos_prod["id"]))
            conn.commit()
            conn.close()
            st.success("Venta registrada con exito")

# --- MODULO DE INVENTARIO ---
elif menu == "Inventario":
    st.header("Gestion de Inventario")
    conn = obtener_conexion()
    df_productos = pd.read_sql_query("SELECT * FROM productos", conn)
    st.dataframe(df_productos, use_container_width=True)

    with st.expander("Agregar Nuevo Producto"):
        nombre = st.text_input("Nombre")
        precio = st.number_input("Precio", min_value=0.0)
        stock = st.number_input("Stock Inicial", min_value=0)
        if st.button("Guardar Producto"):
            cursor = conn.cursor()
            cursor.execute("INSERT INTO productos (nombre, precio, stock) VALUES (?,?,?)", (nombre, precio, stock))
            conn.commit()
            st.rerun()
    conn.close()

# --- MODULO NUEVO: VER PEDIDOS DE DELIVERY ---
elif menu == "Pedidos Delivery":
    mostrar_pedidos_delivery()

# --- MODULO NUEVO: REGISTRAR PEDIDO DE DELIVERY ---
elif menu == "Nuevo Pedido Delivery":
    ingresar_pedido_manual()

# --- MODULO DE REPORTES ---
elif menu == "Reportes":
    st.header("Reporte de Ventas")
    conn = obtener_conexion()
    df_ventas = pd.read_sql_query("SELECT * FROM ventas", conn)

    col1, col2, col3 = st.columns(3)
    col1.metric("Ventas Totales", "$" + str(round(df_ventas["total"].sum(), 2)))
    col2.metric("Tickets", len(df_ventas))
    col3.metric("Total Envios", "$" + str(round(df_ventas["costo_envio"].sum(), 2)))

    st.subheader("Ventas del dia")
    st.bar_chart(df_ventas["total"])

    st.subheader("Pedidos de Delivery")
    df_delivery = pd.read_sql_query("SELECT plataforma, COUNT(*) as pedidos, SUM(total) as total FROM pedidos_delivery GROUP BY plataforma", conn)
    if not df_delivery.empty:
        st.dataframe(df_delivery, use_container_width=True)
    else:
        st.info("Sin pedidos de delivery registrados.")
    conn.close()
