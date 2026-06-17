// Escapa texto antes de insertarlo como HTML (proteccion anti-XSS)
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// Envio de email via Firebase Function
async function enviarEmailMS(to, subject, body) {
  if (!to) return;
  try {
    const enviarEmail = firebase.functions().httpsCallable("enviarEmail");
    await enviarEmail({ to, subject, body });
    console.log("Email OK a " + to);
  } catch(e) {
    console.error("Error email:", e);
  }
}

// ─── CONSTANTES ──────────────────────────────────────────────────────
const MUELLES_SECO     = ["M6", "M7", "M8"];
const MUELLES_FRIO     = ["M20", "M18", "M19"];
const MUELLES_LAVADERO = ["M9", "M10"];

const FRANJAS_SECO = [
  "21:30 - 22:00",
  "06:00 - 06:30", "06:30 - 07:00", "07:00 - 07:30", "07:30 - 08:00",
  "08:00 - 08:30", "08:30 - 09:00", "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00", "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00", "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00"
];

const FRANJAS_FRIO = [
  "06:00 - 06:30", "06:30 - 07:00", "07:00 - 07:30", "07:30 - 08:00",
  "08:00 - 08:30", "08:30 - 09:00", "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00", "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00", "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00", "15:00 - 15:30", "15:30 - 16:00",
  "16:00 - 16:30", "16:30 - 17:00", "17:00 - 17:30", "17:30 - 18:00",
  "18:00 - 18:30", "18:30 - 19:00", "19:00 - 19:30", "19:30 - 20:00",
  "20:00 - 20:30", "20:30 - 21:00", "21:00 - 21:30", "21:30 - 22:00"
];

const FRANJAS_LAVADERO = [
  "08:30 - 09:00",
  "09:00 - 09:30", "09:30 - 10:00", "10:00 - 10:30", "10:30 - 11:00",
  "11:00 - 11:30", "11:30 - 12:00", "12:00 - 12:30", "12:30 - 13:00",
  "13:00 - 13:30", "13:30 - 14:00", "14:00 - 14:30", "14:30 - 15:00",
  "15:00 - 15:30", "15:30 - 16:00", "16:00 - 16:30", "16:30 - 17:00"
];

const ESTADO_COLOR = {
  confirmada: "#1D9E75", en_curso: "#D41F3A", pendiente: "#F59E0B",
  rechazada: "#9CA3AF", reasignada: "#185FA5", completada: "#6B7280"
};

const SEC_LABEL = { seco: "Almacen Seco", frio: "Almacen Frio", lavadero: "Lavadero" };

let reservaActual = null;
let autoRefreshInterval = null;
let informeData = [];

// Resaltado de la franja "en curso" (solo si el dia mostrado es hoy)
let esHoy = false;
let ahoraMin = 0;
function franjaEsAhora(franja) {
  if (!esHoy) return false;
  const partes = franja.split(" - ");
  const toMin = t => { const p = t.trim().split(":"); return (+p[0]) * 60 + (+p[1]); };
  const ini = toMin(partes[0]);
  const fin = partes[1] ? toMin(partes[1]) : ini + 30;
  return ahoraMin >= ini && ahoraMin < fin;
}

// Duracion real de la descarga (en minutos) a partir de inicio/fin
function duracionMin(r) {
  if (!r.inicio_descarga || !r.fin_descarga) return null;
  const ini = r.inicio_descarga.toDate ? r.inicio_descarga.toDate() : new Date(r.inicio_descarga);
  const fin = r.fin_descarga.toDate    ? r.fin_descarga.toDate()    : new Date(r.fin_descarga);
  const min = Math.round((fin - ini) / 60000);
  return min >= 0 ? min : null;
}

// Formato: "47 min" si <1h; "1 h 05 min" a partir de 1h
function formatDuracion(min) {
  if (min == null || isNaN(min)) return "—";
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? h + " h" : h + " h " + String(m).padStart(2, "0") + " min";
}

