// Escapa texto antes de insertarlo como HTML (proteccion anti-XSS)
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// Modo oscuro — guarda preferencia en localStorage
function toggleDarkMode() {
  const body = document.getElementById('admin-body');
  const dark = body.classList.toggle('dark');
  localStorage.setItem('darkMode', dark ? '1' : '0');
  document.getElementById('btn-dark').textContent = dark ? 'Dia' : 'Noche';
}

function initDarkMode() {
  document.documentElement.classList.remove('preload-dark');
  if (localStorage.getItem('darkMode') === '1') {
    document.getElementById('admin-body').classList.add('dark');
    const btn = document.getElementById('btn-dark');
    if (btn) btn.textContent = 'Dia';
  }
}

// Envio de email via Firebase Function (body = texto plano, html = HTML opcional)
async function enviarEmailMS(to, subject, body, html) {
  if (!to) return;
  try {
    const enviarEmail = firebase.functions().httpsCallable("enviarEmail");
    await enviarEmail({ to, subject, body, html: html || null });
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

// Version de la app. SUBIR este numero al publicar cambios importantes:
// las pestanas abiertas se recargaran solas para coger la version nueva.
const APP_VERSION = 35;
let _chatSel = 1;
function vigilarVersion() {
  db.collection("config").doc("app").onSnapshot(d => {
    const v = d.exists ? (d.data().version || 0) : 0;
    if (v > APP_VERSION) {
      location.reload();
    } else if (v < APP_VERSION) {
      // Este cliente es el mas nuevo: publica su version para que los demas se actualicen.
      db.collection("config").doc("app").set({ version: APP_VERSION }, { merge: true }).catch(() => {});
    }
  }, e => {});
}

// Resaltado de la franja "en curso" (solo si el dia mostrado es hoy)
let esHoy = false;
let ahoraMin = 0;
function franjaRango(franja) {
  const p = franja.split(" - ");
  const toMin = t => { const x = t.trim().split(":"); return (+x[0]) * 60 + (+x[1]); };
  let a = toMin(p[0]);
  let b = p[1] ? toMin(p[1]) : a + 30;
  if (b === 0) b = 1440; // 00:00 como fin = medianoche
  return [a, b];
}
function franjaEsAhora(franja) {
  if (!esHoy) return false;
  const r = franjaRango(franja);
  return ahoraMin >= r[0] && ahoraMin < r[1];
}
function generarFranjas(iniHora, finHora) { // finHora exclusivo (24 = medianoche)
  const arr = [];
  const fmt = x => String(Math.floor(x / 60) % 24).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
  for (let m = iniHora * 60; m < finHora * 60; m += 30) arr.push(fmt(m) + " - " + fmt(m + 30));
  return arr;
}
const FRANJAS_CARGAS = generarFranjas(6, 24);
const FRANJAS_LANZ   = generarFranjas(4, 24);

// Linea de tiempo (Gantt) de lanzaderas: 04:00 -> 00:00
const G_INI = 240, G_FIN = 1440, G_PXMIN = 8, G_W = (G_FIN - G_INI) * G_PXMIN, G_LABEL_W = 110;

// Pinta una rejilla generica (filas x franjas). celdaFn devuelve el <td>.
function pintarRejilla(tableId, headerLabel, filas, franjas, celdaFn) {
  const table = document.getElementById(tableId);
  if (!table) return;
  let thead = "<thead><tr><th class='muelle-th'>" + headerLabel + "</th>";
  franjas.forEach(f => { thead += "<th class='franja-th" + (franjaEsAhora(f) ? " franja-now" : "") + "'>" + f.split(" - ")[0] + "</th>"; });
  thead += "</tr></thead><tbody>";
  let tbody = "";
  filas.forEach(fila => {
    tbody += "<tr><td class='muelle-td'>" + esc(fila.label) + "</td>";
    franjas.forEach(f => { tbody += celdaFn(fila, f, franjaEsAhora(f) ? " col-now" : ""); });
    tbody += "</tr>";
  });
  table.innerHTML = thead + tbody + "</tbody>";
  centrarFranjaActual(table);
}

// Desplaza la rejilla para centrar la columna de la hora actual
function centrarFranjaActual(table) {
  const cell = table.querySelector("th.franja-now");
  if (!cell) return;
  const scroller = table.closest(".grid-scroll");
  if (!scroller || !scroller.clientWidth) return;
  scroller.scrollLeft = cell.offsetLeft - scroller.clientWidth / 2 + cell.offsetWidth / 2;
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

// Formato moneda: "1.234,56 €"
function formatEuro(v) {
  if (v == null || isNaN(v)) return "—";
  const parts = v.toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return parts[0] + "," + parts[1] + " €";
}

document.addEventListener("click", function(e) {
  const slot = e.target.closest("[data-id]");
  if (slot) {
    e.stopPropagation();
    const id = slot.getAttribute("data-id");
    if (slot.classList.contains("btn-en-curso"))   cambiarEstado(id, "en_curso");
    else if (slot.classList.contains("btn-completar")) cambiarEstado(id, "completada");
    else abrirModal(id, slot.getAttribute("data-muelle"));
  }
});

// Clic en una barra del Gantt -> muestra sus datos
document.addEventListener("click", function(e) {
  const bar = e.target.closest("[data-info]");
  if (bar) alert(bar.getAttribute("data-info"));
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
    document.getElementById("cg-desde").value         = hoy;
    document.getElementById("cg-hasta").value         = hoy;
    document.getElementById("bz-desde").value         = hoy;
    document.getElementById("bz-hasta").value         = hoy;
    initDarkMode();
    iniciarListeners();
    vigilarVersion();
    cargarConfigListeners();
    aplicarRol(user);
    _emisorActual = nombreEmisor(user.email);
    if (typeof initPush === "function") initPush("almacen");
    // Reloj local (mueve la linea de "ahora" y refresca el render, SIN leer de la BD)
    autoRefreshInterval = setInterval(() => {
      actualizarReloj();
      cargarReservas(); cargarLanzaderas(); cargarCargas(); cargarMerca();
      autoEnviarCostesAlFinalDelDia();
    }, 60000);
  } else {
    document.getElementById("login-screen").style.display     = "flex";
    document.getElementById("dashboard-screen").style.display = "none";
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    pararListeners();
  }
});

let _unsubs = [];
function pararListeners() { _unsubs.forEach(u => { try { u(); } catch (e) {} }); _unsubs = []; }

function actualizarReloj() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const ahora = new Date();
  esHoy    = (fecha === ahora.toISOString().split("T")[0]);
  ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  document.getElementById("last-refresh").textContent = "Actualizado a las " +
    ahora.getHours().toString().padStart(2, "0") + ":" + ahora.getMinutes().toString().padStart(2, "0");
}

// Tiempo real: escucha cambios y solo cobra lecturas de lo que cambia
function iniciarListeners() {
  pararListeners();
  actualizarReloj();
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const dayEnd = dayStart + 86400000;
  const Ts = firebase.firestore.Timestamp;

  _unsubs.push(db.collection("reservas").where("fecha", "==", fecha)
    .onSnapshot(s => {
      window._reservas = []; s.forEach(d => window._reservas.push({ id: d.id, ...d.data() }));
      cargarReservas();
    }, e => console.error("reservas:", e)));

  _unsubs.push(db.collection("lanzaderas_log")
    .where("desde", ">=", Ts.fromMillis(dayStart)).where("desde", "<", Ts.fromMillis(dayEnd))
    .onSnapshot(s => {
      window._logs = []; s.forEach(d => window._logs.push(d.data()));
      cargarLanzaderas(); cargarReservas(); cargarCargas(); cargarMerca();
    }, e => console.error("lanzaderas_log:", e)));

  _unsubs.push(db.collection("cargas")
    .where("inicio", ">=", Ts.fromMillis(dayStart)).where("inicio", "<", Ts.fromMillis(dayEnd))
    .onSnapshot(s => {
      window._cargas = []; s.forEach(d => window._cargas.push({ id: d.id, ...d.data() }));
      cargarCargas();
    }, e => console.error("cargas:", e)));

  _unsubs.push(db.collection("descargas_merca")
    .where("inicio", ">=", Ts.fromMillis(dayStart)).where("inicio", "<", Ts.fromMillis(dayEnd))
    .onSnapshot(s => {
      window._merca = []; s.forEach(d => window._merca.push({ id: d.id, ...d.data() }));
      cargarMerca();
    }, e => console.error("merca:", e)));

  _unsubs.push(db.collection("mensajes").orderBy("ts", "desc").limit(100)
    .onSnapshot(s => {
      const arr = []; s.forEach(d => arr.push(d.data())); arr.reverse();
      window._mensajes = arr; renderChat();
      // Aviso sonoro al recibir un mensaje nuevo de una lanzadera
      let maxLanz = 0;
      arr.forEach(m => { if (m.de === "lanzadera" && m.ts) maxLanz = Math.max(maxLanz, m.ts.toMillis()); });
      if (_msgBeepInit && maxLanz > _msgBeepMaxTs) beep();
      _msgBeepMaxTs = Math.max(_msgBeepMaxTs, maxLanz);
      _msgBeepInit = true;
    }, e => console.error("mensajes:", e)));

  _unsubs.push(db.collection("config").doc("costes").onSnapshot(d => {
    _costesEmailsCache = (d.exists && Array.isArray(d.data().emails)) ? d.data().emails : [];
    renderCostesEmails();
  }, () => {}));

  _unsubs.push(db.collection("incidencias")
    .where("creada", ">=", Ts.fromMillis(dayStart)).where("creada", "<", Ts.fromMillis(dayEnd))
    .onSnapshot(s => {
      window._incidencias = []; s.forEach(d => window._incidencias.push({ id: d.id, ...d.data() }));
      cargarBizerba();
    }, e => console.error("incidencias:", e)));
}

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

// Usuarios que solo ven la vista de Lanzaderas (gerente de lanzaderas)
const SOLO_LANZADERAS = ["transfriorza@transfriorza.es"];
const BIZERBA_USERS   = ["mlorente@aldelis.com", "jpina@aldelis.com"];
const CONFIG_USERS    = ["mlorente@aldelis.com"];
const COSTES_USERS    = ["mlorente@aldelis.com"];
function aplicarRol(user) {
  const email = (user.email || "").toLowerCase();
  const bizBtn = document.getElementById("btn-vista-bizerba");
  if (bizBtn) bizBtn.style.display = BIZERBA_USERS.includes(email) ? "" : "none";
  const cfgBtn = document.getElementById("btn-vista-config");
  if (cfgBtn) cfgBtn.style.display = CONFIG_USERS.includes(email) ? "" : "none";
  const costBtn = document.getElementById("btn-vista-costes");
  if (costBtn) costBtn.style.display = COSTES_USERS.includes(email) ? "" : "none";
  const soloLanz = SOLO_LANZADERAS.includes(email);
  if (!soloLanz) return;
  ["rejilla", "lista", "informes", "cargas", "merca"].forEach(v => {
    const b = document.getElementById("btn-vista-" + v);
    if (b) b.style.display = "none";
  });
  const mr = document.querySelector(".metrics-row");
  if (mr) mr.style.display = "none";
  switchVista("lanzaderas");
}

function switchVista(vista) {
  ["rejilla", "lista", "informes", "lanzaderas", "cargas", "merca", "bizerba", "config", "costes"].forEach(v => {
    document.getElementById("vista-" + v).style.display = vista === v ? "block" : "none";
    document.getElementById("btn-vista-" + v).classList.toggle("active", vista === v);
  });
  if (vista === "lanzaderas") cargarLanzaderas();
  if (vista === "cargas")     cargarCargas();
  if (vista === "merca")      cargarMerca();
  if (vista === "bizerba")    cargarBizerba();
  if (vista === "config")     cargarConfig();
  if (vista === "costes")     cargarCostes();
}

const MUELLES_CARGA = ["M1", "M2", "M3", "M4", "M5"];
const MUELLES_MERCA = ["M2", "M4"];

function cambioFecha() { iniciarListeners(); }

let NAVES_PANEL = [
  { id: "plaza",    nombre: "Plaza" },
  { id: "caserfri", nombre: "Caserfri" },
  { id: "merca",    nombre: "Merca" },
  { id: "arento",   nombre: "Arento" },
  { id: "avitrans", nombre: "Avitrans" },
  { id: "txt",      nombre: "Txt" },
  { id: "upasa",    nombre: "Upasa" },
  { id: "sabeco",   nombre: "Sabeco" }
];
const NAVE_NOMBRE = {};
NAVES_PANEL.forEach(n => { NAVE_NOMBRE[n.id] = n.nombre; });
const ACCION_LABEL = { cargando: "Cargando", descargando: "Descargando", presente: "Presente" };
const ACCION_COLOR = { cargando: "#185FA5", descargando: "#1D9E75", presente: "#6B7280" };
// Coste por minuto de cada lanzadera — se recalcula con diasLaborables del mes
// L1/L2: 12.500€/mes ÷ diasLaborables ÷ 1440 min/día
// L3:    12.500€/mes ÷ diasLaborables ÷ 480 min/jornada (8h)
// L4:    150€/h → 2,50€/min (tarifa horaria fija)
let _diasLaborables = 22;
let LANZ_COSTE_MIN = {};
function recalcLanzCosteMin() {
  const d = _diasLaborables > 0 ? _diasLaborables : 22;
  LANZ_COSTE_MIN = { 1: 12500/(d*1440), 2: 12500/(d*1440), 3: 12500/(d*480), 4: 150/60 };
}
recalcLanzCosteMin();

// Tramos de lanzadera (para superponer en parrillas de descarga/carga/merca)
function lanzaderaSegmentos(dayStart, dayEnd, accionFiltro, nave) {
  nave = nave || "plaza";
  const logs = window._logs || [];
  const byL = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (byL[l.numero]) byL[l.numero].push(l); });
  const segs = [];
  Object.keys(byL).forEach(k => {
    const arr = byL[k].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "en_nave" && ev.nave === nave && (accionFiltro == null || ev.accion === accionFiltro)) {
        const startMin = (ev.desde.toMillis() - dayStart) / 60000;
        const nextMs = (i + 1 < arr.length) ? arr[i + 1].desde.toMillis() : (esHoy ? Date.now() : dayEnd);
        segs.push({ numero: +k, muelle: ev.muelle, startMin, endMin: (nextMs - dayStart) / 60000 });
      }
    }
  });
  return segs;
}

