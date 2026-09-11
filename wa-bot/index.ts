// ORP · Bot de pedidos por WhatsApp (La Casa del Chilaquil + Deligordas, misma cocina)
// ---------------------------------------------------------------------------
// Recibe los mensajes que manda 360dialog (formato Cloud API de Meta), platica
// con Claude usando el menú REAL del POS (Supabase) y deja el pedido en la tabla
// wa_pedidos para que el equipo lo acepte en el POS (pestaña WhatsApp).
//
// Claves (Supabase › Edge Functions › Secrets; las pega Alfredo, nunca en código):
//   ANTHROPIC_API_KEY   clave de console.anthropic.com
//   D360_API_KEY        clave de 360dialog (la de prueba o la real)
//   D360_BASE           https://waba-sandbox.360dialog.io  (prueba)  ó  https://waba-v2.360dialog.io (real)
//   WEBHOOK_TOKEN       una palabra secreta; 360dialog la manda en cada aviso
//   GOOGLE_MAPS_KEY     (opcional) para calcular el envío por calles
// ---------------------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const D360_KEY = Deno.env.get("D360_API_KEY") ?? "";
const D360_BASE = (Deno.env.get("D360_BASE") ?? "https://waba-v2.360dialog.io").replace(/\/+$/, "");
const WEBHOOK_TOKEN = Deno.env.get("WEBHOOK_TOKEN") ?? "";
const GMAPS_KEY = Deno.env.get("GOOGLE_MAPS_KEY") ?? "";
const ORIGEN = { lat: 25.430350727101576, lng: -100.98390007322949 }; // cocina (mismo punto que el POS)
const TZ = "America/Monterrey";
const ZONA = /saltillo|arteaga|ramos arizpe/i; // «envío a todo Saltillo, Arteaga y Ramos Arizpe»
const SIM = "SIMULADOR";

// ---------- utilidades ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-orp-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
// «844 123 4567, 844 765 4321» → ["8441234567", "8447654321"] (acepta comas, renglones, espacios o guiones)
const listaTels = (t: string | null | undefined) => String(t ?? "").split(/[,;\n\/]+/).flatMap((parte) => {
  const d = parte.replace(/\D/g, "");
  if (d.length >= 20) return d.match(/\d{12,13}(?=\d{10,13}|$)|\d{10}/g) ?? [];
  return d.length >= 10 ? [d.slice(-10)] : [];
}).map((x) => x.slice(-10));
const dinero = (n: number) => "$" + (Math.round(n * 100) / 100).toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const ahoraLocal = () =>
  new Date().toLocaleString("es-MX", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

// Tarifa de envío: la MISMA tabla del POS (km por calles, redondeado hacia arriba)
function costoEnvio(km: number) {
  const d = Math.ceil(km);
  const t: Record<number, number> = { 1: 25, 2: 25, 3: 37, 4: 47, 5: 56, 6: 65, 7: 74, 8: 84, 9: 93, 10: 102, 11: 112, 12: 121, 13: 130, 14: 140, 15: 149,
    16: 158, 17: 167, 18: 177, 19: 186, 20: 195, 21: 205, 22: 214, 23: 223, 24: 233, 25: 242, 26: 251, 27: 260, 28: 269, 29: 278, 30: 288 };
  return t[d] ?? 288 + (d - 30) * 10;
}
function kmLineaRecta(lat: number, lng: number) { // respaldo del POS cuando no hay ruta
  const R = 6371, dLat = (lat - ORIGEN.lat) * Math.PI / 180, dLon = (lng - ORIGEN.lng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(ORIGEN.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  const lr = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return lr * (lr < 2 ? 2.0 : lr < 4 ? 1.6 : lr < 7 ? 1.35 : 1.2);
}

async function config() {
  const { data } = await sb.from("config_orp").select("clave,valor,texto").like("clave", "bot_%");
  const c: Record<string, { valor: number | null; texto: string | null }> = {};
  (data ?? []).forEach((r) => (c[r.clave] = { valor: r.valor, texto: r.texto }));
  return c;
}

// ---------- menú real del POS ----------
type Opcion = { id: number; gid: number; nombre: string; precio: number };
type Grupo = { id: number; nombre: string; tipo: string; pids: number[]; orden: number };
type Producto = { id: number; nombre: string; precio: number; descripcion: string; categoria: string };

async function cargarMenu(excluir: number[]) {
  const [p, g, o, pOff, oOff] = await Promise.all([
    sb.from("productos").select("id,nombre,precio,descripcion,stock,categorias(nombre)").eq("activo", true).order("nombre"),
    sb.from("grupos_modificadores").select("id,nombre,tipo,producto_ids,orden").eq("activo", true).order("orden"),
    sb.from("opciones_modificadores").select("id,grupo_id,nombre,precio_extra").eq("activo", true).order("id"),
    sb.from("productos").select("id,nombre").eq("activo", false),
    sb.from("opciones_modificadores").select("id,grupo_id,nombre").eq("activo", false),
  ]);
  // Lo que se apagó o se quedó sin stock: el bot no lo vende, avisa al cliente y le avisa al equipo
  const gruposActivos = new Map((g.data ?? []).map((x: any) => [x.id, x.nombre]));
  const activasNom = new Set((o.data ?? []).map((x: any) => String(x.nombre).trim().toLowerCase())); // si sigue activa en otro grupo, no está agotada
  const agotados = [
    ...(p.data ?? []).filter((x: any) => !excluir.includes(x.id) && x.stock != null && Number(x.stock) <= 0).map((x: any) => ({ id: x.id, nombre: x.nombre, tipo: "producto", motivo: "sin stock" })),
    ...(pOff.data ?? []).filter((x: any) => !excluir.includes(x.id)).map((x: any) => ({ id: x.id, nombre: x.nombre, tipo: "producto", motivo: "apagado" })),
    ...(oOff.data ?? []).filter((x: any) => gruposActivos.has(x.grupo_id) && !activasNom.has(String(x.nombre).trim().toLowerCase())).map((x: any) => ({ id: x.id, nombre: `${x.nombre} (${gruposActivos.get(x.grupo_id)})`, tipo: "opcion", motivo: "apagado" })),
  ];
  const sinStock = new Set(agotados.filter((a) => a.tipo === "producto").map((a) => a.id));
  const productos: Producto[] = (p.data ?? []).filter((x) => !excluir.includes(x.id) && !sinStock.has(x.id)).map((x: any) => ({
    id: x.id, nombre: x.nombre, precio: Number(x.precio), descripcion: x.descripcion ?? "", categoria: x.categorias?.nombre ?? "",
  }));
  const grupos: Grupo[] = (g.data ?? []).map((x: any) => ({ id: x.id, nombre: x.nombre, tipo: x.tipo, pids: x.producto_ids ?? [], orden: x.orden ?? 0 }));
  const opciones: Opcion[] = (o.data ?? []).map((x: any) => ({ id: x.id, gid: x.grupo_id, nombre: x.nombre, precio: Number(x.precio_extra || 0) }));
  return { productos, grupos, opciones, agotados };
}

function menuTexto(m: Awaited<ReturnType<typeof cargarMenu>>) {
  const marca = (cat: string) => /gordit/i.test(cat) ? "Deligordas" : /bebida/i.test(cat) ? "cualquiera de las dos" : "La Casa del Chilaquil";
  return m.productos.map((p) => {
    const gs = m.grupos.filter((g) => g.pids.includes(p.id));
    const lin = gs.map((g) => {
      const os = m.opciones.filter((o) => o.gid === g.id).map((o) => `[${o.id}] ${o.nombre}${o.precio ? ` +${dinero(o.precio)}` : ""}`).join(", ");
      const regla = g.tipo === "select" ? "ELIGE UNA (obligatorio) → va en «opciones»"
        : g.tipo === "remove" ? "VIENEN INCLUIDOS; si pide SIN alguno, su id va en «sin»"
        : "EXTRA con costo, puede pedir varios → va en «extras» con cantidad";
      return `     · ${g.nombre} (${regla}): ${os}`;
    }).join("\n");
    return `- [${p.id}] ${p.nombre} — ${dinero(p.precio)}  (marca: ${marca(p.categoria)}; categoría: ${p.categoria})${p.descripcion ? ` · ${p.descripcion}` : ""}${lin ? "\n" + lin : ""}`;
  }).join("\n");
}

// ---------- precios del lado del servidor (nunca los inventa el modelo) ----------
type ItemIn = { producto_id: number; cantidad?: number; opciones?: number[]; sin?: number[]; extras?: { opcion_id: number; cantidad?: number }[]; nota?: string; toppings_preguntados?: boolean };
function valorarItems(items: ItemIn[], m: Awaited<ReturnType<typeof cargarMenu>>) {
  const errores: string[] = [];
  const lineas = (items ?? []).map((it) => {
    const p = m.productos.find((x) => x.id === Number(it.producto_id));
    if (!p) {
      const ag = m.agotados.find((a) => a.tipo === "producto" && a.id === Number(it.producto_id));
      errores.push(ag ? `${ag.nombre} está agotado por ahora: díselo al cliente, ofrécele algo parecido del menú y usa avisar_agotado` : `El producto ${it.producto_id} no está en el menú de WhatsApp`);
      return null;
    }
    const cant = Math.max(1, Math.round(Number(it.cantidad || 1)));
    const gs = m.grupos.filter((g) => g.pids.includes(p.id));
    const opc = (ids: number[] | undefined) => (ids ?? []).map((id) => m.opciones.find((o) => o.id === Number(id))).filter(Boolean) as Opcion[];
    const elegidas = opc(it.opciones), sin = opc(it.sin);
    const extras = (it.extras ?? []).map((e) => ({ o: m.opciones.find((o) => o.id === Number(e.opcion_id)), c: Math.max(1, Math.round(Number(e.cantidad || 1))) }))
      .filter((e) => e.o) as { o: Opcion; c: number }[];
    for (const g of gs.filter((g) => g.tipo === "select")) {
      const n = elegidas.filter((o) => o.gid === g.id).length;
      if (n === 0) errores.push(`Falta elegir «${g.nombre}» para ${p.nombre}`);
      if (n > 1) errores.push(`Solo se puede elegir una opción de «${g.nombre}» para ${p.nombre}`);
    }
    const valida = (o: Opcion, tipo: string) => gs.some((g) => g.id === o.gid && g.tipo === tipo);
    elegidas.forEach((o) => { if (!valida(o, "select")) errores.push(`«${o.nombre}» no es una opción de ${p.nombre}`); });
    sin.forEach((o) => { if (!valida(o, "remove")) errores.push(`«${o.nombre}» no se puede quitar de ${p.nombre}`); });
    extras.forEach((e) => { if (!valida(e.o, "add")) errores.push(`«${e.o.nombre}» no es un extra de ${p.nombre}`); });
    const quitables = gs.filter((g) => g.tipo === "remove");
    if (quitables.length && !it.toppings_preguntados && !sin.length) {
      const lista = m.opciones.filter((o) => quitables.some((g) => g.id === o.gid)).map((o) => o.nombre.toLowerCase()).join(", ");
      errores.push(`Falta preguntarle al cliente si quiere ${p.nombre} con todo (${lista}) o sin alguno. Pregúntale y marca toppings_preguntados=true`);
    }
    const unitario = p.precio + elegidas.reduce((s, o) => s + o.precio, 0) + extras.reduce((s, e) => s + e.o.precio * e.c, 0);
    const detalle = [
      ...elegidas.map((o) => o.nombre + (o.precio ? ` (+${dinero(o.precio)})` : "")),
      ...(gs.some((g) => g.tipo === "remove") && !sin.length ? ["Con todo"] : []),
      ...sin.map((o) => "Sin " + o.nombre),
      ...extras.map((e) => `Extra ${e.o.nombre}${e.c > 1 ? " x" + e.c : ""} (+${dinero(e.o.precio * e.c)})`),
    ];
    return { producto_id: p.id, nombre: p.nombre, cantidad: cant, precio_unitario: unitario, importe: unitario * cant,
      opciones: elegidas.map((o) => o.id), sin: sin.map((o) => o.id), extras: extras.map((e) => ({ opcion_id: e.o.id, cantidad: e.c })),
      detalle: detalle.join(", "), nota: it.nota ?? "" };
  }).filter(Boolean) as any[];
  if (!lineas.length && !errores.length) errores.push("El pedido no tiene productos");
  return { lineas, errores, subtotal: lineas.reduce((s, l) => s + l.importe, 0) };
}

// ---------- promociones (misma regla que el POS) ----------
type Promo = { id: number; nombre: string; tipo: string; activo: boolean; porcentaje: number | null; producto_ids: number[] | null;
  componentes: { producto_ids: number[]; cantidad: number }[] | null; precio: number | null; dias: number[] | null;
  hora_ini: string | null; hora_fin: string | null; whatsapp: boolean };
async function cargarPromos(): Promise<Promo[]> {
  const { data } = await sb.from("promociones").select("*").eq("activo", true).eq("whatsapp", true);
  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const hm = String(ahora.getHours()).padStart(2, "0") + ":" + String(ahora.getMinutes()).padStart(2, "0");
  return ((data ?? []) as Promo[]).filter((p) => (!p.dias?.length || p.dias.includes(ahora.getDay())) &&
    (!p.hora_ini || hm >= p.hora_ini) && (!p.hora_fin || hm <= p.hora_fin));
}
type Aplicada = { id: number; nombre: string; tipo: string; veces: number; descuento: number };
function aplicarPromos(lineas: any[], promos: Promo[], m: Awaited<ReturnType<typeof cargarMenu>>) {
  const base = (pid: number) => m.productos.find((x) => x.id === pid)?.precio ?? 0;
  const unidades: { pid: number; base: number; unit: number; usada: boolean }[] = [];
  for (const l of lineas) for (let i = 0; i < (l.cantidad || 1); i++) unidades.push({ pid: Number(l.producto_id), base: base(Number(l.producto_id)), unit: Number(l.precio_unitario), usada: false });
  const teorico = (c: Promo) => (c.componentes ?? []).reduce((s, comp) => s + Math.max(0, ...comp.producto_ids.map(base)) * (comp.cantidad || 1), 0) - Number(c.precio ?? 0);
  const aplicadas: Aplicada[] = [];
  for (const c of promos.filter((p) => p.tipo === "combo" && p.componentes?.length && p.precio != null).sort((a, b) => teorico(b) - teorico(a))) {
    let veces = 0, ahorro = 0;
    while (true) {
      const elegidas: typeof unidades = [];
      let ok = true;
      for (const comp of c.componentes!) {
        for (let k = 0; k < (comp.cantidad || 1) && ok; k++) {
          const cand = unidades.filter((u) => !u.usada && !elegidas.includes(u) && comp.producto_ids.includes(u.pid)).sort((a, b) => b.base - a.base)[0];
          if (!cand) ok = false; else elegidas.push(cand);
        }
        if (!ok) break;
      }
      if (!ok) break;
      const suma = elegidas.reduce((s, u) => s + u.base, 0);
      if (suma - Number(c.precio) <= 0) break;
      elegidas.forEach((u) => (u.usada = true));
      veces++; ahorro += suma - Number(c.precio);
    }
    if (veces) aplicadas.push({ id: c.id, nombre: c.nombre, tipo: "combo", veces, descuento: Math.round(ahorro * 100) / 100 });
  }
  const porPromo: Record<number, Aplicada> = {};
  for (const u of unidades.filter((u) => !u.usada)) {
    let mejor: Promo | null = null;
    for (const p of promos) if (p.tipo === "descuento" && p.porcentaje && p.producto_ids?.includes(u.pid) && (!mejor || Number(p.porcentaje) > Number(mejor.porcentaje))) mejor = p;
    if (!mejor) continue;
    porPromo[mejor.id] ??= { id: mejor.id, nombre: mejor.nombre, tipo: "descuento", veces: 0, descuento: 0 };
    porPromo[mejor.id].veces++; porPromo[mejor.id].descuento += u.unit * Number(mejor.porcentaje) / 100;
  }
  for (const a of Object.values(porPromo)) { a.descuento = Math.round(a.descuento * 100) / 100; aplicadas.push(a); }
  return { aplicadas, descuento: Math.round(aplicadas.reduce((s, a) => s + a.descuento, 0) * 100) / 100 };
}
const promoTxt = (a: Aplicada) => `${a.tipo === "combo" ? "🎁" : "🏷️"} ${a.nombre}${a.veces > 1 ? " ×" + a.veces : ""}: −${dinero(a.descuento)}`;
function promosTexto(promos: Promo[], m: Awaited<ReturnType<typeof cargarMenu>>) {
  const nom = (pid: number) => m.productos.find((x) => x.id === pid)?.nombre ?? `#${pid}`;
  const base = (pid: number) => m.productos.find((x) => x.id === pid)?.precio ?? 0;
  return promos.map((p) => p.tipo === "combo"
    ? `- 🎁 ${p.nombre}: ${(p.componentes ?? []).map((c) => (c.cantidad > 1 ? c.cantidad + "× " : "") + c.producto_ids.map(nom).join(" o ")).join(" + ")} por ${dinero(Number(p.precio))} (normal ${dinero((p.componentes ?? []).reduce((s, c) => s + Math.max(0, ...c.producto_ids.map(base)) * (c.cantidad || 1), 0))})`
    : `- 🏷️ ${p.nombre}: ${p.porcentaje}% de descuento en ${(p.producto_ids ?? []).map(nom).join(", ")}`).join("\n");
}

// ---------- envío ----------
// Busca como en Google Maps: sirve con dirección («Allende 123, Centro») o con el nombre de un lugar
// («Fiscalía General del Estado, Nuevo Centro Metropolitano»). Primero Places (lugares), luego Geocoding (direcciones).
async function buscarLugar(texto: string): Promise<{ lat: number; lng: number; direccion: string; lugar?: string; via: string } | null> {
  const q = /saltillo|arteaga|ramos arizpe|coahuila/i.test(texto) ? texto : texto + ", Saltillo, Coahuila";
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GMAPS_KEY, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location" },
      body: JSON.stringify({ textQuery: q, languageCode: "es", regionCode: "MX", locationBias: { circle: { center: { latitude: ORIGEN.lat, longitude: ORIGEN.lng }, radius: 40000 } } }),
    });
    const j = await r.json();
    const p = j.places?.[0];
    if (p?.location) return { lat: p.location.latitude, lng: p.location.longitude, direccion: p.formattedAddress ?? q, lugar: p.displayName?.text, via: "places" };
    if (!r.ok) console.error("places", r.status, JSON.stringify(j).slice(0, 300));
  } catch (e) { console.error("places", e); }
  try { // API vieja de lugares, por si la nueva no está habilitada en la llave
    const u = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(q)}&inputtype=textquery` +
      `&fields=name,formatted_address,geometry&locationbias=circle:40000@${ORIGEN.lat},${ORIGEN.lng}&language=es&key=${GMAPS_KEY}`;
    const j = await (await fetch(u)).json();
    const c = j.candidates?.[0];
    if (c?.geometry?.location) return { lat: c.geometry.location.lat, lng: c.geometry.location.lng, direccion: c.formatted_address ?? q, lugar: c.name, via: "places-v1" };
    if (j.status && j.status !== "ZERO_RESULTS") console.error("findplace", j.status, j.error_message ?? "");
  } catch (e) { console.error("findplace", e); }
  const u = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q + ", México")}` +
    `&bounds=25.30,-101.20|25.60,-100.80&region=mx&language=es&key=${GMAPS_KEY}`;
  const g = await (await fetch(u)).json();
  const r = g.results?.[0];
  // si solo encontró «Saltillo» (la ciudad entera) no sirve para entregar
  if (!r || (r.types ?? []).some((t: string) => ["locality", "administrative_area_level_1", "administrative_area_level_2", "country"].includes(t))) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, direccion: r.formatted_address, via: "geocode" };
}

