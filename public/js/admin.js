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
    cargarReservas();
    autoRefreshInterval = setInterval(cargarReservas, 60000);
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
  ["rejilla", "lista", "informes"].forEach(v => {
    document.getElementById("vista-" + v).style.display = vista === v ? "block" : "none";
    document.getElementById("btn-vista-" + v).classList.toggle("active", vista === v);
  });
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
  franjas.forEach(f => { thead += "<th class='franja-th'>" + f.split(" - ")[0] + "</th>"; });
  thead += "</tr></thead><tbody>";
  let tbody = "";
  muelles.forEach(muelle => {
    tbody += "<tr><td class='muelle-td'>" + muelle + "</td>";
    franjas.forEach(franja => {
      const hits = reservas.filter(r => r.muelle === muelle && r.franja === franja);
      const pend = reservas.filter(r => !r.muelle && r.franja === franja && r.estado === "pendiente" && r.seccion === seccion);
      if (hits.length > 0) {
        const r = hits[0]; const color = ESTADO_COLOR[r.estado] || "#9CA3AF";
        tbody += "<td class='slot-td' data-id='" + r.id + "' style='background:" + color + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>" + esc(r.estado) + "</div></td>";
      } else if (pend.length > 0) {
        const r = pend[0];
        tbody += "<td class='slot-td slot-pendiente' data-id='" + r.id + "' title='" + esc(r.empresa) + "'>" +
          "<div class='slot-empresa'>" + esc(r.empresa.split(" ")[0]) + "</div><div class='slot-estado'>pendiente</div></td>";
      } else {
        tbody += "<td class='slot-td slot-libre'></td>";
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
  try { await db.collection("reservas").doc(id).update({ estado: nuevoEstado }); cargarReservas(); }
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

  const count = (key, label) => { const c = {}; informeData.forEach(r => { const k = label ? (label[r[key]] || r[key]) : r[key]; c[k] = (c[k]||0)+1; }); return Object.entries(c).sort((a,b)=>b[1]-a[1]); };
  document.getElementById("tabla-franjas").innerHTML    = renderBarras(count("franja").slice(0,8), informeData.length);
  document.getElementById("tabla-empresas").innerHTML   = renderBarras(count("empresa").slice(0,8), informeData.length);
  document.getElementById("tabla-temperatura").innerHTML = renderBarras(count("seccion", SEC_LABEL), informeData.length);
  document.getElementById("tabla-muelles").innerHTML    = renderBarras(count("muelle").filter(x=>x[0]&&x[0]!=="null"), informeData.length);
  document.getElementById("tabla-completa").innerHTML   = renderTablaCompleta(informeData);
}

function renderBarras(items, total) {
  if (!items.length) return "<div class='empty-state' style='padding:16px'>Sin datos</div>";
  return items.map(item => "<div class='barra-row'><div class='barra-label'>" + esc(item[0]) + "</div>" +
    "<div class='barra-wrap'><div class='barra-fill' style='width:" + Math.round(item[1]/total*100) + "%'></div></div>" +
    "<div class='barra-val'>" + item[1] + "</div></div>").join("");
}

function renderTablaCompleta(reservas) {
  let html = "<div class='tabla-scroll'><table class='tabla-inf'><thead><tr><th>Fecha</th><th>Franja</th><th>Seccion</th><th>Empresa</th><th>Matricula</th><th>Mercancia</th><th>Pales</th><th>Muelle</th><th>Estado</th></tr></thead><tbody>";
  reservas.forEach(r => {
    html += "<tr><td>" + esc(r.fecha) + "</td><td>" + esc(r.franja) + "</td><td>" + esc(SEC_LABEL[r.seccion]||r.temperatura) + "</td>" +
      "<td>" + esc(r.empresa) + "</td><td>" + esc(r.matricula) + "</td><td>" + esc(r.mercancia||"—") + "</td>" +
      "<td>" + esc(r.pales||"—") + "</td><td>" + esc(r.muelle||"—") + "</td>" +
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
    "Muelle": r.muelle||"", "Estado": r.estado, "Motivo": r.motivo||"",
    "Nota almacen": r.nota_almacen||"", "Codigo": r.codigo
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
  if (accion === "en-curso")  { datos = { estado: "en_curso" }; }
  if (accion === "completar") { datos = { estado: "completada" }; }

  try {
    await db.collection("reservas").doc(reservaActual.id).update(datos);
    if (emailTo && emailSubject) await enviarEmailMS(emailTo, emailSubject, emailBody);
    cerrarModal();
    cargarReservas();
  } catch(e) { console.error(e); alert("Error al actualizar. Intentalo de nuevo."); }
}