function cargarLanzaderas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const logs = window._logs || [];

  // Segmentos de presencia (en_nave) por lanzadera
  const byL = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (byL[l.numero]) byL[l.numero].push(l); });
  const segs = [];      // presencia en nave
  const trans = [];     // en transito
  const finMarks = [];  // fin de jornada (no ocupa, solo marca)
  Object.keys(byL).forEach(k => {
    const arr = byL[k].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const startMin = (arr[i].desde.toMillis() - dayStart) / 60000;
      if (arr[i].estado === "fuera") { finMarks.push({ numero: +k, atMin: startMin }); continue; }
      const nextMs = (i + 1 < arr.length) ? arr[i + 1].desde.toMillis() : (esHoy ? Date.now() : dayEnd);
      const endMin = (nextMs - dayStart) / 60000;
      if (arr[i].estado === "en_nave") segs.push({ numero: +k, nave: arr[i].nave, muelle: arr[i].muelle, accion: arr[i].accion, startMin, endMin });
      else if (arr[i].estado === "transito") trans.push({ numero: +k, destino: arr[i].destino || null, startMin, endMin });
    }
  });

  renderGanttLanz(segs, trans, finMarks);
}

// ─── COSTES / HISTORIAL DIARIO DE LANZADERAS ────────────────────────
let _costesEmailsCache = [];

function cargarCostes() {
  cargarHistorialDiario();
  renderCostesEmails();
  actualizarUltimoEnvio();
}