// Ritmo de una descarga: minutos por palet (necesita duracion y palets)
function ritmoPalet(r) {
  const d = duracionMin(r);
  if (d == null || !r.pales || r.pales <= 0) return null;
  return d / r.pales;
}

// Formato del ritmo: "8,3 min/palet"
function formatRitmo(v) {
  if (v == null || isNaN(v)) return "—";
  return (Math.round(v * 10) / 10).toString().replace(".", ",") + " min/palet";
}

document.addEventListener("click", function(e) {
  const slot = e.target.closest("[data-id]");
  if (slot) {
    e.stopPropagation();
    const id = slot.getAttribute("data-id");
    if (slot.classList.contains("btn-en-curso"))   cambiarEstado(id, "en_curso");
    else if (slot.classList.contains("btn-completar")) cambiarEstado(id, "completada");
    else abrirModal(id);
  }
});

auth.onAuthStateChanged(user => {
  if (user) {
    document.getElementById("login-screen").style.display     = "none";
    document.getElementById("dashboard-screen").style.display = "block";
    const hoy = new Date().toISOString().split("T")[0];
    document.getElementById("fecha-dashboard").value = hoy;
    document.getElementById("informe-desde").value   = hoy;
    document.getElementById("informe-hasta").value   = hoy;
    document.getElementById("lz-desde").value         = hoy;
    document.getElementById("lz-hasta").value         = hoy;
    cargarReservas();
    autoRefreshInterval = setInterval(() => {
      cargarReservas();
      if (document.getElementById("vista-lanzaderas").style.display !== "none") cargarLanzaderas();
      if (document.getElementById("vista-cargas").style.display !== "none")     cargarCargas();
    }, 60000);
  } else {
    document.getElementById("login-screen").style.display     = "flex";
    document.getElementById("dashboard-screen").style.display = "none";
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  }
});

function iniciarSesion() {
  const email = document.getElementById("login-email").value.trim();
  const pass  = document.getElementById("login-pass").value;
  const err   = document.getElementById("login-error");
  err.style.display = "none";
  auth.signInWithEmailAndPassword(email, pass)
    .catch(() => { err.textContent = "Email o contrasena incorrectos."; err.style.display = "block"; });
}

function cerrarSesion() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  auth.signOut();
}

function switchVista(vista) {
  ["rejilla", "lista", "informes", "lanzaderas", "cargas"].forEach(v => {
    document.getElementById("vista-" + v).style.display = vista === v ? "block" : "none";
    document.getElementById("btn-vista-" + v).classList.toggle("active", vista === v);
  });
  if (vista === "lanzaderas") cargarLanzaderas();
  if (vista === "cargas")     cargarCargas();
}

const MUELLES_CARGA = ["M1", "M2", "M3", "M4", "M5"];

const NAVES_PANEL = [
  { id: "plaza",    nombre: "Plaza" },
  { id: "caserfri", nombre: "Caserfri" },
  { id: "merca",    nombre: "Merca" },
  { id: "arento",   nombre: "Arento" },
  { id: "avitrans", nombre: "Avitrans" },
  { id: "txt",      nombre: "Txt" }
];
const ACCION_LABEL = { cargando: "Cargando", descargando: "Descargando", presente: "Presente" };
const ACCION_COLOR = { cargando: "#185FA5", descargando: "#1D9E75", presente: "#6B7280" };

const NAVE_NOMBRE = {};
NAVES_PANEL.forEach(n => { NAVE_NOMBRE[n.id] = n.nombre; });

