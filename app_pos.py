import streamlit as st
import sqlite3
import pandas as pd
from datetime import datetime

# Configuración de la página
st.set_page_config(page_title="POS La Casa del Chilaquil", layout="wide")

def obtener_conexion():
    return sqlite3.connect('pos_lacasa.db')

st.title("🍳 POS La Casa del Chilaquil")
st.sidebar.header("Navegación")
menu = st.sidebar.radio("Ir a:", ["Ventas", "Inventario", "Reportes"])

# --- MÓDULO DE VENTAS ---
if menu == "Ventas":
    st.header("🛒 Nueva Venta")
    conn = obtener_conexion()
    df_productos = pd.read_sql_query("SELECT * FROM productos", conn)
    conn.close()

    col1, col2 = st.columns([2, 1])

    with col1:
        seleccion = st.selectbox("Selecciona el producto", df_productos['nombre'])
        cantidad = st.number_input("Cantidad", min_value=1, value=1)
        
        datos_prod = df_productos[df_productos['nombre'] == seleccion].iloc[0]
        
        envio = st.checkbox("¿Es para envío?")
        costo_envio = 0
        if envio:
            costo_envio = st.number_input("Costo de envío $", min_value=0.0, value=30.0)

    with col2:
        st.subheader("Resumen")
        subtotal = datos_prod['precio'] * cantidad
        total = subtotal + costo_envio
        st.write(f"**Producto:** {seleccion}")
        st.write(f"**Subtotal:** ${subtotal:.2f}")
        st.write(f"**Envío:** ${costo_envio:.2f}")
        st.divider()
        st.header(f"Total: ${total:.2f}")
        
        if st.button("CONFIRMAR VENTA", use_container_width=True):
            conn = obtener_conexion()
            cursor = conn.cursor()
            # Guardar venta
            cursor.execute("INSERT INTO ventas (total, costo_envio) VALUES (?, ?)", (total, costo_envio))
            # Descontar stock
            cursor.execute("UPDATE productos SET stock = stock - ? WHERE id = ?", (cantidad, datos_prod['id']))
            conn.commit()
            conn.close()
            st.success("✅ Venta registrada con éxito")

# --- MÓDULO DE INVENTARIO ---
elif menu == "Inventario":
    st.header("📦 Gestión de Inventario")
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

# --- MÓDULO DE REPORTES ---
elif menu == "Reportes":
    st.header("📊 Reporte de Ventas")
    conn = obtener_conexion()
    df_ventas = pd.read_sql_query("SELECT * FROM ventas", conn)
    
    col1, col2, col3 = st.columns(3)
    col1.metric("Ventas Totales", f"${df_ventas['total'].sum():.2f}")
    col2.metric("Tickets", len(df_ventas))
    col3.metric("Total Envíos", f"${df_ventas['costo_envio'].sum():.2f}")
    
    st.bar_chart(df_ventas['total'])
    conn.close()
