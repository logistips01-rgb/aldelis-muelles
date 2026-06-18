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
    document.getElementById("cg-desde").value         = hoy;
    document.getElementById("cg-hasta").value         = hoy;
    cargarReservas();
    aplicarRol(user);
    autoRefreshInterval = setInterval(() => {
      cargarReservas();
      if (document.getElementById("vista-lanzaderas").style.display !== "none") cargarLanzaderas();
      if (document.getElementById("vista-cargas").style.display !== "none")     cargarCargas();
    }, 15000);
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

// Usuarios que solo ven la vista de Lanzaderas (gerente de lanzaderas)
const SOLO_LANZADERAS = ["transfriorza@transfriorza.es"];
function aplicarRol(user) {
  const soloLanz = SOLO_LANZADERAS.includes((user.email || "").toLowerCase());
  if (!soloLanz) return;
  ["rejilla", "lista", "informes", "cargas"].forEach(v => {
    const b = document.getElementById("btn-vista-" + v);
    if (b) b.style.display = "none";
  });
  const mr = document.querySelector(".metrics-row");
  if (mr) mr.style.display = "none";
  switchVista("lanzaderas");
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

function cambioFecha() {
  cargarReservas();
  if (document.getElementById("vista-cargas").style.display !== "none") cargarCargas();
  if (document.getElementById("vista-lanzaderas").style.display !== "none") cargarLanzaderas();
}

const NAVES_PANEL = [
  { id: "plaza",    nombre: "Plaza" },
  { id: "caserfri", nombre: "Caserfri" },
  { id: "merca",    nombre: "Merca" },
  { id: "arento",   nombre: "Arento" },
  { id: "avitrans", nombre: "Avitrans" },
  { id: "txt",      nombre: "Txt" },
  { id: "upasa",    nombre: "Upasa" }
];
const NAVE_NOMBRE = {};
NAVES_PANEL.forEach(n => { NAVE_NOMBRE[n.id] = n.nombre; });
const ACCION_LABEL = { cargando: "Cargando", descargando: "Descargando", presente: "Presente" };
const ACCION_COLOR = { cargando: "#185FA5", descargando: "#1D9E75", presente: "#6B7280" };

// Tramos de lanzadera en Plaza (para superponer en parrillas de descarga/carga)
async function lanzaderaSegmentos(dayStart, dayEnd, accionFiltro) {
  const snap = await db.collection("lanzaderas_log")
    .where("desde", ">=", firebase.firestore.Timestamp.fromMillis(dayStart))
    .where("desde", "<",  firebase.firestore.Timestamp.fromMillis(dayEnd)).get();
  const logs = [];
  snap.forEach(d => logs.push(d.data()));
  const byL = { 1: [], 2: [], 3: [], 4: [] };
  logs.forEach(l => { if (byL[l.numero]) byL[l.numero].push(l); });
  const segs = [];
  Object.keys(byL).forEach(k => {
    const arr = byL[k].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
    for (let i = 0; i < arr.length; i++) {
      const ev = arr[i];
      if (ev.estado === "en_nave" && ev.nave === "plaza" && ev.accion === accionFiltro) {
        const startMin = (ev.desde.toMillis() - dayStart) / 60000;
        const nextMs = (i + 1 < arr.length) ? arr[i + 1].desde.toMillis() : (esHoy ? Date.now() : dayEnd);
        segs.push({ numero: +k, muelle: ev.muelle, startMin, endMin: (nextMs - dayStart) / 60000 });
      }
    }
  });
  return segs;
}

async function cargarLanzaderas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const snap = await db.collection("lanzaderas_log")
    .where("desde", ">=", firebase.firestore.Timestamp.fromMillis(dayStart))
    .where("desde", "<",  firebase.firestore.Timestamp.fromMillis(dayEnd)).get();
  const logs = [];
  snap.forEach(d => logs.push(d.data()));

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

// ─── LINEA DE TIEMPO (GANTT) DE LANZADERAS ───────────────────────────
function ganttNow() {
  if (!esHoy) return "";
  const nl = (ahoraMin - G_INI) * G_PXMIN;
  if (nl < 0 || nl > G_W) return "";
  return "<div class='gantt-now' style='left:" + nl + "px'></div>";
}

function ganttBarra(startMin, endMin, color, label, onclick) {
  const a = Math.max(startMin, G_INI), b = Math.min(endMin, G_FIN);
  if (b <= a) return "";
  const left = (a - G_INI) * G_PXMIN;
  const w = Math.max((b - a) * G_PXMIN, 14);
  const estilo = "left:" + left + "px;width:" + w + "px;background:" + color + (onclick ? ";cursor:pointer" : "");
  const ev = onclick ? " onclick=\"" + onclick + "\"" : "";
  return "<div class='gantt-bar' style='" + estilo + "'" + ev + " title='" + esc(label) + "'>" +
    "<span class='gantt-bar-txt'>" + esc(label) + "</span></div>";
}

function renderGanttLanz(segs, trans, finMarks) {
  const cont = document.getElementById("gantt-lanz");
  if (!cont) return;

  let head = "<div class='gantt-row gantt-head'><div class='gantt-label'>Hora</div><div class='gantt-track' style='width:" + G_W + "px'>";
  for (let h = 4; h <= 24; h++) {
    const left = (h * 60 - G_INI) * G_PXMIN;
    head += "<div class='gantt-tick' style='left:" + left + "px'>" + String(h % 24).padStart(2, "0") + ":00</div>";
  }
  head += ganttNow() + "</div></div>";

  let rows = "";
  for (let n = 1; n <= 4; n++) {
    let bars = "";
    segs.filter(s => s.numero === n).forEach(s => {
      let lbl = NAVE_NOMBRE[s.nave] || s.nave;
      if (s.nave === "plaza" && s.muelle) lbl += " " + (s.accion === "cargando" ? "⬆" : "⬇") + s.muelle;
      bars += ganttBarra(s.startMin, s.endMin, "#1D9E75", lbl, "abrirNotaModal(" + n + ")");
    });
    trans.filter(s => s.numero === n).forEach(s => {
      bars += ganttBarra(s.startMin, s.endMin, "#F59E0B", "→ " + (NAVE_NOMBRE[s.destino] || s.destino || "?"), "");
    });
    finMarks.filter(m => m.numero === n).forEach(m => {
      const left = (m.atMin - G_INI) * G_PXMIN;
      if (left >= 0 && left <= G_W) bars += "<div class='gantt-fin' style='left:" + left + "px' title='Fin de jornada'></div>";
    });
    rows += "<div class='gantt-row'><div class='gantt-label'>Lanzadera " + n + "</div>" +
      "<div class='gantt-track' style='width:" + G_W + "px'>" + bars + ganttNow() + "</div></div>";
  }
  cont.innerHTML = head + rows;

  if (esHoy) {
    const nl = (ahoraMin - G_INI) * G_PXMIN;
    if (nl >= 0) cont.scrollLeft = Math.max(0, G_LABEL_W + nl - cont.clientWidth / 2);
  }
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

async function cargarCargas() {
  const fecha = document.getElementById("fecha-dashboard").value;
  const dayStart = new Date(fecha + "T00:00:00").getTime();
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const snap = await db.collection("cargas")
    .where("inicio", ">=", firebase.firestore.Timestamp.fromMillis(dayStart))
    .where("inicio", "<",  firebase.firestore.Timestamp.fromMillis(dayEnd)).get();
  const cargas = [];
  snap.forEach(d => cargas.push({ id: d.id, ...d.data() }));
  let lanzCarga = [];
  try { lanzCarga = await lanzaderaSegmentos(dayStart, dayEnd, "cargando"); } catch (e) { lanzCarga = []; }

  const filas = MUELLES_CARGA.map(m => ({ id: m, label: m }));
  pintarRejilla("rejilla-cargas", "Muelle", filas, FRANJAS_CARGAS, (fila, f, now) => {
    const r = franjaRango(f);
    const c = cargas.find(x => x.muelle === fila.id && spanOcupa(x.inicio, x.fin, r[0], r[1], dayStart));
    if (!c) {
      const lz = lanzCarga.find(s => s.muelle === fila.id && s.startMin < r[1] && s.endMin > r[0]);
      if (lz) {
        return "<td class='slot-td" + now + "' style='background:#7C3AED' title='Lanzadera " + lz.numero + " (carga)'>" +
          "<div class='slot-empresa'>L" + lz.numero + "</div><div class='slot-estado'>lanzad.</div></td>";
      }
      return "<td class='slot-td slot-libre" + now + "'></td>";
    }
    const color = c.estado === "completada" ? "#6B7280" : "#185FA5";
    const click = c.estado === "cargando" ? " onclick=\"completarCarga('" + c.id + "')\"" : "";
    const cur = c.estado === "cargando" ? "cursor:pointer;" : "";
    return "<td class='slot-td" + now + "' style='background:" + color + ";" + cur + "'" + click +
      " title='" + esc(c.matricula_tractora + (c.destino ? " -> " + c.destino : "")) + "'>" +
      "<div class='slot-empresa'>" + esc(c.matricula_tractora) + "</div>" +
      "<div class='slot-estado'>" + esc(c.estado) + "</div></td>";
  });
}

async function completarCarga(id) {
  if (!confirm("¿Marcar esta carga como completada?")) return;
  try {
    await db.collection("cargas").doc(id).update({ estado: "completada", fin: firebase.firestore.Timestamp.now() });
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
  const ds = new Date(fecha + "T00:00:00").getTime();
  try { window._lanzDescarga = await lanzaderaSegmentos(ds, ds + 86400000, "descargando"); }
  catch (e) { window._lanzDescarga = []; }
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