async function cargarLanzaderas() {
  const snap = await db.collection("lanzaderas").where("activa", "==", true).get();
  const activas = [];
  snap.forEach(d => activas.push(d.data()));
  const enNave   = activas.filter(l => l.estado === "en_nave");
  const transito = activas.filter(l => l.estado === "transito").sort((a, b) => a.numero - b.numero);

  let html = NAVES_PANEL.map(nave => {
    const aqui = enNave.filter(l => l.nave === nave.id).sort((a, b) => a.numero - b.numero);
    const cuerpo = aqui.length === 0
      ? "<div class='nave-vacia'>Sin lanzaderas</div>"
      : aqui.map(l => {
          const color = ACCION_COLOR[l.accion] || "#6B7280";
          const extra = l.muelle ? " · " + esc(l.muelle) : "";
          return "<div class='lanz-item'>" +
            "<span class='lanz-num'>Lanzadera " + esc(l.numero) + "</span>" +
            "<span class='lanz-tag' style='background:" + color + "'>" + esc(ACCION_LABEL[l.accion] || l.accion) + extra + "</span>" +
            "<span class='lanz-desde'>" + horaDesde(l.desde) + "</span>" +
            "</div>";
        }).join("");
    return "<div class='nave-card'><div class='nave-titulo'>" + esc(nave.nombre) +
      " <span class='nave-count'>" + aqui.length + "</span></div>" + cuerpo + "</div>";
  }).join("");

  // Tarjeta de lanzaderas en transito
  const cuerpoT = transito.length === 0
    ? "<div class='nave-vacia'>Ninguna en transito</div>"
    : transito.map(l =>
        "<div class='lanz-item'>" +
        "<span class='lanz-num'>Lanzadera " + esc(l.numero) + "</span>" +
        "<span class='lanz-tag' style='background:#F59E0B'>En transito</span>" +
        "<span class='lanz-desde'>de " + esc(NAVE_NOMBRE[l.nave] || l.nave) + " · " + horaDesde(l.desde) + "</span>" +
        "</div>"
      ).join("");
  html += "<div class='nave-card nave-transito'><div class='nave-titulo'>🚚 En transito" +
    " <span class='nave-count'>" + transito.length + "</span></div>" + cuerpoT + "</div>";

  document.getElementById("naves-grid").innerHTML = html;
}

function horaDesde(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  const hhmm = d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  return hhmm + " (" + (min < 1 ? "ahora" : "hace " + min + " min") + ")";
}

// ─── VISTA CARGAS (Muelles 1-5 en Plaza) ─────────────────────────────
async function cargarCargas() {
  const snap = await db.collection("lanzaderas").where("activa", "==", true).get();
  const cargando = [];
  snap.forEach(d => { const l = d.data(); if (l.nave === "plaza" && l.accion === "cargando") cargando.push(l); });

  document.getElementById("cargas-grid").innerHTML = MUELLES_CARGA.map(m => {
    const l = cargando.find(x => x.muelle === m);
    const cuerpo = l
      ? "<div class='lanz-item'><span class='lanz-num'>Lanzadera " + esc(l.numero) + "</span>" +
        "<span class='lanz-tag' style='background:#185FA5'>Cargando</span>" +
        "<span class='lanz-desde'>" + horaDesde(l.desde) + "</span></div>"
      : "<div class='nave-vacia'>Libre</div>";
    return "<div class='nave-card'><div class='nave-titulo'>Muelle " + m.replace("M", "") + "</div>" + cuerpo + "</div>";
  }).join("");
}

// ─── INFORME DE LANZADERAS ───────────────────────────────────────────
function filaResumen(label, valor) {
  return "<div class='resumen-row'><span class='resumen-label'>" + esc(label) +
    "</span><span class='resumen-value'>" + esc(valor) + "</span></div>";
}