function cargarHistorialDiario() {
  const cont = document.getElementById("costes-historial");
  if (!cont) return;

  const fecha = document.getElementById("fecha-dashboard").value;
  const dayEnd = new Date(fecha + "T00:00:00").getTime() + 86400000;
  const logs = (window._logs || []).slice();

  if (!logs.length) {
    cont.innerHTML = "<div class='empty-state'>Sin movimientos registrados hoy.</div>";
    return;
  }

  const MAX_DUR = 480;
  const byL = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (byL[l.numero]) byL[l.numero].push(l); });

  const allSegs = [];
  [1, 2, 3, 4].forEach(n => {
    const arr = byL[n].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "fuera") continue;
      const startMs = ev.desde.toMillis();
      const nextMs = i + 1 < arr.length ? arr[i + 1].desde.toMillis() : (esHoy ? Date.now() : dayEnd);
      const durMin = Math.round((nextMs - startMs) / 60000);
      if (durMin < 0 || durMin > MAX_DUR) continue;
      allSegs.push({
        numero: n, estado: ev.estado,
        nave: ev.nave || null, muelle: ev.muelle || null,
        accion: ev.accion || null, destino: ev.destino || null,
        startMs, durMin,
        coste: durMin * (LANZ_COSTE_MIN[n] || 0)
      });
    }
  });

  if (!allSegs.length) {
    cont.innerHTML = "<div class='empty-state'>Sin datos suficientes para calcular.</div>";
    return;
  }

  const enNaveSegs = allSegs.filter(s => s.estado === "en_nave");
  const transitoSegs = allSegs.filter(s => s.estado === "transito");
  const totalNaveMin = enNaveSegs.reduce((s, x) => s + x.durMin, 0);
  const totalTransitoMin = transitoSegs.reduce((s, x) => s + x.durMin, 0);
  const viajes = enNaveSegs.length;
  const mediaNaveSeg = viajes ? Math.round(totalNaveMin / viajes) : 0;

  // Tasa media €/min ponderada por minutos usados
  const totalMin = allSegs.reduce((s, x) => s + x.durMin, 0);
  const totalCosteOps = allSegs.reduce((s, x) => s + x.coste, 0);
  const tasaMedia = totalMin > 0 ? totalCosteOps / totalMin : 8.68;

  // Time by nave
  const naveStats = {};
  enNaveSegs.forEach(s => {
    if (!naveStats[s.nave]) naveStats[s.nave] = { sum: 0, n: 0 };
    naveStats[s.nave].sum += s.durMin;
    naveStats[s.nave].n++;
  });

  // Time by muelle
  const muelleStats = {};
  enNaveSegs.filter(s => s.muelle).forEach(s => {
    if (!muelleStats[s.muelle]) muelleStats[s.muelle] = { sum: 0, n: 0 };
    muelleStats[s.muelle].sum += s.durMin;
    muelleStats[s.muelle].n++;
  });
  const muellesArr = Object.entries(muelleStats)
    .map(([k, v]) => ({ muelle: k, avg: Math.round(v.sum / v.n), n: v.n }))
    .sort((a, b) => a.avg - b.avg);
  const masRapido = muellesArr[0] || null;
  const masLento = muellesArr[muellesArr.length - 1] || null;

  // Costs
  const costePorLanz = { 1: 0, 2: 0, 3: 0, 4: 0 };
  allSegs.forEach(s => { costePorLanz[s.numero] += s.coste; });

  const navesCosteSorted = Object.entries(
    enNaveSegs.reduce((acc, s) => { acc[s.nave] = (acc[s.nave] || 0) + s.coste; return acc; }, {})
  ).sort((a, b) => b[1] - a[1]);

  const topEsperas = enNaveSegs.slice().sort((a, b) => b.coste - a.coste).slice(0, 5);

  // ── HTML ────────────────────────────────────────────────────────

  let html = "<div class='informe-metricas' style='margin-top:0'>" +
    "<div class='metric-card'><div class='metric-value'>" + viajes + "</div><div class='metric-label'>Viajes a nave</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + formatDuracion(mediaNaveSeg) + "</div><div class='metric-label'>Tiempo medio por visita</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + formatDuracion(totalNaveMin) + "</div><div class='metric-label'>Total en nave</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + formatDuracion(totalTransitoMin) + "</div><div class='metric-label'>Total en transito</div></div>" +
  "</div>";

  // Nave time
  const naveFilasHtml = NAVES_PANEL.filter(n => naveStats[n.id]).map(n => {
    const s = naveStats[n.id];
    return filaResumen(n.nombre, formatDuracion(Math.round(s.sum / s.n)) + " · " + s.n + " vis.");
  }).join("") || "<div class='empty-state' style='padding:12px'>Sin datos</div>";

  // Muelle time + fastest/slowest + savings
  let muelleHtml = "";
  const plazaMuelles = ["M6","M7","M8","M18","M19","M20"].filter(m => muelleStats[m]);
  const mercaMuelles = ["M2","M4"].filter(m => muelleStats[m]);
  if (plazaMuelles.length) {
    muelleHtml += "<div class='costes-subhead'>Plaza</div>";
    plazaMuelles.forEach(m => {
      const s = muelleStats[m];
      muelleHtml += filaResumen(m, formatDuracion(Math.round(s.sum / s.n)) + " · " + s.n + " vis.");
    });
  }
  if (mercaMuelles.length) {
    muelleHtml += "<div class='costes-subhead' style='margin-top:" + (plazaMuelles.length ? "10px" : "0") + "'>Merca</div>";
    mercaMuelles.forEach(m => {
      const s = muelleStats[m];
      muelleHtml += filaResumen(m, formatDuracion(Math.round(s.sum / s.n)) + " · " + s.n + " vis.");
    });
  }
  if (masRapido && masLento && masRapido.muelle !== masLento.muelle) {
    const diffMin = masLento.avg - masRapido.avg;
    const ahorroVisita = diffMin * tasaMedia;
    const ahorroTotal = ahorroVisita * masRapido.n;
    muelleHtml += "<div style='margin-top:12px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2)'>" +
      "<div style='font-size:12px;color:#1D9E75;margin-bottom:4px'>▲ Mas rapido: <strong>" + esc(masRapido.muelle) + "</strong> · " + formatDuracion(masRapido.avg) + " media</div>" +
      "<div style='font-size:12px;color:#D41F3A;margin-bottom:8px'>▼ Mas lento: <strong>" + esc(masLento.muelle) + "</strong> · " + formatDuracion(masLento.avg) + " media</div>" +
      "<div style='font-size:12px;background:rgba(29,158,117,.1);border-radius:6px;padding:8px' class='costes-ahorro'>" +
      "Diferencia: <strong>" + formatDuracion(diffMin) + "</strong> por visita · " +
      "Ahorro estimado en " + masRapido.muelle + ": <strong style='color:#1D9E75'>" + formatEuro(ahorroTotal) + "</strong> " +
      "(" + masRapido.n + " vis. × " + formatEuro(ahorroVisita) + ")" +
      "</div></div>";
  }
  if (!muelleHtml) muelleHtml = "<div class='empty-state' style='padding:12px'>Sin datos de muelle</div>";

  html += "<div class='informe-grid' style='margin-top:12px'>" +
    "<div class='informe-card'><div class='informe-card-title'>Tiempo medio por nave</div>" + naveFilasHtml + "</div>" +
    "<div class='informe-card'><div class='informe-card-title'>Tiempo medio por muelle</div>" + muelleHtml + "</div>" +
  "</div>";

  // Financial summary (no monthly total, only operation costs)
  const lanzCosteHtml = [1,2,3,4].filter(n => costePorLanz[n] > 0).map(n =>
    "<div class='metric-card' style='flex:1;min-width:140px'>" +
    "<div class='metric-value' style='font-size:18px'>" + formatEuro(costePorLanz[n]) + "</div>" +
    "<div class='metric-label'>Lanzadera " + n + "</div>" +
    "</div>"
  ).join("") || "<div class='empty-state' style='padding:12px'>Sin actividad</div>";

  const naveCosteHtml = navesCosteSorted.map(([nave, coste]) =>
    filaResumen(NAVE_NOMBRE[nave] || nave, formatEuro(coste))
  ).join("") || "<div class='empty-state' style='padding:12px'>Sin datos</div>";

  const topHtml = topEsperas.length
    ? "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr>" +
      "<th>Lanzadera</th><th>Nave</th><th>Muelle</th><th>Duracion</th><th>Coste</th>" +
      "</tr></thead><tbody>" +
      topEsperas.map(s =>
        "<tr><td>L" + s.numero + "</td><td>" + esc(NAVE_NOMBRE[s.nave] || s.nave || "—") + "</td>" +
        "<td>" + esc(s.muelle || "—") + "</td>" +
        "<td>" + formatDuracion(s.durMin) + "</td>" +
        "<td><strong>" + formatEuro(s.coste) + "</strong></td></tr>"
      ).join("") + "</tbody></table></div>"
    : "<div class='empty-state' style='padding:12px'>Sin datos</div>";

  html += "<div class='informe-card' style='margin-top:12px'>" +
    "<div class='informe-card-title'>Costes de operacion</div>" +
    "<div class='informe-metricas' style='margin-top:8px;margin-bottom:12px'>" + lanzCosteHtml + "</div>" +
    "<div class='informe-grid'>" +
    "<div class='informe-card'><div class='informe-card-title'>Coste por nave</div>" + naveCosteHtml + "</div>" +
    "<div class='informe-card'><div class='informe-card-title'>Esperas mas caras</div>" + topHtml + "</div>" +
    "</div></div>";

  // Detail per lanzadera
  [1, 2, 3, 4].forEach(n => {
    const segsN = allSegs.filter(s => s.numero === n).sort((a, b) => a.startMs - b.startMs);
    if (!segsN.length) return;
    const totalCosteN = segsN.reduce((acc, s) => acc + s.coste, 0);
    html += "<div class='informe-card' style='margin-top:12px'>" +
      "<div class='informe-card-title'>Lanzadera " + n + " &mdash; coste hoy: " + formatEuro(totalCosteN) + "</div>" +
      "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr>" +
      "<th>Entrada</th><th>Estado</th><th>Nave</th><th>Muelle</th><th>Accion</th><th>Duracion</th><th>Coste</th>" +
      "</tr></thead><tbody>" +
      segsN.map(s => {
        const d = new Date(s.startMs);
        const hora = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
        const nave = s.estado === "transito"
          ? ("→ " + (NAVE_NOMBRE[s.destino] || s.destino || NAVE_NOMBRE[s.nave] || s.nave || "?"))
          : (NAVE_NOMBRE[s.nave] || s.nave || "—");
        const accion = s.accion ? (ACCION_LABEL[s.accion] || s.accion) : (s.estado === "transito" ? "Transito" : "—");
        return "<tr>" +
          "<td>" + hora + "</td>" +
          "<td>" + esc(s.estado === "en_nave" ? "En nave" : "Transito") + "</td>" +
          "<td>" + esc(nave) + "</td>" +
          "<td>" + esc(s.muelle || "—") + "</td>" +
          "<td>" + esc(accion) + "</td>" +
          "<td>" + formatDuracion(s.durMin) + "</td>" +
          "<td>" + formatEuro(s.coste) + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table></div></div>";
  });

  cont.innerHTML = html;
}

function renderCostesEmails() {
  const div = document.getElementById("costes-emails-lista");
  if (!div) return;
  if (!_costesEmailsCache.length) {
    div.innerHTML = "<p style='font-size:13px;color:#9CA3AF'>Sin destinatarios configurados.</p>";
    return;
  }
  div.innerHTML = _costesEmailsCache.map((email, i) =>
    "<div style='display:flex;align-items:center;gap:8px;margin-bottom:6px'>" +
    "<span style='flex:1;font-size:14px'>" + esc(email) + "</span>" +
    "<button class='btn-reject' style='padding:4px 10px;font-size:12px;cursor:pointer' onclick='eliminarEmailCostes(" + i + ")'>Eliminar</button>" +
    "</div>"
  ).join("");
}

function actualizarUltimoEnvio() {
  const el = document.getElementById("costes-ultimo-envio");
  if (!el) return;
  const hoy = new Date().toISOString().split("T")[0];
  const enviado = localStorage.getItem("costesEnviados_" + hoy);
  el.textContent = enviado ? "Informe de hoy enviado a las " + enviado : "Informe de hoy pendiente de envio (se enviara a las 23:59 si el panel esta abierto).";
}

async function agregarEmailCostes() {
  const inp = document.getElementById("costes-email-nuevo");
  const email = (inp.value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) { alert("Introduce un email valido."); return; }
  if (_costesEmailsCache.includes(email)) { alert("Ese email ya esta en la lista."); return; }
  const nuevos = [..._costesEmailsCache, email];
  try {
    await db.collection("config").doc("costes").set({ emails: nuevos }, { merge: true });
    inp.value = "";
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function eliminarEmailCostes(idx) {
  if (!confirm("Eliminar este destinatario?")) return;
  const nuevos = _costesEmailsCache.filter((_, i) => i !== idx);
  try {
    await db.collection("config").doc("costes").set({ emails: nuevos }, { merge: true });
  } catch(e) { alert("Error al guardar: " + e.message); }
}

function construirCuerpoInformeCostes() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const logs = (window._logs || []).slice();
  if (!logs.length) return null;

  const MAX_DUR = 480;
  const dayEnd = new Date(fecha + "T00:00:00").getTime() + 86400000;
  const byL = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (byL[l.numero]) byL[l.numero].push(l); });

  const allSegs = [];
  [1, 2, 3, 4].forEach(n => {
    const arr = byL[n].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "fuera") continue;
      const startMs = ev.desde.toMillis();
      const nextMs = i + 1 < arr.length ? arr[i + 1].desde.toMillis() : (esHoy ? Date.now() : dayEnd);
      const durMin = Math.round((nextMs - startMs) / 60000);
      if (durMin < 0 || durMin > MAX_DUR) continue;
      allSegs.push({ numero: n, estado: ev.estado, nave: ev.nave || null, muelle: ev.muelle || null, durMin, coste: durMin * (LANZ_COSTE_MIN[n] || 0) });
    }
  });

  if (!allSegs.length) return null;

  const enNaveSegs = allSegs.filter(s => s.estado === "en_nave");
  const transitoSegs = allSegs.filter(s => s.estado === "transito");
  const viajes = enNaveSegs.length;
  const totalNaveMin = enNaveSegs.reduce((s, x) => s + x.durMin, 0);
  const totalTransMin = transitoSegs.reduce((s, x) => s + x.durMin, 0);
  const mediaNaveSeg = viajes ? Math.round(totalNaveMin / viajes) : 0;

  const costePorLanz = { 1: 0, 2: 0, 3: 0, 4: 0 };
  allSegs.forEach(s => { costePorLanz[s.numero] += s.coste; });
  const costeTotal = allSegs.reduce((s, x) => s + x.coste, 0);
  const totalMin = allSegs.reduce((s, x) => s + x.durMin, 0);
  const tasaMedia = totalMin > 0 ? costeTotal / totalMin : 8.68;

  const naveStats = {};
  enNaveSegs.forEach(s => {
    if (!naveStats[s.nave]) naveStats[s.nave] = { sum: 0, n: 0 };
    naveStats[s.nave].sum += s.durMin; naveStats[s.nave].n++;
  });

  const muelleStats = {};
  enNaveSegs.filter(s => s.muelle).forEach(s => {
    if (!muelleStats[s.muelle]) muelleStats[s.muelle] = { sum: 0, n: 0 };
    muelleStats[s.muelle].sum += s.durMin; muelleStats[s.muelle].n++;
  });
  const muellesArr = Object.entries(muelleStats)
    .map(([k, v]) => ({ muelle: k, avg: Math.round(v.sum / v.n), n: v.n }))
    .sort((a, b) => a.avg - b.avg);
  const masRapido = muellesArr[0] || null;
  const masLento = muellesArr[muellesArr.length - 1] || null;

  const navesCostes = Object.entries(
    enNaveSegs.reduce((acc, s) => { acc[s.nave] = (acc[s.nave] || 0) + s.coste; return acc; }, {})
  ).sort((a, b) => b[1] - a[1]);

  const topEsperas = enNaveSegs.slice().sort((a, b) => b.coste - a.coste).slice(0, 8);
  const fechaFmt = fecha.split("-").reverse().join("/");

  // ── helpers ───────────────────────────────────────────────────────
  const CARD = "border-radius:8px;border:1px solid #e8e8e8;background:#ffffff";

  function dataRow(label, value) {
    return "<tr>" +
      "<td style='padding:6px 0;color:#555;font-size:13px;border-bottom:1px solid #f0f0f0'>" + label + "</td>" +
      "<td style='padding:6px 0;font-weight:600;text-align:right;font-size:13px;color:#1A1A1A;border-bottom:1px solid #f0f0f0'>" + value + "</td>" +
      "</tr>";
  }

  // ── 4 metric cards ────────────────────────────────────────────────
  function mCard(val, label, accent) {
    return "<td style='padding:5px'><div style='" + CARD + ";padding:14px 8px;text-align:center'>" +
      "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px'>" + label + "</div>" +
      "<div style='font-size:19px;font-weight:700;color:" + (accent || "#1A1A1A") + "'>" + val + "</div>" +
      "</div></td>";
  }
  const metricRow =
    "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
    mCard(viajes + "", "Viajes a nave") +
    mCard(formatDuracion(mediaNaveSeg), "Tiempo medio visita") +
    mCard(formatDuracion(totalNaveMin), "Total en nave") +
    mCard(formatDuracion(totalTransMin), "Total en transito") +
    "</tr></table>";

  // ── Nave times ────────────────────────────────────────────────────
  let naveTimeRows = NAVES_PANEL.filter(n => naveStats[n.id]).map(n => {
    const s = naveStats[n.id];
    return dataRow(esc(n.nombre), formatDuracion(Math.round(s.sum / s.n)) + " · " + s.n + " vis.");
  }).join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

  // ── Muelle times + ahorro ─────────────────────────────────────────
  const plazaMuelles = ["M6","M7","M8","M18","M19","M20"].filter(m => muelleStats[m]);
  const mercaMuelles = ["M2","M4"].filter(m => muelleStats[m]);
  let muelleTimeRows = "";
  if (plazaMuelles.length) {
    muelleTimeRows += "<tr><td colspan='2' style='padding:4px 0 2px;font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em'>Plaza</td></tr>";
    plazaMuelles.forEach(m => { const s = muelleStats[m]; muelleTimeRows += dataRow(m, formatDuracion(Math.round(s.sum/s.n)) + " · " + s.n + " vis."); });
  }
  if (mercaMuelles.length) {
    muelleTimeRows += "<tr><td colspan='2' style='padding:8px 0 2px;font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em'>Merca</td></tr>";
    mercaMuelles.forEach(m => { const s = muelleStats[m]; muelleTimeRows += dataRow(m, formatDuracion(Math.round(s.sum/s.n)) + " · " + s.n + " vis."); });
  }
  if (!muelleTimeRows) muelleTimeRows = "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

  let ahorroBlock = "";
  if (masRapido && masLento && masRapido.muelle !== masLento.muelle) {
    const diffMin = masLento.avg - masRapido.avg;
    const ahorroVisita = diffMin * tasaMedia;
    const ahorroTotal = ahorroVisita * masRapido.n;
    ahorroBlock =
      "<tr><td colspan='2'><div style='margin-top:12px;padding-top:10px;border-top:1px solid #eee'>" +
      "<div style='font-size:12px;color:#1D9E75;margin-bottom:3px'>&#9650; Mas rapido: <strong>" + esc(masRapido.muelle) + "</strong> · " + formatDuracion(masRapido.avg) + " media</div>" +
      "<div style='font-size:12px;color:#D41F3A;margin-bottom:8px'>&#9660; Mas lento: <strong>" + esc(masLento.muelle) + "</strong> · " + formatDuracion(masLento.avg) + " media</div>" +
      "<div style='font-size:12px;background:#f0faf5;border-radius:6px;padding:8px;color:#1A1A1A'>" +
      "Diferencia: <strong>" + formatDuracion(diffMin) + "</strong> por visita &middot; " +
      "Ahorro estimado en " + esc(masRapido.muelle) + ": <strong style='color:#1D9E75'>" + formatEuro(ahorroTotal) + "</strong> " +
      "(" + masRapido.n + " vis. &times; " + formatEuro(ahorroVisita) + ")" +
      "</div></div></td></tr>";
  }

  // ── 2 cols: nave times | muelle times ─────────────────────────────
  const colNave =
    "<td width='50%' valign='top' style='" + CARD + ";padding:14px'>" +
    "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Tiempo medio por nave</div>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" + naveTimeRows + "</table></td>";
  const colMuelle =
    "<td width='8'></td><td valign='top' style='" + CARD + ";padding:14px'>" +
    "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Tiempo medio por muelle</div>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" + muelleTimeRows + ahorroBlock + "</table></td>";
  const twoColNaves = "<table width='100%' cellpadding='0' cellspacing='0'><tr>" + colNave + colMuelle + "</tr></table>";

  // ── 4 lanzadera cost cards ─────────────────────────────────────────
  const lanzCards = [1,2,3,4].map(n =>
    "<td style='padding:5px'><div style='" + CARD + ";padding:12px 6px;text-align:center'>" +
    "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px'>Lanzadera " + n + "</div>" +
    "<div style='font-size:17px;font-weight:700;color:" + (costePorLanz[n] > 0 ? "#1A1A1A" : "#ccc") + "'>" + (costePorLanz[n] > 0 ? formatEuro(costePorLanz[n]) : "—") + "</div>" +
    "</div></td>"
  ).join("");

  // ── 2 cols: coste nave | esperas mas caras ─────────────────────────
  let naveCosteRows = navesCostes.map(([nave, coste]) =>
    dataRow(esc(NAVE_NOMBRE[nave] || nave), formatEuro(coste))
  ).join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

  const esperasTh = "<tr style='background:#f5f5f5'>" +
    "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Lanz.</th>" +
    "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Nave</th>" +
    "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Muelle</th>" +
    "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Dur.</th>" +
    "<th style='padding:5px 8px;text-align:right;font-size:11px;color:#888;font-weight:600'>Coste</th></tr>";
  const esperasTr = topEsperas.map(s =>
    "<tr>" +
    "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>L" + s.numero + "</td>" +
    "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(NAVE_NOMBRE[s.nave] || s.nave || "?") + "</td>" +
    "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(s.muelle || "—") + "</td>" +
    "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + formatDuracion(s.durMin) + "</td>" +
    "<td style='padding:5px 8px;font-size:12px;font-weight:700;color:#D41F3A;text-align:right;border-bottom:1px solid #f5f5f5'>" + formatEuro(s.coste) + "</td>" +
    "</tr>"
  ).join("");

  const colNaveCoste =
    "<td width='35%' valign='top' style='" + CARD + ";padding:14px'>" +
    "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Coste por nave</div>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" + naveCosteRows + "</table></td>";
  const colEsperas =
    "<td width='8'></td><td valign='top' style='" + CARD + ";padding:14px'>" +
    "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Esperas mas caras</div>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" + esperasTh + esperasTr + "</table></td>";
  const twoColCostes = "<table width='100%' cellpadding='0' cellspacing='0'><tr>" + colNaveCoste + colEsperas + "</tr></table>";

  // ── assemble ──────────────────────────────────────────────────────
  const html =
    "<!DOCTYPE html><html><body style='margin:0;padding:0;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif'>" +
    "<div style='max-width:700px;margin:0 auto;padding:16px 10px'>" +

    "<div style='background:#D41F3A;border-radius:8px;padding:20px 22px;margin-bottom:12px'>" +
    "<div style='color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px'>Aldelis</div>" +
    "<div style='color:rgba(255,255,255,.8);font-size:12px;margin-top:2px'>Informe de costes de operacion &middot; " + fechaFmt + "</div>" +
    "</div>" +

    metricRow +

    "<div style='height:10px'></div>" + twoColNaves +

    "<div style='height:10px'></div>" +
    "<div style='" + CARD + ";padding:14px'>" +
    "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Costes de operacion</div>" +
    "<table width='100%' cellpadding='0' cellspacing='0'><tr>" + lanzCards + "</tr></table>" +
    "</div>" +

    "<div style='height:10px'></div>" + twoColCostes +

    "<div style='height:14px'></div>" +
    "<div style='text-align:center;font-size:11px;color:#aaa'>Los costes reflejan el coste de operacion del dia, no el importe fijo del contrato.</div>" +

    "</div></body></html>";

  const cuerpo = "Informe de costes " + fechaFmt + " — Total operaciones: " + formatEuro(costeTotal);
  return { fechaFmt, costeTotal, cuerpo, html };
}