async function cotizarEnvio(direccion: string | undefined, lat?: number, lng?: number) {
  let dLat = lat, dLng = lng, formateada = direccion ?? "", lugar: string | undefined;
  if ((dLat == null || dLng == null) && direccion && GMAPS_KEY) {
    const r = await buscarLugar(direccion);
    if (!r) return { ok: false, error: "No encontré ese lugar. Pídele el nombre de algún lugar conocido cerca, calle y colonia, o que mande su ubicación 📍." };
    dLat = r.lat; dLng = r.lng; formateada = r.direccion; lugar = r.lugar;
  }
  if (dLat == null || dLng == null) return { ok: false, error: "Necesito la dirección completa o la ubicación 📍 del cliente." };
  let km = kmLineaRecta(dLat, dLng), metodo = "aprox";
  if (GMAPS_KEY) {
    try {
      const u = `https://maps.googleapis.com/maps/api/directions/json?origin=${ORIGEN.lat},${ORIGEN.lng}&destination=${dLat},${dLng}&alternatives=true&mode=driving&key=${GMAPS_KEY}`;
      const d = await (await fetch(u)).json();
      if (d.routes?.length) {
        km = Math.min(...d.routes.map((r: any) => r.legs[0].distance.value)) / 1000; metodo = "por calles";
        if (!formateada) formateada = d.routes[0].legs[0].end_address;
      }
    } catch (_) { /* se queda la aproximación */ }
  }
  const enZona = !formateada || ZONA.test(formateada);
  return { ok: true, lugar, direccion: formateada, lat: dLat, lng: dLng, km: Math.round(km * 10) / 10, envio: costoEnvio(km), metodo, en_zona: enZona,
    nota: lugar ? `Confírmale al cliente el lugar que encontré: «${lugar}, ${formateada}» y pídele referencias para encontrarlo ahí (edificio, puerta, a quién preguntar).` : undefined };
}