async function cargarInformeLanz() {
  const desde = document.getElementById("lz-desde").value;
  const hasta = document.getElementById("lz-hasta").value;
  if (!desde || !hasta) { alert("Selecciona un rango de fechas."); return; }

  const startTs = firebase.firestore.Timestamp.fromDate(new Date(desde + "T00:00:00"));
  const endTs   = firebase.firestore.Timestamp.fromDate(new Date(hasta + "T23:59:59"));
  const snap = await db.collection("lanzaderas_log")
    .where("desde", ">=", startTs).where("desde", "<=", endTs).get();
  const logs = [];
  snap.forEach(d => logs.push(d.data()));

  const cont = document.getElementById("lz-resultado");
  if (!logs.length) { cont.innerHTML = "<div class='empty-state'>Sin movimientos en el periodo.</div>"; return; }

  const porLanz = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (porLanz[l.numero]) porLanz[l.numero].push(l); });

  const naveT = {};                  // nave -> { sum, n }
  let transSum = 0, transN = 0, viajes = 0;
  Object.keys(porLanz).forEach(k => {
    const arr = porLanz[k].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "en_nave") viajes++;
      const next = arr[i + 1];
      if (!next) continue;
      const dur = Math.round((next.desde.toMillis() - ev.desde.toMillis()) / 60000);
      if (dur < 0) continue;
      if (ev.estado === "en_nave") {
        if (!naveT[ev.nave]) naveT[ev.nave] = { sum: 0, n: 0 };
        naveT[ev.nave].sum += dur; naveT[ev.nave].n++;
      } else if (ev.estado === "transito") { transSum += dur; transN++; }
    }
  });

  const navesHtml = NAVES_PANEL.filter(n => naveT[n.id])
    .map(n => filaResumen(n.nombre, formatDuracion(Math.round(naveT[n.id].sum / naveT[n.id].n))))
    .join("") || "<div class='nave-vacia'>Sin datos</div>";

  const lanzHtml = [1, 2, 3, 4].filter(n => porLanz[n].length)
    .map(n => filaResumen("Lanzadera " + n, porLanz[n].filter(x => x.estado === "en_nave").length + " viajes"))
    .join("") || "<div class='nave-vacia'>Sin datos</div>";

  cont.innerHTML =
    "<div class='informe-card'><div class='informe-card-title'>Resumen del periodo</div>" +
    "<div class='rendimiento-row'>" +
      "<div><div class='metric-value'>" + (transN ? formatDuracion(Math.round(transSum / transN)) : "—") + "</div><div class='metric-label'>Tiempo medio en transito</div></div>" +
      "<div><div class='metric-value'>" + viajes + "</div><div class='metric-label'>Viajes (llegadas a nave)</div></div>" +
      "<div><div class='metric-value'>" + logs.length + "</div><div class='metric-label'>Movimientos totales</div></div>" +
    "</div></div>" +
    "<div class='informe-grid' style='margin-top:12px'>" +
      "<div class='informe-card'><div class='informe-card-title'>Tiempo medio por nave</div>" + navesHtml + "</div>" +
      "<div class='informe-card'><div class='informe-card-title'>Actividad por lanzadera</div>" + lanzHtml + "</div>" +
    "</div>";
}

async function cargarReservas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const snap  = await db.collection("reservas").where("fecha", "==", fecha).get();
  const reservas = [];
  snap.forEach(d => reservas.push({ id: d.id, ...d.data() }));
  reservas.sort((a, b) => a.franja.localeCompare(b.franja));

  document.getElementById("m-total").textContent      = reservas.length;
  document.getElementById("m-pendientes").textContent  = reservas.filter(r => r.estado === "pendiente").length;
  document.getElementById("m-confirmadas").textContent = reservas.filter(r => r.estado === "confirmada").length;
  document.getElementById("m-curso").textContent       = reservas.filter(r => r.estado === "en_curso").length;

  const ahora = new Date();
  esHoy    = (fecha === ahora.toISOString().split("T")[0]);
  ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  document.getElementById("last-refresh").textContent = "Actualizado a las " +
    ahora.getHours().toString().padStart(2,"0") + ":" + ahora.getMinutes().toString().padStart(2,"0");

  window._reservas = reservas;
  renderRejilla(reservas);
  renderLista(reservas);
}

function renderRejilla(reservas) {
  renderSeccion("rejilla-seco",     MUELLES_SECO,     FRANJAS_SECO,     "seco",     reservas);
  renderSeccion("rejilla-frio",     MUELLES_FRIO,     FRANJAS_FRIO,     "frio",     reservas);
  renderSeccion("rejilla-lavadero", MUELLES_LAVADERO, FRANJAS_LAVADERO, "lavadero", reservas);
}