function _cargarHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://html2canvas.hertzen.com/dist/html2canvas.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function enviarInformeDiarioCostes(esAuto) {
  const emails = _costesEmailsCache;
  if (!emails.length) return;

  // Asegura que el historial está renderizado (lee de window._logs)
  cargarHistorialDiario();

  const datos = construirCuerpoInformeCostes();
  if (!datos) return;

  const asunto = "Informe de costes Lanzaderas — " + datos.fechaFmt + " — " + formatEuro(datos.costeTotal);
  let html = datos.html; // fallback tabla

  try {
    await _cargarHtml2Canvas();

    const el = document.getElementById('costes-historial');
    const isDark = document.getElementById('admin-body').classList.contains('dark');
    const bg = isDark ? '#0F0F11' : '#F5F5F5';

    // Clon off-screen a ancho fijo para captura consistente
    const clone = document.createElement('div');
    clone.style.cssText = 'position:fixed;left:-9999px;top:0;width:960px;padding:16px;box-sizing:border-box;background:' + bg + ';z-index:-9999';
    clone.innerHTML = el.innerHTML;
    document.body.appendChild(clone);

    try {
      const canvas = await window.html2canvas(clone, {
        scale: 1.5,
        backgroundColor: bg,
        logging: false,
        useCORS: false
      });
      if (canvas.height > 50) {
        // Subir a Storage para obtener URL pública (base64 bloqueado por Gmail)
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        const fecha = document.getElementById("fecha-dashboard").value;
        const ref = firebase.storage().ref("informes/costes-" + fecha + ".png");
        await ref.put(blob, { contentType: 'image/png', cacheControl: 'public,max-age=86400' });
        const imgUrl = await ref.getDownloadURL();
        html =
          "<!DOCTYPE html><html><body style='margin:0;padding:16px;background:#f0f0f0;font-family:Arial,Helvetica,sans-serif'>" +
          "<div style='max-width:960px;margin:0 auto'>" +
          "<div style='background:#D41F3A;border-radius:8px 8px 0 0;padding:18px 22px'>" +
          "<div style='color:#fff;font-size:18px;font-weight:700;letter-spacing:-.5px'>Aldelis</div>" +
          "<div style='color:rgba(255,255,255,.8);font-size:12px;margin-top:2px'>Informe de costes &middot; " + datos.fechaFmt + "</div>" +
          "</div>" +
          "<img src='" + imgUrl + "' style='width:100%;display:block' alt='Informe de costes'>" +
          "<p style='text-align:center;font-size:11px;color:#aaa;margin:10px 0 0'>Costes de operacion del dia (no importe fijo del contrato).</p>" +
          "</div></body></html>";
      }
    } finally {
      document.body.removeChild(clone);
    }
  } catch(e) {
    console.warn("html2canvas falló, usando HTML tabla:", e.message);
  }

  try {
    await Promise.all(emails.map(to => enviarEmailMS(to, asunto, datos.cuerpo, html)));
    const hora = new Date().getHours().toString().padStart(2,"0") + ":" + new Date().getMinutes().toString().padStart(2,"0");
    const hoy = new Date().toISOString().split("T")[0];
    localStorage.setItem("costesEnviados_" + hoy, hora);
    actualizarUltimoEnvio();
    if (!esAuto) {
      const ok = document.getElementById("costes-envio-ok");
      if (ok) { ok.style.display = ""; setTimeout(() => { ok.style.display = "none"; }, 3000); }
    }
  } catch(e) {
    console.error("Error enviando informe costes:", e);
  }
}

function autoEnviarCostesAlFinalDelDia() {
  if (!COSTES_USERS.includes(((auth.currentUser || {}).email || "").toLowerCase())) return;
  if (!esHoy) return;
  const ahora = new Date();
  if (ahora.getHours() < 23 || ahora.getMinutes() < 59) return;
  const hoy = ahora.toISOString().split("T")[0];
  if (localStorage.getItem("costesEnviados_" + hoy)) return;
  localStorage.setItem("costesEnviados_" + hoy, "auto");
  enviarInformeDiarioCostes(true);
}