// ---------- herramientas que puede usar Claude ----------
const TOOLS = [
  {
    name: "cotizar_envio",
    description: "Calcula el costo de envío a domicilio con la tarifa de la cocina. Úsala en cuanto tengas la dirección (o si el cliente mandó su ubicación 📍, con usar_ubicacion=true).",
    input_schema: { type: "object", properties: {
      direccion: { type: "string", description: "Lo que diga el cliente tal cual: calle, número y colonia, o el nombre de un lugar conocido (ej. «Fiscalía General del Estado, Nuevo Centro Metropolitano», «Hospital Universitario», «Galerías Saltillo»). Se busca como en Google Maps." },
      usar_ubicacion: { type: "boolean", description: "true si el cliente compartió su ubicación de WhatsApp" },
    } },
  },
  {
    name: "revisar_pedido",
    description: "Valida el pedido contra el menú y devuelve los precios EXACTOS, el envío y el total. Úsala SIEMPRE antes de decirle un total al cliente.",
    input_schema: { type: "object", properties: {
      items: { type: "array", items: { type: "object", properties: {
        producto_id: { type: "integer" }, cantidad: { type: "integer" },
        opciones: { type: "array", items: { type: "integer" }, description: "ids de opciones de grupos ELIGE UNA" },
        sin: { type: "array", items: { type: "integer" }, description: "ids de toppings incluidos que NO quiere" },
        extras: { type: "array", items: { type: "object", properties: { opcion_id: { type: "integer" }, cantidad: { type: "integer" } }, required: ["opcion_id"] } },
        nota: { type: "string" },
        toppings_preguntados: { type: "boolean", description: "true cuando el cliente ya dijo si lo quiere con todos los toppings o sin alguno" },
      }, required: ["producto_id"] } },
      entrega: { type: "string", enum: ["pickup", "domicilio"] },
      direccion: { type: "string" },
      pago: { type: "string", enum: ["efectivo", "transferencia"] },
      nombre: { type: "string" },
      agregar_a: { type: "integer", description: "Folio del pedido reciente del cliente si SOLO quiere agregarle productos (items = únicamente lo nuevo)" },
    }, required: ["items"] },
  },
  {
    name: "registrar_pedido",
    description: "Registra el pedido en el POS. SOLO después de que el cliente confirmó el resumen y el total que le diste con revisar_pedido.",
    input_schema: { type: "object", properties: {
      nombre: { type: "string", description: "Nombre del cliente" },
      entrega: { type: "string", enum: ["pickup", "domicilio"] },
      direccion: { type: "string" }, referencias: { type: "string", description: "Entre calles, color de casa, etc." },
      pago: { type: "string", enum: ["efectivo", "transferencia"] },
      paga_con: { type: "number", description: "Con cuánto paga en efectivo, para llevar cambio" },
      items: { type: "array", items: { type: "object", properties: {
        producto_id: { type: "integer" }, cantidad: { type: "integer" },
        opciones: { type: "array", items: { type: "integer" } }, sin: { type: "array", items: { type: "integer" } },
        extras: { type: "array", items: { type: "object", properties: { opcion_id: { type: "integer" }, cantidad: { type: "integer" } }, required: ["opcion_id"] } },
        nota: { type: "string" },
        toppings_preguntados: { type: "boolean", description: "true cuando el cliente ya dijo si lo quiere con todos los toppings o sin alguno" },
      }, required: ["producto_id"] } },
      notas: { type: "string" },
      agregar_a: { type: "integer", description: "Folio del pedido reciente al que se agregan productos (items = únicamente lo nuevo)" },
    }, required: ["items"] },
  },
  {
    name: "avisar_equipo",
    description: "Manda una alerta al POS para que el equipo de la cocina resuelva algo, y el bot deja de contestar este chat para que lo atienda una persona. Úsala SIEMPRE que quien escribe sea un REPARTIDOR (nuestro o de Rappi, DiDi o Uber), con cualquier tema. También cuando un CLIENTE avisa algo de un pedido que ya hizo: ya llegó a la tienda por él, no le ha llegado, llegó incompleto o mal.",
    input_schema: { type: "object", properties: {
      quien: { type: "string", enum: ["repartidor", "cliente"] },
      tema: { type: "string", description: "Resumen corto y claro para el equipo, ej. «El repartidor está en el domicilio del pedido #12 y el cliente no sale ni contesta»" },
      pedido: { type: "integer", description: "Folio del pedido si lo mencionan o lo sabes" },
      plataforma: { type: "string", enum: ["propio", "rappi", "didi", "uber", "no se sabe"], description: "De qué canal es el pedido del que habla" },
    }, required: ["quien", "tema"] },
  },
  {
    name: "avisar_agotado",
    description: "Avisa al equipo (alerta en el POS) que un cliente pidió algo que está agotado o apagado, para que lo vuelvan a encender en cuanto llegue. NO pasa el chat al equipo: tú sigues atendiendo al cliente.",
    input_schema: { type: "object", properties: { nombre: { type: "string", description: "Lo que pidió y no hay, como aparece en la lista de NO DISPONIBLE" } }, required: ["nombre"] },
  },
  {
    name: "pasar_a_humano",
    description: "Pasa la conversación al equipo: quejas, algo que no está en el menú, pedidos grandes o para evento, facturas, dudas que no sabes, o si el cliente pide hablar con una persona.",
    input_schema: { type: "object", properties: { motivo: { type: "string" } }, required: ["motivo"] },
  },
];

function reglas(c: Awaited<ReturnType<typeof config>>, reciente: string, promosTxt = "", agotadosTxt = "") {
  const t = (k: string) => (c[k]?.texto ?? "").trim();
  return `Eres quien toma los pedidos por WhatsApp de una cocina en Saltillo que tiene dos marcas: LA CASA DEL CHILAQUIL (chilaquiles) y DELIGORDAS (gorditas). Es la misma cocina: en un solo pedido pueden venir productos de las dos.

Hoy es ${ahoraLocal()} (hora de Saltillo).
Horario de pedidos: ${t("bot_horario") || "no lo tengo; si preguntan, di que lo confirma el equipo"}.
Tiempo aproximado para recoger en tienda: ${t("bot_tiempo_pickup") || "lo confirma el equipo"}.
Tiempo aproximado de entrega a domicilio: ${t("bot_tiempo_domicilio") || "lo confirma el equipo"}.
Envío a todo Saltillo, Arteaga y Ramos Arizpe (el costo se calcula con cotizar_envio).
Pago: efectivo o transferencia. Si es efectivo A DOMICILIO pregunta con cuánto paga para llevar cambio; si es para recoger en tienda y en efectivo paga al recoger, no preguntes con cuánto paga.
Datos para transferencia: ${t("bot_transferencia") || "no los tengo; di que el equipo se los manda en un momento"}.
${t("bot_notas") ? "Indicaciones del dueño: " + t("bot_notas") : ""}

QUIÉN TE ESCRIBE
- A este número escriben CLIENTES y también REPARTIDORES (los nuestros o de Rappi, DiDi o Uber) para avisar algo de una entrega. NUNCA preguntes si es cliente o repartidor ni des opciones tipo "¿vas a pedir o eres repartidor?". Dedúcelo por lo que escribe.
- Es REPARTIDOR si habla como quien LLEVA o RECOGE un pedido: "el cliente no sale", "no contesta", "ya estoy en el domicilio", "no encuentro la dirección", "vengo por el pedido de Rappi/DiDi/Uber", "¿a nombre de quién?", "no traigo cambio", "voy en camino", un código o número de orden de plataforma, etc. Entonces usa avisar_equipo (quien=repartidor) con un resumen claro y contesta MUY breve, por ejemplo: "Enterado 👍 ya le aviso al equipo para que lo resuelva." Si no sabes de qué pedido habla, en esa misma respuesta pídele el número de pedido o el nombre del cliente. A un repartidor no le ofrezcas el menú ni le tomes pedido.
- Un CLIENTE que dice "ya llegué" o "estoy afuera" normalmente viene a recoger SU pedido a la tienda (revisa si tiene pedido reciente para recoger): es cliente. Usa avisar_equipo (quien=cliente) y dile que enseguida se lo entregan.
- Si un cliente avisa un problema con un pedido que ya hizo (no llega, llegó incompleto o mal), usa avisar_equipo (quien=cliente) y dile que el equipo lo revisa en un momento.
- POR DEFECTO ES CLIENTE. Si solo saluda ("hola", "buenas tardes") o no queda claro, trátalo como cliente: salúdalo cálido, dale la bienvenida a La Casa del Chilaquil y Deligordas e invítalo a pedir (ej. "¡Hola! 😊 Bienvenido a La Casa del Chilaquil y Deligordas. ¿Qué se te antoja hoy?"). Solo toma el camino de repartidor cuando lo que escribe lo deja claro.

CÓMO ATIENDES
- Escribe como en WhatsApp: corto, cálido, natural, español de México. Nada de párrafos largos ni listas enormes. En WhatsApp las negritas llevan UN solo asterisco (*así*), nunca dos. Úsalas solo para el resumen y el total. Uno o dos emojis como mucho.
- Pide solo lo que falta, en una sola pregunta cuando se pueda. No repitas lo que el cliente ya dijo ni le enlistes los toppings incluidos.
- Entiende lo que pide aunque lo escriba informal ("unas chilas verdes con pollo", "2 gorditas de chicharrón"). Tradúcelo a productos y opciones del MENÚ con sus ids.
- Solo vende lo que está en el MENÚ, con esos nombres. Nunca inventes productos, precios, promociones ni tiempos. "Chilas" = chilaquiles. "Chilaquiles" a secas = Chilaquiles Grandes ($118); los chicos son Mini Chilaquiles.
- Para cada producto con grupos «ELIGE UNA», pregunta lo que falte (totopo, salsa, proteína, masa, guiso). Si no le importa, sugiere lo más pedido: totopo Natural, salsa Verde cremosa, proteína Pollo.
- Los chilaquiles llevan toppings incluidos (queso, crema, frijoles, cebolla y cilantro). SIEMPRE pregunta, por cada chilaquil, si lo quiere con todo o sin alguno (ej. "¿Con todo: queso, crema, frijoles, cebolla y cilantro?"). Si no lo preguntas, el sistema no te deja cerrar el pedido.
- Cuando haga sentido, sugiere UNA cosa extra (un refresco, un extra de proteína) sin insistir.
- Pregunta: ¿lo pasa a recoger a la tienda o se lo llevamos a domicilio? (NUNCA le digas «pickup» al cliente: mucha gente no conoce la palabra. Di «recoger en tienda». En el resumen escribe «🏪 Recoger en tienda» o «🛵 A domicilio».) Si es a domicilio pide la dirección, o el nombre del lugar si es un lugar conocido (oficina, hospital, plaza, escuela), o su ubicación 📍, y usa cotizar_envio. Si el cliente no sabe calle y número pero te dice el nombre del lugar, NO le insistas: busca con ese nombre, confírmale el lugar que encontraste y pídele referencias (edificio, puerta, a quién preguntar). Si queda fuera de zona, díselo con amabilidad y ofrece que lo pase a recoger a la tienda.
- Nunca digas un total sin usar antes revisar_pedido.
- CIERRE: cuando ya tengas TODO (productos con sus opciones y toppings, recoger en tienda o domicilio con dirección, forma de pago y nombre), usa revisar_pedido con todo eso y manda UN resumen final completo: cada producto con su detalle, entrega (y dirección), pago, nombre y el *total*. Termina preguntando "¿Es correcto? ¿Es todo?".
- Solo si el cliente responde a ese resumen con algo afirmativo (sí, ok, correcto, así está bien, es todo, va, dale, 👍…) usa registrar_pedido con exactamente lo mismo. Si agrega o cambia algo, vuelve a usar revisar_pedido y a confirmar. El sistema no te deja registrar sin ese resumen confirmado.
- AGREGAR A UN PEDIDO: si el cliente ya tiene un pedido reciente (abajo) y quiere sumarle algo ("agrégame…", "también quiero…", "se me olvidó…"), NO hagas un pedido completo nuevo ni repitas lo que ya pidió. Usa revisar_pedido y registrar_pedido con agregar_a=<folio> y en items SOLO lo nuevo. Resumen corto: "Agregamos a tu pedido #N: … Nuevo total: *$X*. ¿Es correcto?". Si es efectivo a domicilio, confirma con cuánto paga ahora. Si el sistema dice que ese pedido ya salió, díselo y ofrécele hacerlo como pedido nuevo (con su propio envío).
- Ya registrado, dale su número de pedido y, si paga con transferencia, pídele que mande aquí la foto del comprobante.
- Si algo no está claro o no lo sabes, pregunta o usa pasar_a_humano. Nunca prometas algo que no está aquí.
- Si te escriben algo que no tiene que ver con pedidos, contesta breve y amable y, si es cliente, regresa al pedido.

${promosTxt ? "PROMOCIONES VIGENTES (se aplican solas en revisar_pedido; no inventes otras):\n" + promosTxt + "\n- OBLIGATORIO: si el pedido ya trae parte de un combo pero le falta lo demás (ej. pidió chilaquiles grandes y no lleva Coca), en el mensaje donde muestras el resumen agrega ANTES de preguntar si es correcto una línea como: «🎁 Si le agregas una Coca queda en combo y solo pagas $X más (ahorras $Y)». X = precio normal de lo que falta − ahorro del combo. Solo una vez por pedido; si dice que no, no insistas.\n- En el resumen muestra cada promoción aplicada con su descuento, como te la regresa revisar_pedido.\n" : ""}${reciente ? "PEDIDO RECIENTE DE ESTE CLIENTE:\n" + reciente + "\n" : ""}
${agotadosTxt ? "NO DISPONIBLE AHORA (se terminó o está apagado; NO lo vendas):\n" + agotadosTxt + "\n- Si el cliente pide algo de esta lista, dile con amabilidad que por ahora se nos terminó, ofrécele una alternativa parecida del MENÚ y usa avisar_agotado con su nombre (una vez por producto). No lo menciones si no lo pide.\n\n" : ""}MENÚ (ids entre corchetes; los precios son exactos):`;
}