function renderSeccion(tableId, muelles, franjas, seccion, reservas) {
  const table = document.getElementById(tableId);
  if (!table) return;
  let thead = "<thead><tr><th class='muelle-th'>Muelle</th>";
  franjas.forEach(f => {
    thead += "<th class='franja-th" + (franjaEsAhora(f) ? " franja-now" : "") + "'>" + f.split(" - ")[0] + "</th>";
  });
  thead += "</tr></thead><tbody>";
  let tbody = "";
  muelles.forEach(muelle => {
    tbody += "<tr><td class='muelle-td'>" + muelle + "</td>";
    franjas.forEach(franja => {
      const now = franjaEsAhora(franja) ? " col-now" : "";
      const hits = reservas.filter(r => r.muelle === muelle && r.franja === franja);
      const pend = reservas.filter(r => !r.muelle && r.franja === franja && r.estado === "pendiente" && r.seccion === seccion);
      if (hits.length > 0) {
        const r = hits[0]; const color = ESTADO_COLOR[r.estado] || "#9CA3AF";
        tbody += "<td class='slot-td" + now + "' data-id='" + r.id + "' style='background:" + color + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>" + esc(r.estado) + "</div></td>";
      } else if (pend.length > 0) {
        const r = pend[0];
        tbody += "<td class='slot-td slot-pendiente" + now + "' data-id='" + r.id + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>pendiente</div></td>";
      } else {
        tbody += "<td class='slot-td slot-libre" + now + "'></td>";
      }
    });
    tbody += "</tr>";
  });
  table.innerHTML = thead + tbody + "</tbody>";
}

function renderLista(reservas) {
  const lista = document.getElementById("reservas-list");
  if (reservas.length === 0) { lista.innerHTML = "<div class='empty-state'>No hay reservas para este dia.</div>"; return; }
  lista.innerHTML = reservas.map(r => {
    const acciones = r.estado === "confirmada"
      ? "<div class='reserva-acciones'><button class='btn-accion btn-en-curso' data-id='" + r.id + "'>Marcar en curso</button><button class='btn-accion btn-completar' data-id='" + r.id + "'>Completar</button></div>"
      : r.estado === "en_curso"
      ? "<div class='reserva-acciones'><button class='btn-accion btn-completar' data-id='" + r.id + "'>Completar descarga</button></div>"
      : "";
    return "<div class='reserva-item' data-id='" + r.id + "'>" +
      "<div class='reserva-hora'>" + esc(r.franja) + "</div>" +
      "<div class='reserva-info'><div class='reserva-empresa'>" + esc(r.empresa) + " · " + esc(r.matricula) + "</div>" +
      "<div class='reserva-detalle'>" + esc(SEC_LABEL[r.seccion] || r.temperatura) + " · " + esc(r.mercancia || "—") + " · " + (r.pales ? esc(r.pales) + " pales" : "—") + "</div>" +
      (r.muelle ? "<div class='reserva-muelle'>Muelle " + esc(r.muelle) + "</div>" : "") + acciones + "</div>" +
      "<span class='estado-pill estado-" + esc(r.estado) + "'>" + esc(r.estado) + "</span></div>";
  }).join("");
}

async function cambiarEstado(id, nuevoEstado) {
  const datos = { estado: nuevoEstado };
  if (nuevoEstado === "en_curso")   datos.inicio_descarga = firebase.firestore.Timestamp.now();
  if (nuevoEstado === "completada") datos.fin_descarga    = firebase.firestore.Timestamp.now();
  try { await db.collection("reservas").doc(id).update(datos); cargarReservas(); }
  catch(err) { console.error(err); alert("Error al actualizar el estado."); }
}

