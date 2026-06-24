// Registro rapido de movimiento de lanzaderas

const NAVES = [
  { id: "caserfri", nombre: "Caserfri", externa: true },
  { id: "merca",    nombre: "Merca",    externa: true },
  { id: "arento",   nombre: "Arento",   externa: true },
  { id: "avitrans", nombre: "Avitrans", externa: true },
  { id: "txt",      nombre: "Txt",      externa: true },
  { id: "upasa",    nombre: "Upasa",    externa: true },
  { id: "sabeco",   nombre: "Sabeco",   externa: true },
  { id: "plaza",    nombre: "Plaza",    externa: false }
];
const MUELLES_CARGA    = ["M1", "M2", "M3", "M4", "M5"];
const MUELLES_DESCARGA = ["M6", "M7", "M8", "M9", "M10", "M18", "M19", "M20"];
const MUELLES_MERCA    = ["M2", "M4"];
const NOMBRE_NAVE = {};
NAVES.forEach(n => { NOMBRE_NAVE[n.id] = n.nombre; });

function escTexto(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

let sel = { numero: null, nave: null, accion: null, muelle: null, destino: null };

// Preseleccion de lanzadera por URL (?l=1)
const paramL = new URLSearchParams(location.search).get("l");
if (paramL && +paramL >= 1 && +paramL <= 4) sel.numero = +paramL;

const app = document.getElementById("app");

function render() {
  ensureChatLanz();
  if (!sel.numero) return renderLanzaderas();
  if (!sel.nave)   return renderNaves();
  if (sel.nave === "plaza" && !sel.muelle) return renderMuelles();
  if (sel.nave === "merca" && !sel.muelle) return renderMuellesMerca();
  return renderConfirmar();
}

function renderLanzaderas() {
  app.innerHTML =
    "<div class='card'><h2>Identificate</h2>" +
    "<p class='card-desc'>Selecciona tu lanzadera.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    [1, 2, 3, 4].map(n =>
      "<div class='temp-btn' onclick='pickLanzadera(" + n + ")'>" +
      "<div class='temp-icon'>🚛</div><div class='temp-name'>Lanzadera " + n + "</div></div>"
    ).join("") +
    "</div></div>";
}

function renderNaves() {
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>¿Donde estas?</h2><p class='card-desc'>Selecciona la nave.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    NAVES.map(n =>
      "<div class='temp-btn' onclick=\"pickNave('" + n.id + "')\">" +
      "<div class='temp-icon'>" + (n.externa ? "🏭" : "🏠") + "</div>" +
      "<div class='temp-name'>" + n.nombre + "</div></div>"
    ).join("") +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"nave\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderMuelles() {
  const muelles = MUELLES_CARGA.concat(MUELLES_DESCARGA);
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>Selecciona muelle</h2><p class='card-desc'>Muelle en Plaza.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr 1fr'>" +
    muelles.map(m =>
      "<div class='temp-btn' onclick=\"pickMuelle('" + m + "')\"><div class='temp-name'>" + m + "</div></div>"
    ).join("") +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"plaza-nave\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderMuellesMerca() {
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>Selecciona muelle</h2><p class='card-desc'>Muelle en Merca.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    MUELLES_MERCA.map(m =>
      "<div class='temp-btn' onclick=\"pickMuelle('" + m + "')\"><div class='temp-name'>" + m + "</div></div>"
    ).join("") +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"merca-nave\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderConfirmar() {
  const detalle = sel.nave === "plaza"
    ? "Plaza · " + (sel.accion === "cargando" ? "Cargando" : "Descargando") + " · " + sel.muelle
    : sel.nave === "merca"
    ? "Merca · " + sel.muelle
    : NOMBRE_NAVE[sel.nave];
  app.innerHTML =
    "<div class='card text-center'>" +
    "<div class='temp-icon' style='font-size:40px'>📍</div>" +
    "<h2>Lanzadera " + sel.numero + "</h2>" +
    "<p class='card-desc'>" + detalle + "</p>" +
    "<button class='btn-primary' style='width:100%' onclick='registrar()'>Registrar</button>" +
    "<button class='btn-back' style='width:100%;margin-top:8px' onclick='volver(\"muelle\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderHecho(estado) {
  if (estado === "en_nave") {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>✓</div><h2>Registrado</h2>" +
      "<p class='card-desc'>Lanzadera " + sel.numero + " en " + NOMBRE_NAVE[sel.nave] + ".</p>" +
      "<button class='btn-primary' style='width:100%' onclick='salir()'>Salir de la nave</button>" +
      "<button class='btn-back' style='width:100%;margin-top:8px' onclick='nuevo()'>Nuevo registro</button>" +
      "<button class='btn-back' style='width:100%;margin-top:8px;color:#D41F3A;border-color:#F5C0C8' onclick='finJornada()'>Fin de jornada</button>" +
      "</div>";
  } else if (estado === "transito") {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>🚚</div><h2>En transito</h2>" +
      "<p class='card-desc'>Lanzadera " + sel.numero + " en transito hacia <strong>" + (NOMBRE_NAVE[sel.destino] || "destino") + "</strong>.</p>" +
      "<button class='btn-primary' style='width:100%' onclick='irANaves()'>Registrar llegada a nave</button>" +
      "<button class='btn-back' style='width:100%;margin-top:8px' onclick='finJornada()'>Fin de jornada</button>" +
      "</div>";
  } else {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>👋</div><h2>Fin de jornada</h2>" +
      "<p class='card-desc'>Lanzadera " + sel.numero + " fuera de servicio.</p>" +
      "<button class='btn-back' style='width:100%;margin-top:8px' onclick='nuevo()'>Nuevo registro</button>" +
      "</div>";
  }
}