// ---------- Claude ----------
async function claude(system: any[], messages: any[], modelo: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: modelo, max_tokens: 800, system, messages, tools: TOOLS }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

// ---------- WhatsApp (360dialog) ----------
async function enviarWhatsApp(to: string, texto: string) {
  if (to === SIM || !D360_KEY) return;
  const url = D360_BASE.includes("sandbox") ? `${D360_BASE}/v1/messages` : `${D360_BASE}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "D360-API-KEY": D360_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: texto } }),
  });
  if (!r.ok) console.error("360dialog", r.status, await r.text());
}

// ---------- conversación ----------
async function historial(tel: string) {
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await sb.from("wa_mensajes").select("rol,texto,creado").eq("telefono", tel).gte("creado", desde)
    .order("creado", { ascending: false }).limit(40);
  const msgs: any[] = [];
  for (const m of (data ?? []).reverse()) {
    if (m.rol === "sistema" || !m.texto) continue;
    const role = m.rol === "cliente" ? "user" : "assistant";
    const texto = m.rol === "equipo" ? `[Mensaje del equipo de la cocina]: ${m.texto}` : m.texto;
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + texto;
    else msgs.push({ role, content: texto });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function atender(tel: string, nombre: string, texto: string, extra: { lat?: number; lng?: number; wa_id?: string; simulado?: boolean }) {
  // 1) guardar el mensaje (el wa_id único evita contestar dos veces si 360dialog reintenta)
  const ins = await sb.from("wa_mensajes").insert({ telefono: tel, rol: "cliente", texto, wa_id: extra.wa_id ?? null }).select("id").single();
  if (ins.error) return { ok: true, repetido: true };
  const miId = ins.data.id;
  const { data: chat } = await sb.from("wa_chats").select("*").eq("telefono", tel).maybeSingle();
  const contexto = { ...(chat?.contexto ?? {}) };
  if (extra.lat != null && extra.lng != null) contexto.ubicacion = { lat: extra.lat, lng: extra.lng };
  await sb.from("wa_chats").upsert({ telefono: tel, nombre: nombre || chat?.nombre || null, contexto, ultimo_mensaje: new Date().toISOString(),
    modo: chat?.modo ?? "bot", pausado_hasta: chat?.pausado_hasta ?? null });

  const c = await config();
  // bot_activo: 0 = apagado · 1 = contesta a todos · 2 = solo a los números de prueba (bot_probadores)
  const modoBot = Number(c.bot_activo?.valor ?? 0);
  const diez = (x: string) => String(x).replace(/\D/g, "").slice(-10);
  const probadores = listaTels(c.bot_probadores?.texto);
  if (!extra.simulado && !(modoBot === 1 || (modoBot === 2 && probadores.includes(diez(tel))))) return { ok: true, apagado: true };
  if (chat?.modo === "equipo" && chat.pausado_hasta && new Date(chat.pausado_hasta) > new Date()) return { ok: true, con_equipo: true };

  // 2) si llegan varios mensajes seguidos, contesta solo al último (con todo el contexto)
  await new Promise((r) => setTimeout(r, extra.simulado ? 200 : 2500));
  const { data: posterior } = await sb.from("wa_mensajes").select("id").eq("telefono", tel).eq("rol", "cliente").gt("id", miId).limit(1);
  if (posterior?.length) return { ok: true, esperando_otro: true };

  // 3) platicar con Claude
  const excluir = (c.bot_excluir?.texto ?? "").split(",").map((x) => Number(x.trim())).filter(Boolean);
  const menu = await cargarMenu(excluir);
  const reciente = await pedidoReciente(tel);
  const promos = await cargarPromos();
  const system = [
    { type: "text", text: reglas(c, reciente, promosTexto(promos, menu), menu.agotados.map((a) => "- " + a.nombre).join("\n")) },
    { type: "text", text: menuTexto(menu), cache_control: { type: "ephemeral" } },
  ];
  const modelo = (c.bot_modelo?.texto || "claude-haiku-4-5-20251001").trim();
  const messages = await historial(tel);
  let respuesta = "", tin = 0, tout = 0, pedido: any = null;
  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const r = await claude(system, messages, modelo);
    tin += (r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0);
    tout += r.usage?.output_tokens ?? 0;
    const textos = (r.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    if (r.stop_reason !== "tool_use") { respuesta = textos; break; }
    messages.push({ role: "assistant", content: r.content });
    const resultados: any[] = [];
    for (const b of r.content.filter((b: any) => b.type === "tool_use")) {
      let out: any;
      try { out = await herramienta(b.name, b.input, { tel, nombre, contexto, menu, simulado: !!extra.simulado, msgId: miId, promos }); }
      catch (e) { out = { ok: false, error: String(e) }; }
      if (b.name === "registrar_pedido" && out?.ok) pedido = out;
      resultados.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: resultados });
  }
  if (!respuesta) respuesta = "Dame un momento, te atiende alguien del equipo 🙌";
  respuesta = respuesta.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, ""); // formato de WhatsApp
  await sb.from("wa_mensajes").insert({ telefono: tel, rol: "bot", texto: respuesta, tokens_entrada: tin, tokens_salida: tout });
  await enviarWhatsApp(tel, respuesta);
  return { ok: true, respuesta, pedido, tokens: { entrada: tin, salida: tout }, modelo };
}

// Último pedido del cliente (12 h) con lo que ya se le agregó: el bot lo usa para ampliaciones
async function datosReciente(tel: string) {
  const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const { data } = await sb.from("wa_pedidos").select("*").eq("telefono", tel).gte("creado", desde)
    .is("pedido_padre", null).neq("estado", "rechazado").order("id", { ascending: false }).limit(1);
  const p = data?.[0];
  if (!p) return null;
  const { data: hijos } = await sb.from("wa_pedidos").select("id,items,total,estado").eq("pedido_padre", p.id).neq("estado", "rechazado");
  const total = Number(p.total) + (hijos ?? []).reduce((s: number, h: any) => s + Number(h.total), 0);
  return { p, hijos: hijos ?? [], total };
}
async function pedidoReciente(tel: string) {
  const r = await datosReciente(tel);
  if (!r) return "";
  const est: Record<string, string> = { nuevo: "recibido, todavía no lo acepta la cocina", aceptando: "aceptado, en preparación", aceptado: "aceptado, en preparación", listo: r.p.entrega === "domicilio" ? "YA SALIÓ a entrega" : "listo para recoger" };
  const lineas = [...(r.p.items ?? []), ...r.hijos.flatMap((h: any) => h.items ?? [])]
    .map((l: any) => `${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""}`).join("; ");
  return `Folio #${r.p.id} · estado: ${est[r.p.estado] ?? r.p.estado} · ${r.p.entrega}${r.p.direccion ? " a " + r.p.direccion : ""} · pago ${r.p.pago} · total actual ${dinero(r.total)} · lleva: ${lineas}`;
}

// Huella del pedido: si el cliente confirma un resumen, lo que se registra tiene que ser exactamente eso
function firmaPedido(lineas: any[], input: any) {
  return JSON.stringify({
    l: lineas.map((l) => [l.producto_id, l.cantidad, [...l.opciones].sort(), [...l.sin].sort(), l.extras.map((e: any) => [e.opcion_id, e.cantidad]).sort()]).sort(),
    e: input.entrega ?? "", p: input.pago ?? "", a: input.agregar_a ?? null,
  });
}