// ─── LINEA DE TIEMPO (GANTT) DE LANZADERAS ───────────────────────────
function minToHHMM(min) {
  const h = Math.floor(min / 60) % 24, m = Math.round(min) % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function ganttNow() {
  if (!esHoy) return "";
  const nl = (ahoraMin - G_INI) * G_PXMIN;
  if (nl < 0 || nl > G_W) return "";
  return "<div class='gantt-now' style='left:" + nl + "px'></div>";
}

function ganttBarra(startMin, endMin, color, label, info) {
  const a = Math.max(startMin, G_INI), b = Math.min(endMin, G_FIN);
  if (b <= a) return "";
  const left = (a - G_INI) * G_PXMIN;
  const w = Math.max((b - a) * G_PXMIN, 14);
  return "<div class='gantt-bar' style='left:" + left + "px;width:" + w + "px;background:" + color + "' data-info='" + esc(info) + "' title='" + esc(info) + "'>" +
    "<span class='gantt-bar-txt'>" + esc(label) + "</span></div>";
}

function renderGanttLanz(segs, trans, finMarks) {
  const cont = document.getElementById("gantt-lanz");
  if (!cont) return;

  let head = "<div class='gantt-track gantt-head-track' style='width:" + G_W + "px'>";
  for (let h = 4; h <= 24; h++) {
    const left = (h * 60 - G_INI) * G_PXMIN;
    head += "<div class='gantt-tick' style='left:" + left + "px'>" + String(h % 24).padStart(2, "0") + ":00</div>";
  }
  head += ganttNow() + "</div>";

  let tracks = "";
  let labels = "<div class='gantt-lab gantt-lab-head'>Hora</div>";
  for (let n = 1; n <= 4; n++) {
    labels += "<div class='gantt-lab'>Lanzadera " + n + "</div>";
    let bars = "";
    segs.filter(s => s.numero === n).forEach(s => {
      let lbl = NAVE_NOMBRE[s.nave] || s.nave;
      if (s.nave === "plaza" && s.muelle) lbl += " " + (s.accion === "cargando" ? "⬆" : "⬇") + s.muelle;
      else if (s.nave === "merca" && s.muelle) lbl += " " + s.muelle;
      const info = "Lanzadera " + n + " · " + lbl + "\nDe " + minToHHMM(s.startMin) + " a " + minToHHMM(s.endMin);
      bars += ganttBarra(s.startMin, s.endMin, "#1D9E75", lbl, info);
    });
    trans.filter(s => s.numero === n).forEach(s => {
      const dest = NAVE_NOMBRE[s.destino] || s.destino || "?";
      const info = "Lanzadera " + n + " · en transito → " + dest + "\nDe " + minToHHMM(s.startMin) + " a " + minToHHMM(s.endMin);
      bars += ganttBarra(s.startMin, s.endMin, "#F59E0B", "→ " + dest, info);
    });
    finMarks.filter(m => m.numero === n).forEach(m => {
      const left = (m.atMin - G_INI) * G_PXMIN;
      if (left >= 0 && left <= G_W) bars += "<div class='gantt-fin' style='left:" + left + "px' title='Fin de jornada " + minToHHMM(m.atMin) + "' data-info='Lanzadera " + n + " · fin de jornada " + minToHHMM(m.atMin) + "'></div>";
    });
    tracks += "<div class='gantt-track' style='width:" + G_W + "px'>" + bars + ganttNow() + "</div>";
  }

  cont.innerHTML =
    "<div class='gantt-wrap'>" +
      "<div class='gantt-labels'>" + labels + "</div>" +
      "<div class='gantt-scroll2'>" + head + tracks + "</div>" +
    "</div>" +
    "<div class='gantt-resumen'>" + resumenEstado(segs, trans, finMarks) + "</div>";

  if (esHoy) {
    const sc = cont.querySelector(".gantt-scroll2");
    const nl = (ahoraMin - G_INI) * G_PXMIN;
    if (sc && nl >= 0) sc.scrollLeft = Math.max(0, nl - sc.clientWidth / 2);
  }

  revisarAlertas(segs, trans, finMarks);
}

let ADMINS_ALERTA = [
  "arento@aldelis.com",
  "almacen@aldelis.com",
  "expediciones@aldelis.com",
  "transfriorza@transfriorza.es",
  "mlorente@aldelis.com",
  "almacenfrio@aldelis.com",
  "garita@aldelis.com",
  "jbotaya@aldelis.com",
  "almacenseco@aldelis.com",
  "nchavarria@aldelis.com",
  "jpina@aldelis.com",
  "dgamarra@aldelis.com"
];
let _tiempoMaxLanz = 90; // minutos para alerta email; banner a los +30 min

// IDs de alertas ya notificadas en esta sesion (evita spam cada 30s)
const _alertasEmailEnviadas = new Set();

// Alerta nuclear: banner a las 2h, correo a la hora y media
function revisarAlertas(segs, trans, finMarks) {
  const alertas = [];      // para el banner rojo (>= 2h)
  const emailCand = [];     // para el correo (cruce de 1h30)
  if (esHoy) {
    for (let n = 1; n <= 4; n++) {
      let best = null;
      segs.filter(s => s.numero === n).forEach(s => { if (!best || s.startMin > best.start) best = { start: s.startMin, tipo: "nave", nave: s.nave, muelle: s.muelle, accion: s.accion }; });
      trans.filter(s => s.numero === n).forEach(s => { if (!best || s.startMin > best.start) best = { start: s.startMin, tipo: "transito" }; });
      finMarks.filter(m => m.numero === n).forEach(m => { if (!best || m.atMin > best.start) best = { start: m.atMin, tipo: "fin" }; });
      if (best && best.tipo === "nave") {
        const el = ahoraMin - best.start;
        let lbl = NAVE_NOMBRE[best.nave] || best.nave;
        if (best.nave === "plaza" && best.muelle) lbl += " " + (best.accion === "cargando" ? "⬆" : "⬇") + best.muelle;
        else if (best.nave === "merca" && best.muelle) lbl += " " + best.muelle;
        if (el >= _tiempoMaxLanz + 30) alertas.push({ n: n, lbl: lbl, el: el });
        if (el >= _tiempoMaxLanz)      emailCand.push({ n: n, lbl: lbl, el: el });
      }
    }
  }
  const banner = document.getElementById("alerta-nuclear");
  if (banner) {
    if (alertas.length) {
      banner.innerHTML = alertas.map(a => "🚨 ALERTA: Lanzadera " + a.n + " lleva " + formatDuracion(a.el) + " en " + esc(a.lbl)).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
      banner.style.display = "block";
    } else {
      banner.style.display = "none";
    }
  }
  const tab = document.getElementById("btn-vista-lanzaderas");
  if (tab) tab.classList.toggle("tab-alerta", alertas.length > 0 && !tab.classList.contains("active"));

  // Enviar email solo la primera vez que se detecta cada alerta.
  // Solo si la lanzadera acaba de cruzar el umbral de 1h30 estando el panel
  // vigilando (ventana 90-150 min). Asi evitamos avisos de registros viejos
  // u olvidos de salida que aparecen ya con 8h+ al abrir el panel.
  const alertaIds = new Set(emailCand.map(a => "lanz" + a.n));
  emailCand.forEach(a => {
    const id = "lanz" + a.n;
    if (!_alertasEmailEnviadas.has(id) && a.el >= _tiempoMaxLanz && a.el <= _tiempoMaxLanz + 60) {
      _alertasEmailEnviadas.add(id);
      const asunto = "ALERTA Aldelis — Lanzadera " + a.n + " lleva mas de hora y media en " + a.lbl;
      const cuerpo =
        "ALERTA de Aldelis Muelles\n\n" +
        "La Lanzadera " + a.n + " lleva mas de hora y media parada en " + a.lbl + ".\n\n" +
        "Revisa el panel:\nhttps://aldelis-muelles.web.app/admin.html\n\n" +
        "Aldelis — Gestion de muelles";
      ADMINS_ALERTA.forEach(to => enviarEmailMS(to, asunto, cuerpo));
    } else if (!_alertasEmailEnviadas.has(id) && a.el > 150) {
      // Registro viejo / salida sin registrar: marcar como notificado para no
      // mandar correo, pero seguir mostrando el banner en pantalla.
      _alertasEmailEnviadas.add(id);
    }
  });
  // Si la alerta se resuelve, permitir reenvio si vuelve a ocurrir
  _alertasEmailEnviadas.forEach(id => { if (!alertaIds.has(id)) _alertasEmailEnviadas.delete(id); });
}

function resumenEstado(segs, trans, finMarks) {
  let html = "<div class='gantt-res-tit'>Estado actual</div><div class='gantt-res-grid'>";
  for (let n = 1; n <= 4; n++) {
    let best = null;
    segs.filter(s => s.numero === n).forEach(s => {
      if (!best || s.startMin > best.start) {
        let t = NAVE_NOMBRE[s.nave] || s.nave;
        if (s.nave === "plaza" && s.muelle) t += " " + (s.accion === "cargando" ? "⬆" : "⬇") + s.muelle;
        else if (s.nave === "merca" && s.muelle) t += " " + s.muelle;
        best = { start: s.startMin, txt: "en " + t, color: "#1D9E75", esNave: true };
      }
    });
    trans.filter(s => s.numero === n).forEach(s => {
      if (!best || s.startMin > best.start) best = { start: s.startMin, txt: "en transito → " + (NAVE_NOMBRE[s.destino] || s.destino || "?"), color: "#F59E0B" };
    });
    finMarks.filter(m => m.numero === n).forEach(m => {
      if (!best || m.atMin > best.start) best = { start: m.atMin, txt: "fin de jornada", color: "#D41F3A" };
    });
    let cuerpo;
    if (!best) {
      cuerpo = "<span class='gantt-res-desde'>sin actividad hoy</span>";
    } else {
      const el = best.esNave && esHoy ? (ahoraMin - best.start) : -1;
      const alerta = el >= 120;
      const color = alerta ? "#D41F3A" : best.color;
      cuerpo = "<span style='color:" + color + ";font-weight:600'>" + esc(best.txt) + "</span> " +
        "<span class='gantt-res-desde'>desde " + minToHHMM(best.start) + "</span>" +
        (alerta ? " <span style='color:#D41F3A;font-weight:800'>🚨 " + formatDuracion(el) + "</span>" : "");
    }
    html += "<div class='gantt-res-item'><span class='gantt-res-n'>Lanzadera " + n + "</span> " + cuerpo + "</div>";
  }
  return html + "</div>";
}

function horaDesde(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  const hhmm = d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  return hhmm + " (" + (min < 1 ? "ahora" : "hace " + min + " min") + ")";
}

// ─── VISTA CARGAS (rejilla Muelles 1-5 x franjas) ────────────────────
function spanOcupa(iniTs, finTs, fa, fb, dayStart) {
  if (!iniTs) return false;
  const s = (iniTs.toMillis() - dayStart) / 60000;
  const e = finTs ? (finTs.toMillis() - dayStart) / 60000 : (esHoy ? (Date.now() - dayStart) / 60000 : 1440);
  return s < fb && e > fa;
}

function cargarCargas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const cargas = window._cargas || [];
  const lanzCarga = lanzaderaSegmentos(dayStart, dayEnd, "cargando");

  const filas = MUELLES_CARGA.map(m => ({ id: m, label: m }));
  pintarRejilla("rejilla-cargas", "Muelle", filas, FRANJAS_CARGAS, (fila, f, now) => {
    const r = franjaRango(f);
    const cs = cargas.filter(x => x.muelle === fila.id && spanOcupa(x.inicio, x.fin, r[0], r[1], dayStart));
    if (cs.length === 0) {
      const lz = lanzCarga.find(s => s.muelle === fila.id && s.startMin < r[1] && s.endMin > r[0]);
      if (lz) {
        return "<td class='slot-td" + now + "' style='background:#7C3AED' title='Lanzadera " + lz.numero + " (carga)'>" +
          "<div class='slot-empresa'>L" + lz.numero + "</div><div class='slot-estado'>lanzad.</div></td>";
      }
      return "<td class='slot-td slot-libre" + now + "'></td>";
    }
    if (cs.length === 1) {
      const c = cs[0];
      const color = c.estado === "completada" ? "#6B7280" : "#185FA5";
      return "<td class='slot-td" + now + "' style='background:" + color + ";cursor:pointer;'" +
        " onclick=\"abrirCargaDetalle('" + c.id + "')\"" +
        " title='" + esc(c.matricula_tractora + (c.destino ? " -> " + c.destino : "")) + "'>" +
        "<div class='slot-empresa'>" + esc(c.matricula_tractora) + "</div>" +
        "<div class='slot-estado'>" + esc(c.estado) + "</div></td>";
    }
    return "<td class='slot-td slot-multi" + now + "'>" + cs.map(c => {
      const color = c.estado === "completada" ? "#6B7280" : "#185FA5";
      return "<div class='slot-mini' onclick=\"abrirCargaDetalle('" + c.id + "')\" style='background:" + color + ";cursor:pointer;' title='" + esc(c.matricula_tractora) + " (" + esc(c.estado) + ")'>" + esc(c.matricula_tractora) + "</div>";
    }).join("") + "</td>";
  });
}

function abrirCargaDetalle(id) {
  const c = (window._cargas || []).find(x => x.id === id);
  if (!c) return;
  document.getElementById("cd-sub").textContent =
    "Muelle " + (c.muelle || "").replace("M", "") + " · " + (c.estado || "");
  const rows = [
    ["Matricula tractora", c.matricula_tractora || "—"],
    ["Matricula semi", c.matricula_semi || "—"],
    ["Chofer", c.chofer || "—"],
    ["DNI", c.dni || "—"],
    ["Destino", c.destino || "—"],
    ["Muelle", c.muelle || "—"],
    ["Estado", c.estado || "—"],
    ["Inicio", c.inicio ? tsHora(c.inicio) : "—"],
    ["Fin", c.fin ? tsHora(c.fin) : "—"]
  ];
  document.getElementById("cd-datos").innerHTML = rows.map(r =>
    "<div class='resumen-row'><span class='resumen-label'>" + r[0] + "</span><span class='resumen-value'>" + esc(r[1]) + "</span></div>"
  ).join("");
  document.getElementById("cd-acciones").innerHTML = c.estado === "cargando"
    ? "<button class='btn-confirm' onclick=\"completarCarga('" + c.id + "')\">Marcar como completada</button>"
    : "";
  document.getElementById("carga-detalle-modal").style.display = "flex";
}

function cerrarCargaDetalle(e) {
  if (!e || e.target.id === "carga-detalle-modal") document.getElementById("carga-detalle-modal").style.display = "none";
}

async function completarCarga(id) {
  if (!confirm("¿Marcar esta carga como completada?")) return;
  try {
    await db.collection("cargas").doc(id).update({ estado: "completada", fin: firebase.firestore.Timestamp.now() });
    cerrarCargaDetalle();
    cargarCargas();
  } catch (e) { console.error(e); alert("Error al completar la carga."); }
}

function abrirCargaModal() {
  document.getElementById("cm-muelle").innerHTML =
    "<option value=''>Selecciona muelle</option>" +
    MUELLES_CARGA.map(m => "<option value='" + m + "'>Muelle " + m.replace("M", "") + "</option>").join("");
  ["cm-tractora", "cm-semi", "cm-chofer", "cm-dni", "cm-destino"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("carga-modal").style.display = "flex";
}

function cerrarCargaModal(e) {
  if (!e || e.target.id === "carga-modal") document.getElementById("carga-modal").style.display = "none";
}

async function registrarCargaAlmacen() {
  const tractora = document.getElementById("cm-tractora").value.trim().toUpperCase();
  const muelle   = document.getElementById("cm-muelle").value;
  if (!tractora) { alert("Falta la matricula tractora."); return; }
  if (!muelle)   { alert("Selecciona el muelle."); return; }
  try {
    await db.collection("cargas").add({
      matricula_tractora: tractora,
      matricula_semi:     document.getElementById("cm-semi").value.trim().toUpperCase(),
      chofer:             document.getElementById("cm-chofer").value.trim(),
      dni:                document.getElementById("cm-dni").value.trim().toUpperCase(),
      destino:            document.getElementById("cm-destino").value.trim(),
      muelle:             muelle,
      estado:             "cargando",
      inicio:             firebase.firestore.Timestamp.now(),
      fin:                null,
      created_at:         firebase.firestore.Timestamp.now()
    });
    cerrarCargaModal();
    cargarCargas();
  } catch (e) { console.error(e); alert("Error al registrar la carga."); }
}

// ─── DESCARGAS DE PROVEEDORES EN MERCA ───────────────────────────────
function cargarMerca() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const items = window._merca || [];
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const lanzMerca = lanzaderaSegmentos(dayStart, dayEnd, null, "merca");
  const filas = MUELLES_MERCA.map(m => ({ id: m, label: "Muelle " + m.replace("M", "") }));
  pintarRejilla("rejilla-merca", "Muelle", filas, FRANJAS_CARGAS, (fila, f, now) => {
    const r = franjaRango(f);
    const cs = items.filter(x => x.muelle === fila.id && spanOcupa(x.inicio, x.fin, r[0], r[1], dayStart));
    if (cs.length === 0) {
      const lz = lanzMerca.find(s => s.muelle === fila.id && s.startMin < r[1] && s.endMin > r[0]);
      if (lz) {
        return "<td class='slot-td" + now + "' style='background:#7C3AED' title='Lanzadera " + lz.numero + " en Merca'>" +
          "<div class='slot-empresa'>L" + lz.numero + "</div><div class='slot-estado'>lanzad.</div></td>";
      }
      return "<td class='slot-td slot-libre" + now + "'></td>";
    }
    if (cs.length === 1) {
      const c = cs[0];
      const color = c.estado === "completada" ? "#6B7280" : "#1D9E75";
      const click = c.estado === "descargando" ? " onclick=\"completarMerca('" + c.id + "')\"" : "";
      const cur = c.estado === "descargando" ? "cursor:pointer;" : "";
      return "<td class='slot-td" + now + "' style='background:" + color + ";" + cur + "'" + click +
        " title='" + esc((c.empresa || "") + (c.mercancia ? " · " + c.mercancia : "")) + "'>" +
        "<div class='slot-empresa'>" + esc((c.empresa || "").split(" ")[0]) + "</div>" +
        "<div class='slot-estado'>" + esc(c.estado) + "</div></td>";
    }
    return "<td class='slot-td slot-multi" + now + "'>" + cs.map(c => {
      const color = c.estado === "completada" ? "#6B7280" : "#1D9E75";
      const click = c.estado === "descargando" ? " onclick=\"completarMerca('" + c.id + "')\"" : "";
      const cur = c.estado === "descargando" ? "cursor:pointer;" : "";
      return "<div class='slot-mini'" + click + " style='background:" + color + ";" + cur + "' title='" + esc((c.empresa || "")) + " (" + esc(c.estado) + ")'>" + esc((c.empresa || "").split(" ")[0]) + "</div>";
    }).join("") + "</td>";
  });
}