function cabecera() {
  return "<div class='step-indicator'>Lanzadera " + sel.numero + "</div>";
}

function pickLanzadera(n) { sel.numero = n; render(); }
function pickNave(id)     { sel.nave = id; sel.accion = null; sel.muelle = null; render(); }
function pickMuelle(m) {
  sel.muelle = m;
  // En Plaza se deduce carga/descarga segun el muelle elegido
  if (sel.nave === "plaza") sel.accion = MUELLES_CARGA.indexOf(m) !== -1 ? "cargando" : "descargando";
  render();
}

function volver(desde) {
  if (desde === "nave")   { sel.numero = paramL ? sel.numero : null; if (!paramL) sel.numero = null; }
  if (desde === "muelle") {
    if (sel.nave === "plaza") { sel.muelle = null; sel.accion = null; }
    else if (sel.nave === "merca") { sel.muelle = null; }
    else sel.nave = null;
  }
  if (desde === "merca-nave") { sel.nave = null; sel.muelle = null; }
  if (desde === "plaza-nave") { sel.nave = null; sel.muelle = null; sel.accion = null; }
  render();
}

function nuevo() { sel = { numero: paramL ? +paramL : null, nave: null, accion: null, muelle: null, destino: null }; render(); }

async function escribir(estado, activa) {
  const datos = {
    numero:      sel.numero,
    estado:      estado,
    nave:        sel.nave,
    accion:      sel.nave === "plaza" ? sel.accion : "presente",
    muelle:      (sel.nave === "plaza" || sel.nave === "merca") ? sel.muelle : null,
    destino:     estado === "transito" ? (sel.destino || null) : null,
    activa:      activa,
    desde:       firebase.firestore.Timestamp.now(),
    actualizado: firebase.firestore.Timestamp.now()
  };
  await db.collection("lanzaderas").doc(String(sel.numero)).set(datos); // estado en vivo
  await db.collection("lanzaderas_log").add(datos);                     // historico
}

async function registrar() { // llegada / actividad en una nave
  try { await escribir("en_nave", true); renderHecho("en_nave"); }
  catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

async function salir() { // al salir, muestra la indicacion/urgencia (si hay) y elige destino
  let nota = "", urgente = false;
  try {
    const d = await db.collection("lanzaderas_nota").doc(String(sel.numero)).get();
    if (d.exists) { nota = d.data().nota || ""; urgente = !!d.data().urgente; }
  } catch (e) {}
  renderDestino(nota, urgente);
}

function renderDestino(nota, urgente) {
  const aviso = !nota ? "" : (urgente
    ? "<div style='background:#FBEAED;border:1.5px solid #D41F3A;border-radius:8px;padding:12px 14px;font-size:15px;font-weight:600;color:#D41F3A;margin-bottom:12px'>🚨 URGENTE: " + escTexto(nota) + "</div>"
    : "<div style='background:#FEF3C7;border:1px solid #FACC15;border-radius:8px;padding:10px 14px;font-size:14px;color:#92400E;margin-bottom:12px'>📌 Indicacion: " + escTexto(nota) + "</div>");
  app.innerHTML =
    "<div class='card'>" + cabecera() + aviso +
    "<h2>¿Hacia donde vas?</h2><p class='card-desc'>Selecciona tu destino.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    NAVES.map(n =>
      "<div class='temp-btn' onclick=\"elegirDestino('" + n.id + "')\">" +
      "<div class='temp-icon'>" + (n.externa ? "🏭" : "🏠") + "</div>" +
      "<div class='temp-name'>" + n.nombre + "</div></div>"
    ).join("") +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='render()'>&#8592; Atras</button>" +
    "</div>";
}