// Agregar productos a un pedido que el cliente ya hizo
async function ampliar(nombre: string, input: any, ctx: { tel: string; nombre: string; contexto: any; menu: any; simulado: boolean; msgId: number; promos: Promo[] }) {
  const r = await datosReciente(ctx.tel);
  if (!r || r.p.id !== Number(input.agregar_a)) {
    return { ok: false, errores: [`No encuentro un pedido reciente #${input.agregar_a} de este cliente. Si quiere algo más, hazlo como pedido nuevo.`] };
  }
  if (r.p.estado === "listo") {
    return { ok: false, errores: [`El pedido #${r.p.id} ya ${r.p.entrega === "domicilio" ? "salió a entrega" : "está listo"}; ya no se le puede agregar. Ofrécele un pedido nuevo${r.p.entrega === "domicilio" ? " (con su propio envío)" : ""}.`] };
  }
  const v = valorarItems(input.items, ctx.menu);
  if (v.errores.length) return { ok: false, errores: v.errores };
  // promociones sobre el pedido completo; aquí solo va la diferencia contra lo que ya tenía
  const previos = [r.p, ...r.hijos];
  const antes: Record<number, number> = {};
  let descAntes = 0;
  for (const x of previos) { descAntes += Number(x.descuento ?? 0); for (const a of (x.promos ?? [])) antes[a.id] = (antes[a.id] ?? 0) + Number(a.descuento); }
  const todo = aplicarPromos([...previos.flatMap((x: any) => x.items ?? []), ...v.lineas], ctx.promos, ctx.menu);
  const nuevas = todo.aplicadas.map((a) => ({ ...a, descuento: Math.round((a.descuento - (antes[a.id] ?? 0)) * 100) / 100 })).filter((a) => a.descuento > 0);
  const descExtra = Math.max(0, Math.round((todo.descuento - descAntes) * 100) / 100);
  const nuevoTotal = r.total + v.subtotal - descExtra;
  const resumen = [...v.lineas.map((l: any) => `${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""} — ${dinero(l.importe)}`), ...nuevas.map(promoTxt)];
  const firma = firmaPedido(v.lineas, { agregar_a: r.p.id, entrega: r.p.entrega, pago: r.p.pago });
  if (nombre === "revisar_pedido") {
    const previa = ctx.contexto.revision;
    ctx.contexto.revision = previa && previa.firma === firma ? previa : { firma, msg: ctx.msgId };
    await sb.from("wa_chats").update({ contexto: ctx.contexto }).eq("telefono", ctx.tel);
    return { ok: true, pedido: r.p.id, se_agrega: resumen, subtotal_agregado: v.subtotal, descuento_extra: descExtra, total_anterior: r.total, nuevo_total: nuevoTotal,
      pago: r.p.pago, paga_con_anterior: r.p.paga_con,
      siguiente: "Dile qué se agrega al pedido #" + r.p.id + " y el nuevo total, y pregunta si es correcto. Registra solo cuando conteste que sí." };
  }
  const rev = ctx.contexto.revision;
  if (!rev || rev.firma !== firma) return { ok: false, errores: ["Antes usa revisar_pedido con agregar_a y estos mismos productos, dile el nuevo total y espera su sí."] };
  if (!(ctx.msgId > rev.msg)) return { ok: false, errores: ["El cliente todavía no confirma lo que se agrega. Pregúntale si es correcto y espera su respuesta."] };
  const pagaCon = input.paga_con ?? r.p.paga_con ?? null;
  if (r.p.pago === "efectivo" && pagaCon && Number(pagaCon) < nuevoTotal) {
    return { ok: false, errores: [`Antes pagaba con ${dinero(pagaCon)} pero el nuevo total es ${dinero(nuevoTotal)}. Pregúntale con cuánto paga ahora.`] };
  }
  const nota = (t: any, x: string) => [t, x].filter(Boolean).join(" · ");
  let folio = r.p.id, ampliacion = false;
  if (r.p.estado === "nuevo") {
    // La cocina todavía no lo acepta: se actualiza el mismo pedido
    const unido = [...(r.p.items ?? []), ...v.lineas];
    const prU = aplicarPromos(unido, ctx.promos, ctx.menu);
    const subU = Number(r.p.subtotal) + v.subtotal;
    const { error } = await sb.from("wa_pedidos").update({
      items: unido, subtotal: subU, total: subU - prU.descuento + Number(r.p.envio ?? 0), descuento: prU.descuento, promos: prU.aplicadas.length ? prU.aplicadas : null,
      paga_con: pagaCon, notas: nota(r.p.notas, "➕ El cliente agregó: " + resumen.join("; ")), actualizado: new Date().toISOString(),
    }).eq("id", r.p.id).eq("estado", "nuevo");
    if (error) return { ok: false, errores: ["No se pudo actualizar: " + error.message] };
  } else {
    // Ya aceptado: va como ampliación, solo con lo nuevo (así la venta no se cuenta dos veces)
    const { data, error } = await sb.from("wa_pedidos").insert({
      telefono: ctx.tel, nombre: r.p.nombre, estado: "nuevo", entrega: r.p.entrega, direccion: r.p.direccion, referencias: r.p.referencias,
      lat: r.p.lat, lng: r.p.lng, km: r.p.km, pago: r.p.pago, paga_con: pagaCon, items: v.lineas, subtotal: v.subtotal, envio: 0, total: v.subtotal - descExtra,
      descuento: descExtra, promos: nuevas.length ? nuevas : null,
      notas: nota(input.notas, `Agregado al pedido #${r.p.id}. Total del pedido completo: ${dinero(nuevoTotal)}`), simulado: r.p.simulado, pedido_padre: r.p.id,
    }).select("id").single();
    if (error) return { ok: false, errores: ["No se pudo guardar: " + error.message] };
    folio = data.id; ampliacion = true;
  }
  ctx.contexto.revision = null;
  await sb.from("wa_chats").update({ contexto: ctx.contexto }).eq("telefono", ctx.tel);
  return { ok: true, folio: r.p.id, registro: folio, ampliacion, agregado: resumen, subtotal_agregado: v.subtotal, nuevo_total: nuevoTotal,
    nota: `Dile que ya quedó agregado a su pedido #${r.p.id} y el nuevo total. No le des otro número de pedido.` };
}

async function herramienta(nombre: string, input: any, ctx: { tel: string; nombre: string; contexto: any; menu: any; simulado: boolean; msgId: number; promos: Promo[] }) {
  if (nombre === "cotizar_envio") {
    const u = input.usar_ubicacion ? ctx.contexto.ubicacion : null;
    const r = await cotizarEnvio(input.direccion, u?.lat, u?.lng);
    if (r.ok) {
      ctx.contexto.cotizacion = r;
      await sb.from("wa_chats").update({ contexto: ctx.contexto }).eq("telefono", ctx.tel);
    }
    return r;
  }
  if ((nombre === "revisar_pedido" || nombre === "registrar_pedido") && input.agregar_a) {
    return await ampliar(nombre, input, ctx);
  }
  if (nombre === "revisar_pedido" || nombre === "registrar_pedido") {
    const v = valorarItems(input.items, ctx.menu);
    if (v.errores.length) return { ok: false, errores: v.errores };
    if (nombre === "registrar_pedido" && (!input.nombre && !ctx.nombre || !input.entrega || !input.pago)) {
      return { ok: false, errores: ["Faltan datos: " + [!input.entrega && "entrega", !input.pago && "pago", !(input.nombre || ctx.nombre) && "nombre"].filter(Boolean).join(", ")] };
    }
    let envio = 0, cot: any = null;
    if (input.entrega === "domicilio") {
      cot = ctx.contexto.cotizacion;
      if (input.direccion && (!cot || !String(cot.direccion ?? "").toLowerCase().includes(String(input.direccion).toLowerCase().slice(0, 10)))) {
        const r = await cotizarEnvio(input.direccion);
        if (r.ok) cot = r;
      }
      if (!cot) return { ok: false, errores: ["Falta cotizar el envío: pide la dirección o la ubicación y usa cotizar_envio"] };
      envio = cot.envio;
    }
    const pr = aplicarPromos(v.lineas, ctx.promos, ctx.menu);
    const total = v.subtotal - pr.descuento + envio;
    const resumen = [...v.lineas.map((l: any) => `${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""} — ${dinero(l.importe)}`),
      ...pr.aplicadas.map(promoTxt)];
    const firma = firmaPedido(v.lineas, input);
    if (nombre === "revisar_pedido") {
      const completo = !!(input.entrega && input.pago);
      // Si vuelve a revisar lo mismo, se conserva el momento del primer resumen (así el "sí" del cliente sí cuenta)
      const previa = ctx.contexto.revision;
      ctx.contexto.revision = !completo ? null : (previa && previa.firma === firma ? previa : { firma, msg: ctx.msgId });
      await sb.from("wa_chats").update({ contexto: ctx.contexto }).eq("telefono", ctx.tel);
      return { ok: true, lineas: resumen, subtotal: v.subtotal, descuento: pr.descuento, envio, total,
        siguiente: completo ? "Manda el resumen final completo y pregunta si es correcto y si es todo. Registra solo cuando conteste que sí."
          : "Todavía falta " + [!input.entrega && "si es para recoger en tienda o a domicilio", !input.pago && "forma de pago"].filter(Boolean).join(" y ") + " para el resumen final." };
    }
    const rev = ctx.contexto.revision;
    if (!rev || rev.firma !== firma) {
      return { ok: false, errores: ["Antes de registrar usa revisar_pedido con estos mismos productos, entrega y pago, manda el resumen final y espera a que el cliente diga que sí."] };
    }
    if (!(ctx.msgId > rev.msg)) {
      return { ok: false, errores: ["El cliente todavía no ha contestado el resumen final. Mándaselo, pregunta si es correcto y si es todo, y espera su respuesta."] };
    }
    if (input.pago === "efectivo" && input.paga_con && Number(input.paga_con) < total) {
      return { ok: false, errores: [`Paga con ${dinero(input.paga_con)} pero el total es ${dinero(total)}`] };
    }
    const fila = {
      telefono: ctx.tel, nombre: input.nombre || ctx.nombre, estado: "nuevo", entrega: input.entrega,
      direccion: input.entrega === "domicilio" ? (cot?.direccion || input.direccion || null) : null,
      referencias: input.referencias ?? null, lat: cot?.lat ?? null, lng: cot?.lng ?? null, km: cot?.km ?? null,
      pago: input.pago, paga_con: input.paga_con ?? null, items: v.lineas, subtotal: v.subtotal, envio, total,
      descuento: pr.descuento, promos: pr.aplicadas.length ? pr.aplicadas : null,
      notas: input.notas ?? null, simulado: ctx.simulado || D360_BASE.includes("sandbox"), // con el número de prueba nada se cobra
    };
    const { data, error } = await sb.from("wa_pedidos").insert(fila).select("id").single();
    if (error) return { ok: false, errores: ["No se pudo guardar: " + error.message] };
    ctx.contexto.revision = null; ctx.contexto.ultimo_pedido = data.id;
    await sb.from("wa_chats").update({ nombre: fila.nombre, contexto: ctx.contexto }).eq("telefono", ctx.tel);
    return { ok: true, folio: data.id, total, envio, subtotal: v.subtotal, lineas: resumen };
  }
  if (nombre === "avisar_equipo") {
    await crearAviso(ctx.tel, ctx.nombre, { quien: input.quien === "repartidor" ? "repartidor" : "cliente", tema: input.tema, pedido: input.pedido, plataforma: input.plataforma }, ctx.contexto);
    return { ok: true, nota: input.quien === "repartidor"
      ? "Listo, el equipo ya tiene la alerta. Contéstale al repartidor muy breve que ya le avisaste al equipo (y pide el número de pedido o nombre del cliente si no lo sabes)."
      : "Listo, el equipo ya tiene la alerta. Dile al cliente que en un momento lo atienden." };
  }
  if (nombre === "avisar_agotado") {
    await registrarAgotado(String(input.nombre ?? "").trim(), ctx.simulado);
    return { ok: true, nota: "Listo, el equipo ya tiene el aviso. Sigue atendiendo al cliente con otra opción." };
  }
  if (nombre === "pasar_a_humano") {
    await crearAviso(ctx.tel, ctx.nombre, { quien: "cliente", tema: "Pide atención de una persona: " + (input.motivo ?? "") }, ctx.contexto);
    return { ok: true, nota: "Dile al cliente que en un momento lo atiende alguien del equipo." };
  }
  return { ok: false, error: "herramienta desconocida" };
}