async function cargarInforme() {
  const desde = document.getElementById("informe-desde").value;
  const hasta  = document.getElementById("informe-hasta").value;
  if (!desde || !hasta) { alert("Selecciona un rango de fechas."); return; }
  const snap = await db.collection("reservas").where("fecha", ">=", desde).where("fecha", "<=", hasta).get();
  informeData = [];
  snap.forEach(d => informeData.push({ id: d.id, ...d.data() }));
  informeData.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.franja.localeCompare(b.franja));

  if (informeData.length === 0) {
    document.getElementById("informe-metricas").style.display = "none";
    document.getElementById("informe-tablas").style.display   = "none";
    document.getElementById("informe-empty").style.display    = "block";
    return;
  }
  document.getElementById("informe-empty").style.display    = "none";
  document.getElementById("informe-metricas").style.display = "grid";
  document.getElementById("informe-tablas").style.display   = "block";

  document.getElementById("inf-total").textContent       = informeData.length;
  document.getElementById("inf-completadas").textContent  = informeData.filter(r => r.estado === "completada").length;
  document.getElementById("inf-rechazadas").textContent   = informeData.filter(r => r.estado === "rechazada").length;
  document.getElementById("inf-empresas").textContent     = [...new Set(informeData.map(r => r.empresa))].length;

  // Rendimiento de descarga (tiempo medio y ritmo min/palet)
  const conDur = informeData.filter(r => duracionMin(r) != null);
  const medio  = conDur.length ? Math.round(conDur.reduce((s, r) => s + duracionMin(r), 0) / conDur.length) : null;
  const conPal = conDur.filter(r => r.pales > 0);
  const totMin = conPal.reduce((s, r) => s + duracionMin(r), 0);
  const totPal = conPal.reduce((s, r) => s + r.pales, 0);
  document.getElementById("rend-medio").textContent    = formatDuracion(medio);
  document.getElementById("rend-ritmo").textContent    = formatRitmo(totPal > 0 ? totMin / totPal : null);
  document.getElementById("rend-muestras").textContent = conDur.length;

  const count = (key, label) => { const c = {}; informeData.forEach(r => { const k = label ? (label[r[key]] || r[key]) : r[key]; c[k] = (c[k]||0)+1; }); return Object.entries(c).sort((a,b)=>b[1]-a[1]); };
  document.getElementById("tabla-franjas").innerHTML    = renderBarras(count("franja").slice(0,8), informeData.length);
  document.getElementById("tabla-empresas").innerHTML   = renderBarras(count("empresa").slice(0,8), informeData.length);
  document.getElementById("tabla-temperatura").innerHTML = renderBarras(count("seccion", SEC_LABEL), informeData.length);
  document.getElementById("tabla-muelles").innerHTML    = renderBarras(count("muelle").filter(x=>x[0]&&x[0]!=="null"), informeData.length);
  document.getElementById("tabla-heatmap").innerHTML    = renderHeatmap(count("franja").sort((a,b)=>a[0].localeCompare(b[0])));
  document.getElementById("tabla-completa").innerHTML   = renderTablaCompleta(informeData);
}

// Mapa de calor: cada franja coloreada segun su demanda (verde -> rojo)
function renderHeatmap(entries) {
  if (!entries.length) return "<div class='empty-state' style='padding:16px'>Sin datos</div>";
  const max = Math.max.apply(null, entries.map(e => e[1]));
  return "<div class='heatmap'>" + entries.map(function(e) {
    const franja = e[0], n = e[1];
    const ratio = max > 0 ? n / max : 0;
    const hue = Math.round(120 * (1 - ratio)); // 120 verde -> 0 rojo
    return "<div class='heat-cell' style='background:hsl(" + hue + ",65%,45%)' title='" + esc(franja) + ": " + n + " reservas'>" +
      "<div class='heat-hora'>" + esc(franja.split(" - ")[0]) + "</div>" +
      "<div class='heat-num'>" + n + "</div></div>";
  }).join("") + "</div>";
}

function renderBarras(items, total) {
  if (!items.length) return "<div class='empty-state' style='padding:16px'>Sin datos</div>";
  return items.map(item => "<div class='barra-row'><div class='barra-label'>" + esc(item[0]) + "</div>" +
    "<div class='barra-wrap'><div class='barra-fill' style='width:" + Math.round(item[1]/total*100) + "%'></div></div>" +
    "<div class='barra-val'>" + item[1] + "</div></div>").join("");
}