function elegirDestino(id) { sel.destino = id; registrarTransito(); }

async function registrarTransito() {
  try {
    await escribir("transito", true);
    // limpia la indicacion una vez vista y aplicada
    try { await db.collection("lanzaderas_nota").doc(String(sel.numero)).set({ numero: sel.numero, nota: "", urgente: false, actualizado: firebase.firestore.Timestamp.now() }); } catch (e) {}
    renderHecho("transito");
  } catch (e) { console.error(e); alert("No se pudo registrar la salida. Reintenta."); }
}

async function finJornada() {
  try { await escribir("fuera", false); renderHecho("fuera"); }
  catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

function irANaves() {
  sel.nave = sel.destino; sel.accion = null; sel.muelle = null; sel.destino = null;
  if (sel.nave && sel.nave !== "plaza" && sel.nave !== "merca") registrar(); // llegada directa a nave externa (cierra el transito)
  else render();                                      // Plaza o Merca: elegir muelle
}

// ─── CHAT con el almacen ─────────────────────────────────────────────
let _chatUnsub = null, _chatMsgs = [], _chatNum = null;

function ensureChatLanz() {
  if (!sel.numero) return;
  document.getElementById("chat-fab").style.display = "block";
  if (_chatNum === sel.numero) return;
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
  _chatNum = sel.numero; _chatMsgs = [];
  _chatUnsub = db.collection("mensajes").where("lanzadera", "==", sel.numero)
    .onSnapshot(s => {
      const a = []; s.forEach(d => a.push(d.data()));
      a.sort((x, y) => (x.ts ? x.ts.toMillis() : 0) - (y.ts ? y.ts.toMillis() : 0));
      _chatMsgs = a; onChatData();
    }, e => {});
}

function chatSeenKey() { return "chatSeenLanz_" + sel.numero; }

function updateFab() {
  const seen = +(localStorage.getItem(chatSeenKey()) || 0);
  const unread = _chatMsgs.filter(m => m.de === "almacen" && m.ts && m.ts.toMillis() > seen).length;
  const fab = document.getElementById("chat-fab");
  fab.textContent = unread ? ("Chat almacen (" + unread + ")") : "Chat con almacen";
  fab.style.background = unread ? "#D41F3A" : "#1D9E75";
}

function onChatData() {
  updateFab();
  if (document.getElementById("chat-overlay").style.display !== "none") renderChatLanz();
}

function horaChat(ts) {
  if (!ts) return "";
  const d = ts.toDate();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function renderChatLanz() {
  const cont = document.getElementById("chat-ov-msgs");
  cont.innerHTML = _chatMsgs.length
    ? _chatMsgs.map(m => {
        const right = m.de === "lanzadera";
        const emisor = (!right && m.emisor)
          ? "<span class='chat-emisor'>" + escTexto(m.emisor) + "</span>" : "";
        const hora = "<span class='chat-time'>" + horaChat(m.ts) + "</span>";
        return "<div class='chat-row " + (right ? "r" : "l") + "'><div class='chat-b " + (right ? "chat-b-out" : "chat-b-in") + "'>" + emisor + escTexto(m.texto) + hora + "</div></div>";
      }).join("")
    : "<div style='text-align:center;color:#9CA3AF;padding:24px'>Sin mensajes. Escribe al almacen.</div>";
  cont.scrollTop = cont.scrollHeight;
  if (_chatMsgs.length) { const last = _chatMsgs[_chatMsgs.length - 1]; if (last.ts) localStorage.setItem(chatSeenKey(), String(last.ts.toMillis())); }
  updateFab();
}

function abrirChat() {
  if (!sel.numero) return;
  document.getElementById("chat-ov-titulo").textContent = "Chat con Almacen — Lanzadera " + sel.numero;
  document.getElementById("chat-ov-quick").innerHTML =
    ["Voy", "OK", "5 min", "Cargando", "Problema"].map(q => "<button class='chatov-chip' onclick=\"enviarChatLanz('" + q + "')\">" + q + "</button>").join("");
  document.getElementById("chat-overlay").style.display = "flex";
  renderChatLanz();
}

function cerrarChat() { document.getElementById("chat-overlay").style.display = "none"; }

async function enviarChatLanz(textoOpt) {
  const inp = document.getElementById("chat-ov-text");
  const texto = (textoOpt != null ? textoOpt : inp.value).trim();
  if (!texto || !sel.numero) return;
  try {
    await db.collection("mensajes").add({ lanzadera: sel.numero, de: "lanzadera", texto: texto, ts: firebase.firestore.Timestamp.now() });
    if (textoOpt == null) inp.value = "";
  } catch (e) { console.error(e); alert("No se pudo enviar."); }
}

render();