// ---------- avisos al equipo (repartidores y clientes con un tema que resolver) ----------
// La alerta vive en wa_chats.contexto.aviso; el POS la muestra, suena y el equipo le da «Enterado».
// El chat pasa al equipo 2 h para que el bot no se meta mientras lo resuelven.
async function crearAviso(tel: string, nombre: string, a: { quien: string; tema: string; pedido?: number | null; plataforma?: string }, contexto?: any) {
  let ctxChat = contexto;
  let nomChat: string | null = null;
  if (!ctxChat) {
    const { data: chat } = await sb.from("wa_chats").select("contexto,nombre").eq("telefono", tel).maybeSingle();
    ctxChat = { ...(chat?.contexto ?? {}) };
    nomChat = chat?.nombre ?? null;
  }
  let pedido: any = null;
  if (a.pedido) {
    const { data: p } = await sb.from("wa_pedidos").select("id,nombre,telefono,direccion,entrega,estado").eq("id", Number(a.pedido)).maybeSingle();
    pedido = p ? { id: p.id, cliente: p.nombre, tel: p.telefono, direccion: p.direccion, entrega: p.entrega, estado: p.estado } : { id: Number(a.pedido) };
  }
  const previo = ctxChat.aviso;
  const reciente = previo?.estado === "pendiente" && Date.now() - new Date(previo.creado).getTime() < 10 * 60 * 1000;
  const tema = unaLinea(a.tema, 240);
  ctxChat.aviso = {
    estado: "pendiente", quien: a.quien, plataforma: a.plataforma ?? previo?.plataforma ?? null,
    tema: reciente && previo.tema && !previo.tema.includes(tema) ? unaLinea(previo.tema + " / " + tema, 400) : tema,
    pedido: pedido ?? (reciente ? previo.pedido : null), creado: reciente ? previo.creado : new Date().toISOString(),
  };
  const base = nombre || nomChat || "";
  const fila: Record<string, unknown> = { telefono: tel, contexto: ctxChat, modo: "equipo", pausado_hasta: new Date(Date.now() + 2 * 3600 * 1000).toISOString(), ultimo_mensaje: new Date().toISOString() };
  if (a.quien === "repartidor" && !/repartidor/i.test(base)) fila.nombre = (base ? base + " " : "") + "(repartidor)";
  await sb.from("wa_chats").upsert(fila);
  await sb.from("wa_mensajes").insert({ telefono: tel, rol: "sistema", texto: `⚠️ Aviso al equipo (${a.quien}): ${tema}` });
  return { nuevo: !reciente };
}

// Lista de lo que los clientes pidieron y estaba agotado/apagado (config_orp.bot_agotados). El POS la muestra hasta «Enterado».
async function registrarAgotado(nombre: string, simulado: boolean) {
  if (!nombre) return;
  const { data } = await sb.from("config_orp").select("texto").eq("clave", "bot_agotados").maybeSingle();
  let lista: { nombre: string; veces: number; primero: string; ultimo: string }[] = [];
  try { lista = JSON.parse(data?.texto || "[]"); } catch (_) { lista = []; }
  const ahora = new Date().toISOString();
  const ya = lista.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase());
  if (ya) { ya.veces++; ya.ultimo = ahora; } else lista.push({ nombre, veces: 1, primero: ahora, ultimo: ahora });
  await sb.from("config_orp").upsert({ clave: "bot_agotados", texto: JSON.stringify(lista), actualizado: ahora }, { onConflict: "clave" });
}