function renderTablaCompleta(reservas) {
  let html = "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr><th>Fecha</th><th>Franja</th><th>Seccion</th><th>Empresa</th><th>Matricula</th><th>Mercancia</th><th>Pales</th><th>Muelle</th><th>Duracion</th><th>Min/palet</th><th>Estado</th></tr></thead><tbody>";
  reservas.forEach(r => {
    html += "<tr><td>" + esc(r.fecha) + "</td><td>" + esc(r.franja) + "</td><td>" + esc(SEC_LABEL[r.seccion]||r.temperatura) + "</td>" +
      "<td>" + esc(r.empresa) + "</td><td>" + esc(r.matricula) + "</td><td>" + esc(r.mercancia||"—") + "</td>" +
      "<td>" + esc(r.pales||"—") + "</td><td>" + esc(r.muelle||"—") + "</td>" +
      "<td>" + esc(formatDuracion(duracionMin(r))) + "</td>" +
      "<td>" + esc(formatRitmo(ritmoPalet(r))) + "</td>" +
      "<td><span class='estado-pill estado-" + esc(r.estado) + "'>" + esc(r.estado) + "</span></td></tr>";
  });
  return html + "</tbody></table></div>";
}

function exportarExcel() {
  if (!informeData.length) { alert("Primero consulta un periodo para exportar."); return; }
  const filas = informeData.map(r => ({
    "Fecha": r.fecha, "Franja": r.franja, "Seccion": SEC_LABEL[r.seccion]||r.temperatura,
    "Empresa": r.empresa, "Matricula": r.matricula, "Conductor": r.conductor||"",
    "Email": r.email||"", "Temperatura": r.temperatura, "Mercancia": r.mercancia||"",
    "Pales": r.pales||"", "Peso kg": r.peso||"", "Observaciones": r.observaciones||"",
    "Muelle": r.muelle||"", "Duracion": formatDuracion(duracionMin(r)),
    "Min/palet": formatRitmo(ritmoPalet(r)), "Estado": r.estado,
    "Motivo": r.motivo||"", "Nota almacen": r.nota_almacen||"", "Codigo": r.codigo
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Reservas");
  XLSX.writeFile(wb, "Aldelis_Reservas_" + document.getElementById("informe-desde").value + "_" + document.getElementById("informe-hasta").value + ".xlsx");
}

function abrirModal(id) {
  const r = window._reservas.find(x => x.id === id);
  if (!r) return;
  reservaActual = r;
  document.getElementById("modal-titulo").textContent = "Reserva " + r.codigo;
  document.getElementById("modal-sub").textContent    = "Solicitada para el " + r.fecha;

  const rows = [
    ["Empresa", r.empresa], ["Matricula", r.matricula], ["Franja", r.franja],
    ["Seccion", SEC_LABEL[r.seccion]||r.temperatura], ["Temperatura", r.temperatura],
    ["Mercancia", r.mercancia||"—"], ["Pales", r.pales ? r.pales+" pales" : "—"],
    ["Peso", r.peso ? r.peso+" kg" : "—"], ["Estado", r.estado],
    r.muelle ? ["Muelle", r.muelle] : null
  ].filter(Boolean);

  document.getElementById("modal-datos").innerHTML = rows.map(row =>
    "<div class='resumen-row'><span class='resumen-label'>" + esc(row[0]) + "</span><span class='resumen-value'>" + esc(row[1]) + "</span></div>"
  ).join("");

  const m = r.seccion === "lavadero" ? MUELLES_LAVADERO : r.seccion === "frio" ? MUELLES_FRIO : MUELLES_SECO;
  const f = r.seccion === "lavadero" ? FRANJAS_LAVADERO : r.seccion === "frio" ? FRANJAS_FRIO : FRANJAS_SECO;

  ["muelle-confirmar", "muelle-reasignar"].forEach(selId => {
    document.getElementById(selId).innerHTML = m.map(x => "<option value='" + x + "'>" + x + "</option>").join("");
  });
  document.getElementById("franja-reasignar").innerHTML = f.map(x => "<option value='" + x + "'>" + x + "</option>").join("");

  document.getElementById("tab-en-curso").style.display  = r.estado === "confirmada" ? "block" : "none";
  document.getElementById("tab-completar").style.display = (r.estado === "confirmada" || r.estado === "en_curso") ? "block" : "none";

  switchTab("confirmar");
  document.getElementById("modal").style.display = "flex";
}

function cerrarModal(e) {
  if (!e || e.target.id === "modal") { document.getElementById("modal").style.display = "none"; reservaActual = null; }
}

function switchTab(tab) {
  ["confirmar","reasignar","rechazar","en-curso","completar"].forEach(t => {
    const te = document.getElementById("tab-"+t), pe = document.getElementById("panel-"+t);
    if (te) te.classList.remove("active");
    if (pe) pe.style.display = "none";
  });
  const te = document.getElementById("tab-"+tab), pe = document.getElementById("panel-"+tab);
  if (te) te.classList.add("active");
  if (pe) pe.style.display = "block";
}

async function accionReserva(accion) {
  if (!reservaActual) return;
  let datos = {}, emailTo = reservaActual.email, emailSubject = "", emailBody = "";

  if (accion === "confirmar") {
    const muelle = document.getElementById("muelle-confirmar").value;
    const nota   = document.getElementById("nota-confirmar").value.trim();
    datos = { estado: "confirmada", muelle, nota_almacen: nota };
    emailSubject = "Reserva confirmada en Aldelis — " + reservaActual.codigo;
    emailBody = "Hola " + reservaActual.empresa + ",\n\nTu reserva ha sido CONFIRMADA.\n\n" +
      "Muelle asignado: " + muelle + "\nFranja: " + reservaActual.franja + "\nFecha: " + reservaActual.fecha +
      (nota ? "\n\nNota del almacen: " + nota : "") +
      "\n\nPresentate en el muelle " + muelle + " a las " + reservaActual.franja.split(" - ")[0] + ".\n\nAldelis — Gestion de muelles";
  }
  if (accion === "reasignar") {
    const muelle = document.getElementById("muelle-reasignar").value;
    const franja = document.getElementById("franja-reasignar").value;
    const motivo = document.getElementById("motivo-reasignar").value.trim();
    datos = { estado: "reasignada", muelle, franja, motivo };
    emailSubject = "Reserva reasignada en Aldelis — " + reservaActual.codigo;
    emailBody = "Hola " + reservaActual.empresa + ",\n\nTu reserva ha sido MODIFICADA.\n\nNueva franja: " + franja +
      "\nMuelle: " + muelle + (motivo ? "\nMotivo: " + motivo : "") +
      "\n\nAldelis — Gestion de muelles";
  }
  if (accion === "rechazar") {
    const motivo  = document.getElementById("motivo-rechazar").value;
    const mensaje = document.getElementById("mensaje-rechazar").value.trim();
    if (!motivo) { alert("Selecciona un motivo."); return; }
    datos = { estado: "rechazada", motivo, nota_almacen: mensaje, muelle: null };
    emailSubject = "Reserva no aceptada en Aldelis — " + reservaActual.codigo;
    emailBody = "Hola " + reservaActual.empresa + ",\n\nTu reserva NO ha sido aceptada.\n\nMotivo: " + motivo +
      (mensaje ? "\n" + mensaje : "") +
      "\n\nPuedes realizar una nueva reserva en:\nhttps://aldelis-muelles.web.app\n\nAldelis — Gestion de muelles";
  }
  if (accion === "en-curso")  { datos = { estado: "en_curso",  inicio_descarga: firebase.firestore.Timestamp.now() }; }
  if (accion === "completar") { datos = { estado: "completada", fin_descarga:    firebase.firestore.Timestamp.now() }; }

  try {
    await db.collection("reservas").doc(reservaActual.id).update(datos);
    if (emailTo && emailSubject) await enviarEmailMS(emailTo, emailSubject, emailBody);
    cerrarModal();
    cargarReservas();
  } catch(e) { console.error(e); alert("Error al actualizar. Intentalo de nuevo."); }
}