async function completarMerca(id) {
  if (!confirm("¿Marcar esta descarga como completada?")) return;
  try {
    await db.collection("descargas_merca").doc(id).update({ estado: "completada", fin: firebase.firestore.Timestamp.now() });
  } catch (e) { console.error(e); alert("Error al completar la descarga."); }
}

function abrirMercaModal() {
  document.getElementById("mm-muelle").innerHTML =
    "<option value=''>Selecciona muelle</option>" +
    MUELLES_MERCA.map(m => "<option value='" + m + "'>Muelle " + m.replace("M", "") + "</option>").join("");
  ["mm-empresa", "mm-matricula", "mm-mercancia", "mm-pales"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("merca-modal").style.display = "flex";
}

function cerrarMercaModal(e) {
  if (!e || e.target.id === "merca-modal") document.getElementById("merca-modal").style.display = "none";
}

async function registrarMercaAlmacen() {
  const empresa   = document.getElementById("mm-empresa").value.trim();
  const matricula = document.getElementById("mm-matricula").value.trim().toUpperCase();
  const muelle    = document.getElementById("mm-muelle").value;
  if (!empresa)   { alert("Falta la empresa / proveedor."); return; }
  if (!matricula) { alert("Falta la matricula."); return; }
  if (!muelle)    { alert("Selecciona el muelle."); return; }
  const palesV = document.getElementById("mm-pales").value.trim();
  try {
    await db.collection("descargas_merca").add({
      empresa: empresa,
      matricula: matricula,
      mercancia: document.getElementById("mm-mercancia").value.trim(),
      pales: palesV ? Number(palesV) : null,
      muelle: muelle,
      estado: "descargando",
      inicio: firebase.firestore.Timestamp.now(),
      fin: null,
      created_at: firebase.firestore.Timestamp.now()
    });
    cerrarMercaModal();
  } catch (e) { console.error(e); alert("Error al registrar la descarga."); }
}

// ─── INCIDENCIAS BIZERBA ─────────────────────────────────────────────
const LINEAS_BIZERBA = Array.from({ length: 17 }, (_, i) => i); // 0..16

function difMin(a, b) { // minutos entre dos timestamps (b - a)
  if (!a || !b) return null;
  return Math.round((b.toMillis() - a.toMillis()) / 60000);
}

function estadoLabel(e) {
  return { abierta: "Abierta", aceptada: "En curso", repuesto: "Falta repuesto", resuelta: "Resuelta" }[e] || e;
}

function cargarBizerba() {
  const inc = window._incidencias || [];
  const abiertas  = inc.filter(i => i.estado === "abierta");
  const aceptadas = inc.filter(i => i.estado === "aceptada");
  const repuesto  = inc.filter(i => i.estado === "repuesto");
  const resueltas = inc.filter(i => i.estado === "resuelta");

  document.getElementById("biz-abiertas").textContent  = abiertas.length;
  document.getElementById("biz-curso").textContent     = aceptadas.length;
  document.getElementById("biz-repuesto").textContent  = repuesto.length;
  document.getElementById("biz-resueltas").textContent = resueltas.length;

  const resps = inc.filter(i => i.aceptada && i.creada).map(i => difMin(i.creada, i.aceptada));
  const media = resps.length ? Math.round(resps.reduce((a, b) => a + b, 0) / resps.length) : null;
  document.getElementById("biz-resp").textContent = media != null ? formatDuracion(media) : "—";

  // Incidencias activas (sin coger + en curso + esperando repuesto), por antiguedad
  const activas = abiertas.concat(aceptadas, repuesto).sort((a, b) => (a.creada ? a.creada.toMillis() : 0) - (b.creada ? b.creada.toMillis() : 0));
  const cont = document.getElementById("biz-activas");
  if (!activas.length) {
    cont.innerHTML = "<div class='empty-state'>No hay incidencias activas.</div>";
  } else {
    cont.innerHTML = activas.map(i => {
      const espera  = i.creada ? difMin(i.creada, firebase.firestore.Timestamp.now()) : null;
      const enCurso = i.aceptada ? difMin(i.aceptada, firebase.firestore.Timestamp.now()) : null;
      let color, estLbl, pill;
      if (i.estado === "abierta") {
        color = "#D41F3A"; pill = "Abierta";
        estLbl = "Sin coger · espera " + (espera != null ? formatDuracion(espera) : "—");
      } else if (i.estado === "repuesto") {
        color = "#E08A00"; pill = "Falta repuesto";
        estLbl = "Tecnico " + (i.tecnico || "?") + " · esperando repuesto";
      } else {
        color = "#1D9E75"; pill = "En curso";
        estLbl = "Tecnico " + (i.tecnico || "?") + " · lleva " + (enCurso != null ? formatDuracion(enCurso) : "—");
      }
      const obs = i.observaciones
        ? "<div class='reserva-detalle' style='font-style:italic'>“" + esc(i.observaciones) + "”</div>" : "";
      const btn = i.estado === "abierta"
        ? ""
        : "<button class='btn-accion btn-completar' onclick=\"resolverIncidencia('" + i.id + "')\">Resuelta</button>";
      return "<div class='reserva-item'>" +
        "<div class='reserva-hora' style='color:" + color + "'>Linea " + i.linea + "</div>" +
        "<div class='reserva-info'>" +
        "<div class='reserva-empresa'>" + esc(i.averia || "Sin detalle") + "</div>" +
        "<div class='reserva-detalle'>" + estLbl + "</div>" + obs + "</div>" +
        "<div style='display:flex;flex-direction:column;gap:6px;align-items:flex-end'>" +
        "<span class='estado-pill' style='background:" + color + ";color:#fff'>" + pill + "</span>" +
        btn + "</div></div>";
    }).join("");
  }

  // Historial del dia
  const tabla = document.getElementById("biz-tabla");
  if (!inc.length) {
    tabla.innerHTML = "<div class='empty-state'>Sin incidencias hoy.</div>";
  } else {
    const filas = inc.slice().sort((a, b) => (b.creada ? b.creada.toMillis() : 0) - (a.creada ? a.creada.toMillis() : 0));
    tabla.innerHTML = "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr>" +
      "<th>Linea</th><th>Averia</th><th>Estado</th><th>Tecnico</th><th>Observaciones</th><th>Emitida</th><th>Cogida</th><th>Resuelta</th><th>T. respuesta</th><th>T. resolucion</th>" +
      "</tr></thead><tbody>" +
      filas.map(i => {
        const tResp = difMin(i.creada, i.aceptada);
        const tReso = difMin(i.aceptada, i.resuelta);
        return "<tr><td>" + i.linea + "</td><td>" + esc(i.averia || "—") + "</td>" +
          "<td>" + esc(estadoLabel(i.estado)) + "</td><td>" + (i.tecnico ? "T" + i.tecnico : "—") + "</td>" +
          "<td>" + esc(i.observaciones || "—") + "</td>" +
          "<td>" + (i.creada ? tsHora(i.creada) : "—") + "</td>" +
          "<td>" + (i.aceptada ? tsHora(i.aceptada) : "—") + "</td>" +
          "<td>" + (i.resuelta ? tsHora(i.resuelta) : "—") + "</td>" +
          "<td>" + (tResp != null ? formatDuracion(tResp) : "—") + "</td>" +
          "<td>" + (tReso != null ? formatDuracion(tReso) : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
}

async function resolverIncidencia(id) {
  if (!confirm("¿Marcar esta incidencia como resuelta?")) return;
  try {
    await db.collection("incidencias").doc(id).update({ estado: "resuelta", resuelta: firebase.firestore.Timestamp.now() });
  } catch (e) { console.error(e); alert("Error al actualizar la incidencia."); }
}

function abrirIncidenciaModal() {
  document.getElementById("inc-linea").innerHTML =
    "<option value=''>Selecciona linea</option>" +
    LINEAS_BIZERBA.map(l => "<option value='" + l + "'>Linea " + l + "</option>").join("");
  document.getElementById("inc-averia").value = "";
  document.getElementById("incidencia-modal").style.display = "flex";
}

function cerrarIncidenciaModal(e) {
  if (!e || e.target.id === "incidencia-modal") document.getElementById("incidencia-modal").style.display = "none";
}

async function crearIncidencia() {
  const lineaV = document.getElementById("inc-linea").value;
  const averia = document.getElementById("inc-averia").value.trim();
  if (lineaV === "") { alert("Selecciona la linea."); return; }
  if (!averia)       { alert("Describe la averia."); return; }
  try {
    await db.collection("incidencias").add({
      linea:    Number(lineaV),
      averia:   averia,
      estado:   "abierta",
      tecnico:  null,
      observaciones: "",
      creada:   firebase.firestore.Timestamp.now(),
      aceptada: null,
      resuelta: null,
      created_at: firebase.firestore.Timestamp.now()
    });
    cerrarIncidenciaModal();
  } catch (e) { console.error(e); alert("Error al abrir la incidencia."); }
}

// Informe de incidencias por rango de fechas + exportacion a Excel
async function cargarInformeBizerba() {
  const desde = document.getElementById("bz-desde").value;
  const hasta = document.getElementById("bz-hasta").value;
  if (!desde || !hasta) { alert("Selecciona el rango de fechas."); return; }
  const startTs = firebase.firestore.Timestamp.fromMillis(new Date(desde + "T00:00:00").getTime());
  const endTs   = firebase.firestore.Timestamp.fromMillis(new Date(hasta + "T23:59:59").getTime());
  const snap = await db.collection("incidencias")
    .where("creada", ">=", startTs).where("creada", "<=", endTs).get();
  const inc = [];
  snap.forEach(d => inc.push({ id: d.id, ...d.data() }));
  window._bizerbaInforme = inc;

  const cont = document.getElementById("bz-resultado");
  if (!inc.length) { cont.innerHTML = "<div class='empty-state'>Sin incidencias en el periodo.</div>"; return; }

  const resps = inc.filter(i => i.aceptada && i.creada).map(i => difMin(i.creada, i.aceptada));
  const resos = inc.filter(i => i.resuelta && i.aceptada).map(i => difMin(i.aceptada, i.resuelta));
  const mResp = resps.length ? Math.round(resps.reduce((a, b) => a + b, 0) / resps.length) : null;
  const mReso = resos.length ? Math.round(resos.reduce((a, b) => a + b, 0) / resos.length) : null;
  const resueltas = inc.filter(i => i.estado === "resuelta").length;

  let html = "<div class='informe-metricas'>" +
    "<div class='metric-card'><div class='metric-value'>" + inc.length + "</div><div class='metric-label'>Total incidencias</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + resueltas + "</div><div class='metric-label'>Resueltas</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + (mResp != null ? formatDuracion(mResp) : "—") + "</div><div class='metric-label'>T. medio respuesta</div></div>" +
    "<div class='metric-card'><div class='metric-value'>" + (mReso != null ? formatDuracion(mReso) : "—") + "</div><div class='metric-label'>T. medio resolucion</div></div>" +
    "</div>";

  const filas = inc.slice().sort((a, b) => (b.creada ? b.creada.toMillis() : 0) - (a.creada ? a.creada.toMillis() : 0));
  html += "<div class='informe-card'><div class='tabla-scroll'><table class='tabla-inf'><thead><tr>" +
    "<th>Fecha</th><th>Linea</th><th>Averia</th><th>Estado</th><th>Tecnico</th><th>Observaciones</th><th>Emitida</th><th>Cogida</th><th>Resuelta</th><th>T. resp.</th><th>T. resol.</th>" +
    "</tr></thead><tbody>" +
    filas.map(i => {
      const tResp = difMin(i.creada, i.aceptada);
      const tReso = difMin(i.aceptada, i.resuelta);
      return "<tr><td>" + (i.creada ? tsFecha(i.creada) : "—") + "</td><td>" + i.linea + "</td>" +
        "<td>" + esc(i.averia || "—") + "</td><td>" + esc(estadoLabel(i.estado)) + "</td>" +
        "<td>" + (i.tecnico ? "T" + i.tecnico : "—") + "</td>" +
        "<td>" + esc(i.observaciones || "—") + "</td>" +
        "<td>" + (i.creada ? tsHora(i.creada) : "—") + "</td>" +
        "<td>" + (i.aceptada ? tsHora(i.aceptada) : "—") + "</td>" +
        "<td>" + (i.resuelta ? tsHora(i.resuelta) : "—") + "</td>" +
        "<td>" + (tResp != null ? formatDuracion(tResp) : "—") + "</td>" +
        "<td>" + (tReso != null ? formatDuracion(tReso) : "—") + "</td></tr>";
    }).join("") + "</tbody></table></div></div>";
  cont.innerHTML = html;
}

function exportarBizerba() {
  const inc = window._bizerbaInforme || [];
  if (!inc.length) { alert("Primero consulta un periodo para exportar."); return; }
  const filas = inc.map(i => ({
    "Fecha":          i.creada ? tsFecha(i.creada) : "",
    "Linea":          i.linea,
    "Averia":         i.averia || "",
    "Estado":         estadoLabel(i.estado),
    "Tecnico":        i.tecnico ? "Tecnico " + i.tecnico : "",
    "Observaciones":  i.observaciones || "",
    "Emitida":        i.creada ? tsHora(i.creada) : "",
    "Cogida":         i.aceptada ? tsHora(i.aceptada) : "",
    "Resuelta":       i.resuelta ? tsHora(i.resuelta) : "",
    "T. respuesta (min)": difMin(i.creada, i.aceptada),
    "T. resolucion (min)": difMin(i.aceptada, i.resuelta)
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Incidencias");
  XLSX.writeFile(wb, "incidencias_bizerba.xlsx");
}

// ─── INDICACIONES A LANZADERAS ───────────────────────────────────────
function abrirNotaModal(numero) {
  const sel = document.getElementById("nota-lanz");
  sel.innerHTML = [1, 2, 3, 4].map(n => "<option value='" + n + "'>Lanzadera " + n + "</option>").join("");
  sel.value = String(numero || 1);
  document.getElementById("nota-modal").style.display = "flex";
  cargarNotaActual();
}
function cerrarNotaModal(e) {
  if (!e || e.target.id === "nota-modal") document.getElementById("nota-modal").style.display = "none";
}
async function cargarNotaActual() {
  const n = document.getElementById("nota-lanz").value;
  try {
    const doc = await db.collection("lanzaderas_nota").doc(n).get();
    document.getElementById("nota-texto").value = doc.exists ? (doc.data().nota || "") : "";
  } catch (e) { document.getElementById("nota-texto").value = ""; }
}
async function guardarNota() {
  const n = +document.getElementById("nota-lanz").value;
  const nota = document.getElementById("nota-texto").value.trim();
  try {
    await db.collection("lanzaderas_nota").doc(String(n)).set({ numero: n, nota: nota, urgente: false, actualizado: firebase.firestore.Timestamp.now() });
    cerrarNotaModal();
    alert("Indicacion guardada para Lanzadera " + n);
  } catch (e) { console.error(e); alert("Error al guardar la indicacion."); }
}

// ─── CHAT (gerencia) ─────────────────────────────────────────────────
function chatSeen(n) { return +(localStorage.getItem("chatSeen_" + n) || 0); }
function chatSetSeen(n, ms) { localStorage.setItem("chatSeen_" + n, String(ms)); }

// Nombre del emisor segun el email del usuario (para mostrar quien escribe).
// Anade aqui mas correos -> nombre a mostrar.
const EMISOR_NOMBRES = {
  "almacen@aldelis.com": "Almacen",
  "almacenfrio@aldelis.com": "Almacen frio",
  "almacenseco@aldelis.com": "Almacen seco",
  "expediciones@aldelis.com": "Expediciones",
  "transfriorza@transfriorza.es": "Transfriorza",
  "mlorente@aldelis.com": "M. Lorente",
  "jpina@aldelis.com": "J. Pina",
  "jbotaya@aldelis.com": "J. Botaya",
  "dgamarra@aldelis.com": "D. Gamarra",
  "nchavarria@aldelis.com": "N. Chavarria"
};
let _emisorActual = "Almacen";
function nombreEmisor(email) {
  email = (email || "").toLowerCase();
  if (EMISOR_NOMBRES[email]) return EMISOR_NOMBRES[email];
  const local = email.split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "Almacen";
}

// ─── AVISO SONORO DE CHAT ────────────────────────────────────────────
let _msgBeepInit = false, _msgBeepMaxTs = 0;
let _audioCtx = null;
function unlockAudio() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch (e) {}
}
document.addEventListener("click", unlockAudio);
document.addEventListener("keydown", unlockAudio);

function beep() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const t0 = _audioCtx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
      o.connect(g); g.connect(_audioCtx.destination);
      o.type = "sine"; o.frequency.value = freq;
      const start = t0 + i * 0.18;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      o.start(start); o.stop(start + 0.18);
    });
  } catch (e) {}
}

function selectChat(n) { _chatSel = n; renderChat(); }

// Etiqueta de dia para el chat: Hoy / Ayer / Antes de ayer / fecha
function diaChat(ts) {
  if (!ts) return "";
  const d = ts.toDate(); d.setHours(0, 0, 0, 0);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const dif = Math.round((hoy - d) / 86400000);
  if (dif === 0) return "Hoy";
  if (dif === 1) return "Ayer";
  if (dif === 2) return "Antes de ayer";
  return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}

function renderChat() {
  const thr = document.getElementById("chat-threads");
  if (!thr) return;
  const msgs = window._mensajes || [];

  let th = "";
  for (let n = 1; n <= 4; n++) {
    const delN = msgs.filter(m => m.lanzadera === n);
    const unread = delN.filter(m => m.de === "lanzadera" && m.ts && m.ts.toMillis() > chatSeen(n)).length;
    th += "<div class='chat-thread" + (n === _chatSel ? " sel" : "") + "' onclick='selectChat(" + n + ")'>" +
      "<span class='chat-thread-n'>Lanzadera " + n + "</span>" +
      (unread ? "<span class='chat-badge'>" + unread + "</span>" : "") + "</div>";
  }
  thr.innerHTML = th;

  const conv = msgs.filter(m => m.lanzadera === _chatSel);
  let _prevDia = null;
  document.getElementById("chat-msgs").innerHTML = conv.length
    ? conv.map(m => {
        const right = m.de === "almacen";
        const emisor = (right && m.emisor)
          ? "<span class='chat-emisor'>" + esc(m.emisor) + "</span>" : "";
        let sep = "";
        const dia = m.ts ? diaChat(m.ts) : "";
        if (dia && dia !== _prevDia) { sep = "<div class='chat-day'>" + dia + "</div>"; _prevDia = dia; }
        return sep + "<div class='chat-row " + (right ? "r" : "l") + "'><div class='chat-b " + (right ? "chat-b-out" : "chat-b-in") + "'>" +
          emisor + esc(m.texto) + "<span class='chat-time'>" + (m.ts ? tsHora(m.ts) : "") + "</span></div></div>";
      }).join("")
    : "<div class='empty-state' style='padding:20px'>Sin mensajes con Lanzadera " + _chatSel + "</div>";

  if (conv.length) { const last = conv[conv.length - 1]; if (last.ts) chatSetSeen(_chatSel, last.ts.toMillis()); }
  const mc = document.getElementById("chat-msgs"); mc.scrollTop = mc.scrollHeight;

  const quicks = ["Recibido", "Ve a Plaza", "Espera 10 min", "Llama al almacen"];
  document.getElementById("chat-quick").innerHTML =
    quicks.map(q => "<button class='chat-chip' onclick=\"enviarChatAlmacen('" + q + "')\">" + q + "</button>").join("");
}

async function enviarChatAlmacen(textoOpt) {
  const inp = document.getElementById("chat-text");
  const texto = (textoOpt != null ? textoOpt : inp.value).trim();
  if (!texto) return;
  try {
    await db.collection("mensajes").add({ lanzadera: _chatSel, de: "almacen", emisor: _emisorActual, texto: texto, ts: firebase.firestore.Timestamp.now() });
    if (textoOpt == null) inp.value = "";
  } catch (e) { console.error(e); alert("No se pudo enviar el mensaje."); }
}

async function enviarUrgencia() {
  const texto = prompt("Mensaje URGENTE para TODAS las lanzaderas:");
  if (texto == null) return;
  const t = texto.trim();
  if (!t) return;
  try {
    const ts = firebase.firestore.Timestamp.now();
    await Promise.all([1, 2, 3, 4].map(n =>
      db.collection("lanzaderas_nota").doc(String(n)).set({ numero: n, nota: t, urgente: true, actualizado: ts })
    ));
    alert("Urgencia enviada a todas las lanzaderas.");
  } catch (e) { console.error(e); alert("Error al enviar la urgencia."); }
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
  const MAX_DUR = 480; // 8h: por encima se considera "olvido de registrar la salida"
  Object.keys(porLanz).forEach(k => {
    const arr = porLanz[k].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "en_nave") viajes++;
      const next = arr[i + 1];
      if (!next) continue;
      const d1 = ev.desde.toDate(), d2 = next.desde.toDate();
      const dur = Math.round((d2 - d1) / 60000);
      // Descarta estancias rotas: negativas, de otro dia, o absurdamente largas (olvido)
      if (dur < 0 || dur > MAX_DUR || d1.toDateString() !== d2.toDateString()) continue;
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

// ─── Helpers de fecha/hora para exportar ─────────────────────────────
function tsFecha(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function tsHora(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ─── INFORME DE CARGAS ───────────────────────────────────────────────
async function cargarInformeCargas() {
  const desde = document.getElementById("cg-desde").value;
  const hasta = document.getElementById("cg-hasta").value;
  if (!desde || !hasta) { alert("Selecciona un rango de fechas."); return; }

  const startTs = firebase.firestore.Timestamp.fromDate(new Date(desde + "T00:00:00"));
  const endTs   = firebase.firestore.Timestamp.fromDate(new Date(hasta + "T23:59:59"));
  const snap = await db.collection("cargas")
    .where("inicio", ">=", startTs).where("inicio", "<=", endTs).get();
  const cargas = [];
  snap.forEach(d => cargas.push({ id: d.id, ...d.data() }));
  window._cargasInforme = cargas;

  const cont = document.getElementById("cg-resultado");
  if (!cargas.length) { cont.innerHTML = "<div class='empty-state'>Sin cargas en el periodo.</div>"; return; }

  const completadas = cargas.filter(c => c.fin);
  const durs = completadas.map(c => Math.round((c.fin.toMillis() - c.inicio.toMillis()) / 60000)).filter(x => x >= 0);
  const medio = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;

  const porHora = {};
  cargas.forEach(c => { const h = (c.inicio.toDate ? c.inicio.toDate() : new Date(c.inicio)).getHours(); porHora[h] = (porHora[h] || 0) + 1; });
  const horas = [];
  for (let h = 6; h <= 23; h++) horas.push([String(h).padStart(2, "0") + ":00", porHora[h] || 0]);

  cont.innerHTML =
    "<div class='informe-card'><div class='informe-card-title'>Resumen del periodo</div><div class='rendimiento-row'>" +
      "<div><div class='metric-value'>" + cargas.length + "</div><div class='metric-label'>Total cargas</div></div>" +
      "<div><div class='metric-value'>" + (medio != null ? formatDuracion(medio) : "—") + "</div><div class='metric-label'>Tiempo medio de carga</div></div>" +
      "<div><div class='metric-value'>" + completadas.length + "</div><div class='metric-label'>Completadas</div></div>" +
    "</div></div>" +
    "<div class='informe-card' style='margin-top:12px'><div class='informe-card-title'>Horas calientes (cargas por hora)</div>" + renderHeatmap(horas) + "</div>" +
    "<div class='informe-card' style='margin-top:12px'><div class='informe-card-title'>Listado de cargas del periodo</div>" + renderTablaCargas(cargas) + "</div>";
}

function renderTablaCargas(cargas) {
  let html = "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr>" +
    "<th>Fecha</th><th>Inicio</th><th>Fin</th><th>Duracion</th><th>Tractora</th><th>Semi</th><th>Chofer</th><th>Destino</th><th>Muelle</th><th>Estado</th></tr></thead><tbody>";
  cargas.slice().sort((a, b) => a.inicio.toMillis() - b.inicio.toMillis()).forEach(c => {
    const dur = c.fin ? formatDuracion(Math.round((c.fin.toMillis() - c.inicio.toMillis()) / 60000)) : "—";
    html += "<tr><td>" + esc(tsFecha(c.inicio)) + "</td><td>" + esc(tsHora(c.inicio)) + "</td>" +
      "<td>" + esc(c.fin ? tsHora(c.fin) : "—") + "</td><td>" + esc(dur) + "</td>" +
      "<td>" + esc(c.matricula_tractora || "") + "</td><td>" + esc(c.matricula_semi || "—") + "</td>" +
      "<td>" + esc(c.chofer || "—") + "</td><td>" + esc(c.destino || "—") + "</td>" +
      "<td>" + esc(c.muelle || "—") + "</td><td>" + esc(c.estado || "") + "</td></tr>";
  });
  return html + "</tbody></table></div>";
}

function exportarCargas() {
  const cargas = window._cargasInforme || [];
  if (!cargas.length) { alert("Primero consulta un periodo para exportar."); return; }
  const filas = cargas.map(c => ({
    "Fecha": tsFecha(c.inicio),
    "Hora inicio": tsHora(c.inicio),
    "Hora fin": c.fin ? tsHora(c.fin) : "",
    "Duracion": c.fin ? formatDuracion(Math.round((c.fin.toMillis() - c.inicio.toMillis()) / 60000)) : "",
    "Matricula tractora": c.matricula_tractora || "",
    "Matricula semi": c.matricula_semi || "",
    "Chofer": c.chofer || "",
    "DNI": c.dni || "",
    "Destino": c.destino || "",
    "Muelle": c.muelle || "",
    "Estado": c.estado || ""
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Cargas");
  XLSX.writeFile(wb, "Aldelis_Cargas_" + document.getElementById("cg-desde").value + "_" + document.getElementById("cg-hasta").value + ".xlsx");
}

async function exportarLanzaderas() {
  const desde = document.getElementById("lz-desde").value;
  const hasta = document.getElementById("lz-hasta").value;
  if (!desde || !hasta) { alert("Selecciona un rango de fechas."); return; }
  const startTs = firebase.firestore.Timestamp.fromDate(new Date(desde + "T00:00:00"));
  const endTs   = firebase.firestore.Timestamp.fromDate(new Date(hasta + "T23:59:59"));
  const snap = await db.collection("lanzaderas_log")
    .where("desde", ">=", startTs).where("desde", "<=", endTs).get();
  const logs = [];
  snap.forEach(d => logs.push(d.data()));
  if (!logs.length) { alert("Sin movimientos en el periodo."); return; }
  logs.sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
  const filas = logs.map(l => ({
    "Fecha": tsFecha(l.desde),
    "Hora": tsHora(l.desde),
    "Lanzadera": l.numero,
    "Estado": l.estado === "en_nave" ? "En nave" : "Transito",
    "Nave": NAVE_NOMBRE[l.nave] || l.nave || "",
    "Accion": l.accion || "",
    "Muelle": l.muelle || "",
    "Destino": l.destino ? (NAVE_NOMBRE[l.destino] || l.destino) : ""
  }));
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Lanzaderas");
  XLSX.writeFile(wb, "Aldelis_Lanzaderas_" + desde + "_" + hasta + ".xlsx");
}

function cargarReservas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const reservas = (window._reservas || []).slice().sort((a, b) => a.franja.localeCompare(b.franja));

  document.getElementById("m-total").textContent      = reservas.length;
  document.getElementById("m-pendientes").textContent  = reservas.filter(r => r.estado === "pendiente").length;
  document.getElementById("m-confirmadas").textContent = reservas.filter(r => r.estado === "confirmada").length;
  document.getElementById("m-curso").textContent       = reservas.filter(r => r.estado === "en_curso").length;

  const ds = new Date(fecha + "T00:00:00").getTime();
  window._lanzDescarga = lanzaderaSegmentos(ds, ds + 86400000, "descargando");
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
      if (hits.length === 1) {
        const r = hits[0]; const color = ESTADO_COLOR[r.estado] || "#9CA3AF";
        tbody += "<td class='slot-td" + now + "' data-id='" + r.id + "' data-muelle='" + muelle + "' style='background:" + color + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>" + esc(r.estado) + "</div></td>";
      } else if (hits.length > 1) {
        tbody += "<td class='slot-td slot-multi" + now + "'>" + hits.map(r => {
          const color = ESTADO_COLOR[r.estado] || "#9CA3AF";
          return "<div class='slot-mini' data-id='" + r.id + "' data-muelle='" + muelle + "' style='background:" + color + "' title='" + esc(r.empresa) + " (" + esc(r.estado) + ")'>" + esc(r.empresa.split(" ")[0]) + "</div>";
        }).join("") + "</td>";
      } else if (pend.length > 0) {
        const r = pend[0];
        tbody += "<td class='slot-td slot-pendiente" + now + "' data-id='" + r.id + "' data-muelle='" + muelle + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>pendiente</div></td>";
      } else {
        const fr = franjaRango(franja);
        const lz = (window._lanzDescarga || []).find(s => s.muelle === muelle && s.startMin < fr[1] && s.endMin > fr[0]);
        if (lz) {
          tbody += "<td class='slot-td" + now + "' style='background:#7C3AED' title='Lanzadera " + lz.numero + " (descarga)'>" +
            "<div class='slot-empresa'>L" + lz.numero + "</div><div class='slot-estado'>lanzad.</div></td>";
        } else {
          tbody += "<td class='slot-td slot-libre" + now + "'></td>";
        }
      }
    });
    tbody += "</tr>";
  });
  table.innerHTML = thead + tbody + "</tbody>";
  centrarFranjaActual(table);
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

function abrirModal(id, muellePre) {
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

  // Si se ha pulsado desde un muelle concreto, lo dejamos preseleccionado para aceptar ahi
  const preferido = (muellePre && m.indexOf(muellePre) !== -1) ? muellePre : (r.muelle && m.indexOf(r.muelle) !== -1 ? r.muelle : null);
  if (preferido) {
    document.getElementById("muelle-confirmar").value = preferido;
    document.getElementById("muelle-reasignar").value = preferido;
  }

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

// ─── PANEL DE CONFIGURACION (solo CONFIG_USERS) ───────────────────────────────

function cargarConfigListeners() {
  db.collection("config").doc("alertas").onSnapshot(d => {
    if (d.exists && Array.isArray(d.data().emails)) {
      ADMINS_ALERTA = d.data().emails;
    }
    renderCfgAlertas();
  }, () => {});

  db.collection("config").doc("app").onSnapshot(d => {
    if (d.exists) {
      const data = d.data();
      if (typeof data.tiempoMaxLanz === "number") _tiempoMaxLanz = data.tiempoMaxLanz;
      if (typeof data.diasLaborables === "number" && data.diasLaborables > 0) {
        _diasLaborables = data.diasLaborables;
        recalcLanzCosteMin();
      }
    }
    const elT = document.getElementById("cfg-tiempo-max");
    if (elT) elT.value = _tiempoMaxLanz;
    const elD = document.getElementById("cfg-dias-lab");
    if (elD) elD.value = _diasLaborables;
  }, () => {});

  db.collection("config").doc("destinos").onSnapshot(d => {
    if (d.exists && Array.isArray(d.data().lista)) {
      actualizarNavesPanel(d.data().lista);
    }
    renderCfgDestinos();
  }, () => {});
}

function actualizarNavesPanel(lista) {
  if (!lista || !lista.length) return;
  NAVES_PANEL.splice(0, NAVES_PANEL.length, ...lista);
  NAVES_PANEL.forEach(n => { NAVE_NOMBRE[n.id] = n.nombre; });
}

function cargarConfig() {
  renderCfgAlertas();
  renderCfgDestinos();
  const elT = document.getElementById("cfg-tiempo-max");
  if (elT) elT.value = _tiempoMaxLanz;
  const elD = document.getElementById("cfg-dias-lab");
  if (elD) elD.value = _diasLaborables;
}

function renderCfgAlertas() {
  const div = document.getElementById("cfg-alertas-lista");
  if (!div) return;
  if (!ADMINS_ALERTA.length) {
    div.innerHTML = "<p style='font-size:13px;color:#9CA3AF'>Sin destinatarios configurados.</p>";
    return;
  }
  div.innerHTML = ADMINS_ALERTA.map((email, i) =>
    "<div style='display:flex;align-items:center;gap:8px;margin-bottom:6px'>" +
    "<span style='flex:1;font-size:14px'>" + esc(email) + "</span>" +
    "<button class='btn-reject' style='padding:4px 10px;font-size:12px;cursor:pointer' onclick='eliminarEmailAlerta(" + i + ")'>Eliminar</button>" +
    "</div>"
  ).join("");
}

function renderCfgDestinos() {
  const div = document.getElementById("cfg-destinos-lista");
  if (!div) return;
  if (!NAVES_PANEL.length) {
    div.innerHTML = "<p style='font-size:13px;color:#9CA3AF'>Sin destinos configurados.</p>";
    return;
  }
  div.innerHTML = NAVES_PANEL.map((n, i) =>
    "<div style='display:flex;align-items:center;gap:8px;margin-bottom:6px'>" +
    "<span style='font-size:12px;color:#9CA3AF;width:110px;flex-shrink:0'>" + esc(n.id) + "</span>" +
    "<span style='flex:1;font-size:14px'>" + esc(n.nombre) + "</span>" +
    "<button class='btn-reject' style='padding:4px 10px;font-size:12px;cursor:pointer' onclick='eliminarDestino(" + i + ")'>Eliminar</button>" +
    "</div>"
  ).join("");
}

async function agregarEmailAlerta() {
  const inp = document.getElementById("cfg-alerta-email");
  const email = (inp.value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) { alert("Introduce un email valido."); return; }
  if (ADMINS_ALERTA.includes(email)) { alert("Ese email ya esta en la lista."); return; }
  const nuevos = [...ADMINS_ALERTA, email];
  try {
    await db.collection("config").doc("alertas").set({ emails: nuevos }, { merge: true });
    inp.value = "";
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function eliminarEmailAlerta(idx) {
  if (!confirm("Eliminar este destinatario?")) return;
  const nuevos = ADMINS_ALERTA.filter((_, i) => i !== idx);
  try {
    await db.collection("config").doc("alertas").set({ emails: nuevos }, { merge: true });
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function guardarTiempoMax() {
  const val = parseInt(document.getElementById("cfg-tiempo-max").value, 10);
  if (isNaN(val) || val < 15 || val > 480) { alert("Introduce un valor entre 15 y 480 minutos."); return; }
  try {
    await db.collection("config").doc("app").set({ tiempoMaxLanz: val }, { merge: true });
    const ok = document.getElementById("cfg-tiempo-ok");
    if (ok) { ok.style.display = ""; setTimeout(() => { ok.style.display = "none"; }, 2500); }
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function guardarDiasLaborables() {
  const val = parseInt(document.getElementById("cfg-dias-lab").value, 10);
  if (isNaN(val) || val < 18 || val > 26) { alert("Introduce un valor entre 18 y 26 dias."); return; }
  try {
    await db.collection("config").doc("app").set({ diasLaborables: val }, { merge: true });
    const ok = document.getElementById("cfg-dias-ok");
    if (ok) { ok.style.display = ""; setTimeout(() => { ok.style.display = "none"; }, 2500); }
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function agregarDestino() {
  const idInp  = document.getElementById("cfg-destino-id");
  const nomInp = document.getElementById("cfg-destino-nombre");
  const id     = (idInp.value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const nombre = (nomInp.value || "").trim();
  if (!id || !nombre) { alert("Rellena el ID y el nombre del destino."); return; }
  if (NAVES_PANEL.some(n => n.id === id)) { alert("Ya existe un destino con ese ID."); return; }
  const nueva = [...NAVES_PANEL, { id, nombre }];
  try {
    await db.collection("config").doc("destinos").set({ lista: nueva });
    idInp.value = "";
    nomInp.value = "";
  } catch(e) { alert("Error al guardar: " + e.message); }
}

async function eliminarDestino(idx) {
  const n = NAVES_PANEL[idx];
  if (!confirm("Eliminar destino \"" + (n ? n.nombre : idx) + "\"?")) return;
  const nueva = NAVES_PANEL.filter((_, i) => i !== idx);
  try {
    await db.collection("config").doc("destinos").set({ lista: nueva });
  } catch(e) { alert("Error al guardar: " + e.message); }
}