// ---------- traducir lo que manda WhatsApp ----------
function leerMensaje(m: any): { texto: string; lat?: number; lng?: number } {
  switch (m.type) {
    case "text": return { texto: m.text?.body ?? "" };
    case "location": return { texto: `[Mandó su ubicación 📍${m.location?.name ? " " + m.location.name : ""}${m.location?.address ? ", " + m.location.address : ""}]`, lat: m.location?.latitude, lng: m.location?.longitude };
    case "image": return { texto: `[Mandó una imagen${m.image?.caption ? ": " + m.image.caption : ""} — si pagó con transferencia, es su comprobante]` };
    case "audio": return { texto: "[Mandó un audio. Todavía no puedo escuchar audios: pídele con amabilidad que lo escriba]" };
    case "interactive": return { texto: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[respuesta]" };
    case "button": return { texto: m.button?.text ?? "[botón]" };
    default: return { texto: `[Mandó un mensaje tipo ${m.type}]` };
  }
}

async function procesarWebhook(body: any) {
  const trabajos: Promise<unknown>[] = [];
  const fallidos: string[] = [];
  const values: any[] = [];
  for (const e of body.entry ?? []) for (const ch of e.changes ?? []) values.push({ field: ch.field, v: ch.value });
  if (body.messages || body.contacts) values.push({ field: "messages", v: body }); // formato viejo
  for (const { field, v } of values) {
    // Lo que escribe el equipo desde la app del celular (coexistencia): el bot se calla 30 min en ese chat
    for (const m of v?.message_echoes ?? []) {
      const tel = m.to;
      trabajos.push((async () => {
        await sb.from("wa_mensajes").insert({ telefono: tel, rol: "equipo", texto: m.text?.body ?? `[${m.type}]`, wa_id: m.id }).then(() => {});
        await sb.from("wa_chats").upsert({ telefono: tel, modo: "equipo", pausado_hasta: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
      })());
    }
    if (field && field !== "messages" && !v?.messages) continue;
    const nombres: Record<string, string> = {};
    for (const c of v?.contacts ?? []) nombres[c.wa_id] = c.profile?.name ?? "";
    for (const m of v?.messages ?? []) {
      const l = leerMensaje(m);
      const payload = m.button?.payload ?? m.interactive?.button_reply?.id ?? null;
      trabajos.push((async () => {
        // ¿Es un repartidor contestando una oferta? Entonces no va al bot de pedidos
        if (await mensajeRepartidor(m.from, l.texto, payload, m.id ?? null).catch((e) => { console.error("reparto", e); return false; })) return;
        if (m.type === "image") await marcarComprobante(m.from);
        await atender(m.from, nombres[m.from] ?? "", l.texto, { lat: l.lat, lng: l.lng, wa_id: m.id });
      })().catch((e) => console.error("atender", e)));
    }
    for (const st of v?.statuses ?? []) if (st.status === "failed" && st.id) fallidos.push(st.id);
  }
  await Promise.all(trabajos);
  await revisarReparto(fallidos).catch((e) => console.error("revisarReparto", e));
}

async function marcarComprobante(tel: string) {
  const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const { data } = await sb.from("wa_pedidos").select("id,notas").eq("telefono", tel).eq("pago", "transferencia").gte("creado", desde)
    .order("id", { ascending: false }).limit(1);
  if (data?.[0]) await sb.from("wa_pedidos").update({ notas: [data[0].notas, "📎 Mandó comprobante por WhatsApp"].filter(Boolean).join(" · ") }).eq("id", data[0].id);
}

// ---------- reparto a domicilio ----------
// Al aceptar un pedido a domicilio se le ofrece al primer repartidor (plantilla con botones Sí / No).
// Si dice que no, si no contesta en bot_reparto_minutos o si no le llega el mensaje, pasa al siguiente.
// Cuando alguien acepta: se le mandan los datos completos y el POS avisa con su nombre. Si nadie acepta: alerta en el POS.
const PLANTILLA_REPARTO = "reparto_pedido";
const PLANTILLA_IDIOMA = "es_MX";
type Rep = { id: number; nombre: string; telefono: string; activo: boolean; orden: number };
type Intento = { rep: number; nombre: string; enviado: string; estado: string; msg?: string | null; via?: string };
const diez = (x: string) => String(x ?? "").replace(/\D/g, "").slice(-10);
const telWa = (t: string) => { const d = diez(t); return d.length === 10 ? "521" + d : String(t).replace(/\D/g, ""); };
const telBonito = (t: string) => { const d = diez(t); return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : t; };
const unaLinea = (s: string, max = 120) => String(s ?? "").replace(/[\n\t\r]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max) || "—";

async function enviarD360(payload: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!D360_KEY) return { ok: false, error: "sin llave de 360dialog" };
  const url = D360_BASE.includes("sandbox") ? `${D360_BASE}/v1/messages` : `${D360_BASE}/messages`;
  const r = await fetch(url, {
    method: "POST", headers: { "D360-API-KEY": D360_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  const t = await r.text();
  let j: any = {}; try { j = JSON.parse(t); } catch (_) { /* */ }
  if (!r.ok) { console.error("360dialog", r.status, t); return { ok: false, error: t.slice(0, 300) }; }
  return { ok: true, id: j.messages?.[0]?.id };
}
async function textoRepartidor(rep: Rep, texto: string) {
  const to = telWa(rep.telefono);
  await sb.from("wa_mensajes").insert({ telefono: to, rol: "bot", texto });
  return enviarD360({ to, type: "text", text: { preview_url: false, body: texto } });
}

async function repartidores(soloActivos = true): Promise<Rep[]> {
  let q = sb.from("repartidores").select("*").order("orden").order("id");
  if (soloActivos) q = q.eq("activo", true);
  const { data } = await q;
  return (data ?? []) as Rep[];
}

// El pedido completo (lo original + lo que se agregó y ya se aceptó)
async function pedidoCompleto(p: any) {
  const { data: hs } = await sb.from("wa_pedidos").select("items,total").eq("pedido_padre", p.id).in("estado", ["aceptando", "aceptado", "listo"]);
  const items = [...(p.items ?? []), ...(hs ?? []).flatMap((h: any) => h.items ?? [])];
  const total = Number(p.total ?? 0) + (hs ?? []).reduce((s: number, h: any) => s + Number(h.total ?? 0), 0);
  return { items, total };
}
function cobroCorto(p: any, total: number) {
  if (p.pago === "transferencia") return p.pagado ? "ya pagado por transferencia (no cobrar)" : "transferencia (confirma en cocina antes de salir)";
  return `${dinero(total)} en efectivo` + (p.paga_con ? ` (paga con ${dinero(Number(p.paga_con))})` : "");
}
async function detallesParaRepartidor(p: any, rep: Rep) {
  const { items, total } = await pedidoCompleto(p);
  const mapa = p.lat != null && p.lng != null ? `https://www.google.com/maps?q=${p.lat},${p.lng}`
    : (p.direccion ? `https://www.google.com/maps/search/${encodeURIComponent(p.direccion)}` : "");
  let cobro: string;
  if (p.pago === "transferencia") cobro = p.pagado ? "🏦 Ya pagó por transferencia: *no cobrar*" : "🏦 Paga por transferencia: confirma en cocina si ya está pagado antes de salir";
  else cobro = `💵 Cobrar *${dinero(total)}* en efectivo` + (p.paga_con ? ` · paga con ${dinero(Number(p.paga_con))} → cambio ${dinero(Number(p.paga_con) - total)}` : "");
  return [
    `✅ ${rep.nombre.split(/\s+/)[0]}, el pedido #${p.id} es tuyo. Pasa a la cocina por él 🙌`,
    "",
    `👤 ${p.nombre || "Cliente"} · ${telBonito(p.telefono)}`,
    `📍 ${p.direccion || "Sin dirección"}`,
    p.referencias ? `🏠 ${p.referencias}` : "",
    mapa ? `🗺️ ${mapa}` : "",
    "",
    "📦 Lleva:",
    ...items.map((l: any) => `• ${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""}`),
    "",
    cobro,
  ].filter((x, i, a) => x !== "" || (a[i - 1] ?? "") !== "").join("\n");
}

async function ofrecer(p: any, rep: Rep): Promise<{ ok: boolean; id?: string; via?: string; error?: string }> {
  const { total } = await pedidoCompleto(p);
  const to = telWa(rep.telefono);
  // sin nombre del repartidor: el aviso es igual para todos (así lo pidió Alfredo)
  const params = [String(p.id), unaLinea(p.direccion || "sin dirección", 100), unaLinea(cobroCorto(p, total), 100)];
  const r = await enviarD360({
    to, type: "template",
    template: {
      name: PLANTILLA_REPARTO, language: { code: PLANTILLA_IDIOMA },
      components: [
        { type: "body", parameters: params.map((t) => ({ type: "text", text: t })) },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `rep:si:${p.id}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `rep:no:${p.id}` }] },
      ],
    },
  });
  const texto = `🛵 Hay un pedido a domicilio disponible.\n\nPedido: #${params[0]}\nEntrega en: ${params[1]}\nCobro: ${params[2]}\n\n¿Puedes llevarlo?`;
  if (r.ok) { await sb.from("wa_mensajes").insert({ telefono: to, rol: "bot", texto }); return { ...r, via: "plantilla" }; }
  // Sin plantilla aprobada: botones normales (solo llegan si el repartidor escribió en las últimas 24 h)
  const r2 = await enviarD360({
    to, type: "interactive",
    interactive: {
      type: "button", body: { text: texto },
      action: { buttons: [{ type: "reply", reply: { id: `rep:si:${p.id}`, title: "Sí, lo llevo" } }, { type: "reply", reply: { id: `rep:no:${p.id}`, title: "No puedo" } }] },
    },
  });
  if (r2.ok) { await sb.from("wa_mensajes").insert({ telefono: to, rol: "bot", texto }); return { ...r2, via: "botones" }; }
  return { ok: false, error: r.error };
}

// Ofrece el pedido al siguiente repartidor que no lo haya visto. Si ya no hay: «sin_repartidor» y alerta en el POS.
async function ofrecerSiguiente(pedidoId: number): Promise<void> {
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const { data: p } = await sb.from("wa_pedidos").select("*").eq("id", pedidoId).maybeSingle();
    if (!p || p.reparto_estado !== "buscando" || p.reparto_actual) return;
    const intentos: Intento[] = p.reparto_intentos ?? [];
    const siguiente = (await repartidores()).find((r) => !intentos.some((i) => i.rep === r.id));
    if (!siguiente) {
      await sb.from("wa_pedidos").update({ reparto_estado: "sin_repartidor", reparto_actual: null, reparto_avisado: false }).eq("id", pedidoId).eq("reparto_estado", "buscando");
      return;
    }
    // apartar el turno (si otro proceso ya lo apartó, no hace nada)
    const nuevo: Intento = { rep: siguiente.id, nombre: siguiente.nombre, enviado: new Date().toISOString(), estado: "esperando" };
    const { data: ap } = await sb.from("wa_pedidos").update({ reparto_actual: siguiente.id, reparto_desde: nuevo.enviado, reparto_intentos: [...intentos, nuevo] })
      .eq("id", pedidoId).eq("reparto_estado", "buscando").is("reparto_actual", null).select("id");
    if (!ap?.length) return;
    const r = await ofrecer(p, siguiente);
    if (r.ok) {
      nuevo.msg = r.id ?? null; nuevo.via = r.via;
      await sb.from("wa_pedidos").update({ reparto_intentos: [...intentos, nuevo] }).eq("id", pedidoId).eq("reparto_actual", siguiente.id);
      return;
    }
    nuevo.estado = "no le llegó";
    await sb.from("wa_pedidos").update({ reparto_actual: null, reparto_intentos: [...intentos, nuevo] }).eq("id", pedidoId).eq("reparto_actual", siguiente.id);
  }
}

async function iniciarReparto(pedidoId: number, reiniciar = false) {
  const { data: p } = await sb.from("wa_pedidos").select("*").eq("id", pedidoId).maybeSingle();
  if (!p) return { ok: false, error: "No existe ese pedido" };
  if (p.entrega !== "domicilio") return { ok: true, omitido: "no es a domicilio" };
  if (p.pedido_padre) { // lo agregado: si el pedido original ya tiene repartidor, se le avisa
    const { data: padre } = await sb.from("wa_pedidos").select("*").eq("id", p.pedido_padre).maybeSingle();
    if (padre?.reparto_estado === "asignado" && padre.repartidor_id) {
      const rep = (await repartidores(false)).find((r) => r.id === padre.repartidor_id);
      if (rep) {
        const { total } = await pedidoCompleto(padre);
        const lo = (p.items ?? []).map((l: any) => `• ${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""}`).join("\n");
        await textoRepartidor(rep, `➕ Se agregó al pedido #${padre.id}:\n${lo}\n\nNuevo total: ${cobroCorto(padre, total)}`);
      }
    }
    return { ok: true, omitido: "agregado a otro pedido" };
  }
  if (p.reparto_estado && !reiniciar) return { ok: true, ya: p.reparto_estado };
  if (p.reparto_estado === "asignado" && reiniciar) return { ok: false, error: "Ya tiene repartidor" };
  const reps = await repartidores();
  if (!reps.length) {
    await sb.from("wa_pedidos").update({ reparto_estado: "sin_repartidor", reparto_actual: null, reparto_intentos: [], reparto_avisado: false }).eq("id", pedidoId);
    return { ok: true, sin_repartidores: true };
  }
  await sb.from("wa_pedidos").update({ reparto_estado: "buscando", reparto_actual: null, reparto_desde: null, reparto_intentos: [], repartidor_id: null, repartidor_nombre: null, reparto_avisado: true }).eq("id", pedidoId);
  await ofrecerSiguiente(pedidoId);
  return { ok: true };
}

function marcarIntento(intentos: Intento[], repId: number, estado: string): Intento[] {
  const xs = [...(intentos ?? [])];
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i].rep === repId && xs[i].estado === "esperando") { xs[i] = { ...xs[i], estado }; break; }
  return xs;
}

// Tiempo agotado, pedidos cancelados o mensajes que no llegaron. Corre con cada aviso de 360dialog y cada vez que el POS revisa.
async function revisarReparto(fallidos: string[] = []) {
  const { data } = await sb.from("wa_pedidos").select("id,estado,reparto_actual,reparto_desde,reparto_intentos").eq("reparto_estado", "buscando").limit(50);
  if (!data?.length) return;
  const min = Number((await config()).bot_reparto_minutos?.valor) || 4;
  for (const p of data) {
    if (!["aceptando", "aceptado", "listo"].includes(p.estado)) {
      await sb.from("wa_pedidos").update({ reparto_estado: "cancelado", reparto_actual: null }).eq("id", p.id).eq("reparto_estado", "buscando");
      continue;
    }
    if (!p.reparto_actual) { await ofrecerSiguiente(p.id); continue; }
    const actual = (p.reparto_intentos ?? []).slice().reverse().find((i: Intento) => i.rep === p.reparto_actual && i.estado === "esperando");
    const noLlego = actual?.msg && fallidos.includes(actual.msg);
    const vencido = p.reparto_desde && Date.now() - new Date(p.reparto_desde).getTime() > min * 60 * 1000;
    if (!noLlego && !vencido) continue;
    const { data: ok } = await sb.from("wa_pedidos").update({ reparto_actual: null, reparto_intentos: marcarIntento(p.reparto_intentos, p.reparto_actual, noLlego ? "no le llegó" : "no contestó") })
      .eq("id", p.id).eq("reparto_estado", "buscando").eq("reparto_actual", p.reparto_actual).select("id");
    if (ok?.length) await ofrecerSiguiente(p.id);
  }
}

// Respuesta de un repartidor. Regresa true si el mensaje era para el reparto (y no para el bot de pedidos).
async function mensajeRepartidor(tel: string, texto: string, payload: string | null, waId: string | null): Promise<boolean> {
  const rep = (await repartidores(false)).find((r) => diez(r.telefono) === diez(tel));
  if (!rep) return false;
  let acepta: boolean | null = null, pedidoId: number | null = null;
  const m = /^rep:(si|no):(\d+)$/.exec(payload ?? "");
  if (m) { acepta = m[1] === "si"; pedidoId = Number(m[2]); }
  else {
    const t = texto.trim().toLowerCase();
    const fin = "(?=[\\s,.!👍]|$)";
    if (new RegExp("^(s[ií]|sip|va|voy|acepto|yo lo llevo|ok|dale)" + fin, "u").test(t)) acepta = true;
    else if (new RegExp("^(no|paso|ahorita no)" + fin, "u").test(t)) acepta = false;
  }
  const { data: ofertas } = await sb.from("wa_pedidos").select("*").eq("reparto_estado", "buscando").eq("reparto_actual", rep.id).order("id");
  const c = await config();
  const probadores = listaTels(c.bot_probadores?.texto);
  // Texto libre sin oferta pendiente: si también es número de prueba, lo atiende el bot de pedidos
  if (!m && (acepta === null || !ofertas?.length)) {
    if (probadores.includes(diez(tel))) return false;
    const ins0 = await sb.from("wa_mensajes").insert({ telefono: tel, rol: "cliente", texto, wa_id: waId });
    if (ins0.error) return true; // repetido
    await sb.from("wa_chats").upsert({ telefono: tel, nombre: `${rep.nombre} (repartidor)`, ultimo_mensaje: new Date().toISOString(), modo: "equipo" });
    // «ok», «gracias», «👍»: no hace falta molestar al equipo
    const t = texto.trim().toLowerCase();
    if (!t || /^(ok|oki|okey|va|sale|listo|gracias|grax|enterado|perfecto|de acuerdo|👍|🙏|👌|✅)[\s!.,👍🙏]*$/u.test(t)) return true;
    // su pedido en curso, para que el equipo sepa de qué cliente habla
    const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const { data: suyo } = await sb.from("wa_pedidos").select("id").eq("repartidor_id", rep.id).eq("reparto_estado", "asignado")
      .gte("creado", desde).order("id", { ascending: false }).limit(1);
    const tema = /^\[/.test(texto) ? texto : `${rep.nombre.split(/\s+/)[0]}: «${texto}»`;
    const r = await crearAviso(tel, `${rep.nombre} (repartidor)`, { quien: "repartidor", tema, pedido: suyo?.[0]?.id ?? null, plataforma: "propio" });
    if (r.nuevo) await textoRepartidor(rep, "Enterado 👍 ya le avisé al equipo para que lo resuelva.");
    return true;
  }
  const ins = await sb.from("wa_mensajes").insert({ telefono: tel, rol: "cliente", texto, wa_id: waId });
  if (ins.error) return true; // repetido
  await sb.from("wa_chats").upsert({ telefono: tel, nombre: `${rep.nombre} (repartidor)`, ultimo_mensaje: new Date().toISOString(), modo: "equipo" });
  const p = (ofertas ?? []).find((o: any) => !pedidoId || o.id === pedidoId);
  if (!p) {
    const { data: q } = await sb.from("wa_pedidos").select("id,repartidor_id").eq("id", pedidoId ?? 0).maybeSingle();
    await textoRepartidor(rep, q?.repartidor_id === rep.id ? `Ese pedido (#${q.id}) ya es tuyo 👍` : `Gracias ${rep.nombre.split(/\s+/)[0]} 🙏 ese pedido ya lo tomó otro compañero.`);
    return true;
  }
  if (acepta) {
    const { data: ok } = await sb.from("wa_pedidos").update({
      reparto_estado: "asignado", repartidor_id: rep.id, repartidor_nombre: rep.nombre, reparto_actual: null,
      reparto_intentos: marcarIntento(p.reparto_intentos, rep.id, "aceptó"), reparto_avisado: false,
    }).eq("id", p.id).eq("reparto_estado", "buscando").eq("reparto_actual", rep.id).select("id");
    if (!ok?.length) { await textoRepartidor(rep, `Gracias 🙏 ese pedido ya lo tomó otro compañero.`); return true; }
    await textoRepartidor(rep, await detallesParaRepartidor(p, rep));
  } else {
    const { data: ok } = await sb.from("wa_pedidos").update({ reparto_actual: null, reparto_intentos: marcarIntento(p.reparto_intentos, rep.id, "no puede") })
      .eq("id", p.id).eq("reparto_estado", "buscando").eq("reparto_actual", rep.id).select("id");
    await textoRepartidor(rep, `Sin problema 👍 se lo pasamos a otro compañero.`);
    if (ok?.length) await ofrecerSiguiente(p.id);
  }
  return true;
}

// Plantilla de Meta para ofrecer pedidos (se crea una vez; Meta la revisa y la aprueba)
async function plantillaReparto(crear: boolean) {
  const h = { "D360-API-KEY": D360_KEY, "Content-Type": "application/json" };
  if (crear) {
    const r = await fetch(`${D360_BASE}/message_templates`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        name: PLANTILLA_REPARTO, language: PLANTILLA_IDIOMA, category: "UTILITY",
        components: [
          { type: "BODY", text: "Hay un pedido a domicilio disponible.\n\nPedido: #{{1}}\nEntrega en: {{2}}\nCobro: {{3}}\n\n¿Puedes llevarlo? Contesta con uno de los botones.",
            example: { body_text: [["125", "Col. República, Saltillo", "$128 en efectivo"]] } },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Sí, lo llevo" }, { type: "QUICK_REPLY", text: "No puedo" }] },
        ],
      }),
    });
    return { status: r.status, respuesta: (await r.text()).slice(0, 1500) };
  }
  const r = await fetch(`${D360_BASE}/message_templates?limit=200`, { headers: h });
  const t = await r.text();
  let j: any = {}; try { j = JSON.parse(t); } catch (_) { /* */ }
  const lista = j.waba_templates ?? j.data ?? j.templates ?? [];
  const mia = (Array.isArray(lista) ? lista : []).filter((x: any) => x.name === PLANTILLA_REPARTO)
    .map((x: any) => ({ nombre: x.name, idioma: x.language, estado: x.status, motivo: x.rejected_reason ?? null, categoria: x.category }));
  return { status: r.status, plantilla: mia, total: Array.isArray(lista) ? lista.length : null, crudo: mia.length ? undefined : t.slice(0, 500) };
}

// ---------- servidor ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("configurar") === "1") { // apunta el aviso de 360dialog a esta función
      const self = `${SB_URL}/functions/v1/wa-bot` + (WEBHOOK_TOKEN ? `?t=${encodeURIComponent(WEBHOOK_TOKEN)}` : "");
      const r = await fetch(`${D360_BASE}/v1/configs/webhook`, {
        method: "POST", headers: { "D360-API-KEY": D360_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ url: self, headers: WEBHOOK_TOKEN ? { "x-orp-token": WEBHOOK_TOKEN } : undefined }),
      });
      return json({ status: r.status, respuesta: await r.text() });
    }
    return json({ ok: true, bot: "ORP WhatsApp", claves: { anthropic: !!ANTHROPIC_KEY, d360: !!D360_KEY, maps: !!GMAPS_KEY, token: !!WEBHOOK_TOKEN }, base: D360_BASE });
  }
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json({ ok: false }, 400); }

  // Avisos al cliente desde el POS (solo 3 textos fijos y una vez por pedido: no sirve para mandar otra cosa)
  if (body.accion === "aviso") {
    const { data: p } = await sb.from("wa_pedidos").select("id,telefono,nombre,entrega,items,total,pedido_padre").eq("id", Number(body.pedido_id)).maybeSingle();
    if (!p) return json({ ok: false, error: "No existe ese pedido" }, 404);
    const c = await config();
    const t = (k: string) => (c[k]?.texto ?? "").trim();
    const quien = String(p.nombre ?? "").trim().split(/\s+/)[0];
    const textos: Record<string, string> = {
      aceptado: `✅ ${quien ? quien + ", tu" : "Tu"} pedido #${p.id} ya está en preparación.` +
        (p.entrega === "domicilio"
          ? (t("bot_tiempo_domicilio") ? ` Llega en aprox. ${t("bot_tiempo_domicilio")}.` : " Te avisamos cuando salga.")
          : (t("bot_tiempo_pickup") ? ` Estará listo en aprox. ${t("bot_tiempo_pickup")}.` : " Te avisamos cuando esté listo.")),
      listo: p.entrega === "domicilio" ? `🛵 Tu pedido #${p.id} ya va en camino.` : `🥡 Tu pedido #${p.id} ya está listo para recoger.`,
      rechazado: `Una disculpa 🙏 por ahora no podemos tomar tu pedido #${p.id}. En un momento te escribe alguien del equipo.`,
    };
    if (p.pedido_padre) { // ampliación: se avisa sobre el pedido original
      if (body.tipo === "listo") return json({ ok: true, omitido: true });
      const { data: padre } = await sb.from("wa_pedidos").select("total,items").eq("id", p.pedido_padre).maybeSingle();
      const { data: hs } = await sb.from("wa_pedidos").select("id,total,items").eq("pedido_padre", p.pedido_padre).in("estado", ["aceptando", "aceptado", "listo"]).order("id");
      const tot = Number(padre?.total ?? 0) + (hs ?? []).reduce((s: number, h: any) => s + Number(h.total), 0);
      const lo = (p.items ?? []).map((l: any) => `${l.cantidad}x ${l.nombre}`).join(", ");
      const todo = [...(padre?.items ?? []), ...(hs ?? []).flatMap((h: any) => h.items ?? [])]
        .map((l: any) => `• ${l.cantidad}x ${l.nombre}${l.detalle ? " (" + l.detalle + ")" : ""}`).join("\n");
      textos.aceptado = `✅ ${quien ? quien + ", ya" : "Ya"} agregamos a tu pedido #${p.pedido_padre}: ${lo}.\n\nTu pedido completo:\n${todo}\n\nNuevo total: *${dinero(tot)}*`;
      textos.rechazado = `Una disculpa 🙏 no pudimos agregar ${lo} a tu pedido #${p.pedido_padre}. En un momento te escribe alguien del equipo.`;
    }
    const texto = textos[String(body.tipo)];
    if (!texto) return json({ ok: false, error: "Aviso desconocido" }, 400);
    const ins = await sb.from("wa_mensajes").insert({ telefono: p.telefono, rol: "bot", texto, wa_id: `aviso:${p.id}:${body.tipo}` });
    if (ins.error) return json({ ok: true, repetido: true });
    if (body.tipo === "rechazado") {
      await sb.from("wa_chats").update({ modo: "equipo", pausado_hasta: new Date(Date.now() + 2 * 3600 * 1000).toISOString() }).eq("telefono", p.telefono);
    }
    await enviarWhatsApp(p.telefono, texto);
    return json({ ok: true, texto });
  }

  // Reparto a domicilio (desde el POS)
  if (body.accion === "reparto_iniciar") return json(await iniciarReparto(Number(body.pedido_id), !!body.reiniciar));
  if (body.accion === "reparto_revisar") { await revisarReparto(); return json({ ok: true }); }
  if (body.accion === "reparto_manual") {
    const rep = (await repartidores(false)).find((r) => r.id === Number(body.repartidor_id));
    if (!rep) return json({ ok: false, error: "No existe ese repartidor" }, 404);
    const { data: p } = await sb.from("wa_pedidos").select("*").eq("id", Number(body.pedido_id)).maybeSingle();
    if (!p) return json({ ok: false, error: "No existe ese pedido" }, 404);
    await sb.from("wa_pedidos").update({ reparto_estado: "asignado", repartidor_id: rep.id, repartidor_nombre: rep.nombre, reparto_actual: null, reparto_avisado: true,
      reparto_intentos: [...(p.reparto_intentos ?? []), { rep: rep.id, nombre: rep.nombre, enviado: new Date().toISOString(), estado: "asignado a mano" }] }).eq("id", p.id);
    const r = await textoRepartidor(rep, await detallesParaRepartidor(p, rep));
    return json({ ok: true, mensaje: r.ok });
  }
  if (body.accion === "reparto_plantilla") return json(await plantillaReparto(!!body.crear));
  if (body.accion === "buscar_lugar") return json(await cotizarEnvio(String(body.texto ?? "").slice(0, 200)));

  // Simulador del POS: nunca manda WhatsApp, siempre con el teléfono SIMULADOR
  if (body.simulador) {
    if (body.reiniciar) {
      await sb.from("wa_mensajes").delete().eq("telefono", SIM);
      await sb.from("wa_chats").delete().eq("telefono", SIM);
      return json({ ok: true });
    }
    const hoy = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await sb.from("wa_mensajes").select("id", { count: "exact", head: true }).eq("telefono", SIM).gte("creado", hoy);
    if ((count ?? 0) > 300) return json({ ok: false, error: "El simulador llegó al límite de hoy" }, 429);
    try {
      const r = await atender(SIM, body.nombre ?? "Prueba", String(body.texto ?? "").slice(0, 1000),
        { simulado: true, lat: body.lat, lng: body.lng });
      return json(r);
    } catch (e) { return json({ ok: false, error: String(e) }, 500); }
  }

  // Avisos de 360dialog
  // (va en el encabezado x-orp-token o en la dirección ?t=, según lo que soporte 360dialog)
  if (WEBHOOK_TOKEN && req.headers.get("x-orp-token") !== WEBHOOK_TOKEN && url.searchParams.get("t") !== WEBHOOK_TOKEN) {
    console.error("aviso sin token válido"); return json({ ok: false }, 401);
  }
  // @ts-ignore EdgeRuntime existe en Supabase: contesta rápido (360dialog pide respuesta en menos de 5 s)
  EdgeRuntime.waitUntil(procesarWebhook(body).catch((e) => console.error("webhook", e)));
  return json({ ok: true });
});
