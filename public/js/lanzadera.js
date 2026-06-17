// Registro rapido de movimiento de lanzaderas

const NAVES = [
  { id: "caserfri", nombre: "Caserfri", externa: true },
  { id: "merca",    nombre: "Merca",    externa: true },
  { id: "arento",   nombre: "Arento",   externa: true },
  { id: "avitrans", nombre: "Avitrans", externa: true },
  { id: "txt",      nombre: "Txt",      externa: true },
  { id: "plaza",    nombre: "Plaza",    externa: false }
];
const MUELLES_CARGA    = ["M1", "M2", "M3", "M4", "M5"];
const MUELLES_DESCARGA = ["M6", "M7", "M8", "M9", "M10", "M18", "M19", "M20"];
const NOMBRE_NAVE = {};
NAVES.forEach(n => { NOMBRE_NAVE[n.id] = n.nombre; });

let sel = { numero: null, nave: null, accion: null, muelle: null };

// Preseleccion de lanzadera por URL (?l=1)
const paramL = new URLSearchParams(location.search).get("l");
if (paramL && +paramL >= 1 && +paramL <= 4) sel.numero = +paramL;

const app = document.getElementById("app");

function render() {
  if (!sel.numero) return renderLanzaderas();
  if (!sel.nave)   return renderNaves();
  if (sel.nave === "plaza" && !sel.accion) return renderAccion();
  if (sel.nave === "plaza" && !sel.muelle) return renderMuelles();
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

function renderAccion() {
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>En Plaza, ¿que haces?</h2>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    "<div class='temp-btn' onclick=\"pickAccion('cargando')\"><div class='temp-icon'>⬆️</div><div class='temp-name'>Cargar</div></div>" +
    "<div class='temp-btn' onclick=\"pickAccion('descargando')\"><div class='temp-icon'>⬇️</div><div class='temp-name'>Descargar</div></div>" +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"accion\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderMuelles() {
  const muelles = sel.accion === "cargando" ? MUELLES_CARGA : MUELLES_DESCARGA;
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>Selecciona muelle</h2><p class='card-desc'>" + (sel.accion === "cargando" ? "Carga" : "Descarga") + " en Plaza.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr 1fr'>" +
    muelles.map(m =>
      "<div class='temp-btn' onclick=\"pickMuelle('" + m + "')\"><div class='temp-name'>" + m + "</div></div>"
    ).join("") +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"muelle\")'>&#8592; Atras</button>" +
    "</div>";
}

function renderConfirmar() {
  const detalle = sel.nave === "plaza"
    ? "Plaza · " + (sel.accion === "cargando" ? "Cargando" : "Descargando") + " · " + sel.muelle
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

function renderHecho(saliendo) {
  app.innerHTML =
    "<div class='card text-center'>" +
    "<div class='done-icon'>" + (saliendo ? "👋" : "✓") + "</div>" +
    "<h2>" + (saliendo ? "Salida registrada" : "Registrado") + "</h2>" +
    "<p class='card-desc'>Lanzadera " + sel.numero + (saliendo ? " ha salido de " + NOMBRE_NAVE[sel.nave] : " en " + NOMBRE_NAVE[sel.nave]) + ".</p>" +
    (saliendo ? "" : "<button class='btn-primary' style='width:100%' onclick='salir()'>Salir de la nave</button>") +
    "<button class='btn-back' style='width:100%;margin-top:8px' onclick='nuevo()'>Nuevo registro</button>" +
    "</div>";
}

function cabecera() {
  return "<div class='step-indicator'>Lanzadera " + sel.numero + "</div>";
}

function pickLanzadera(n) { sel.numero = n; render(); }
function pickNave(id)     { sel.nave = id; sel.accion = null; sel.muelle = null; render(); }
function pickAccion(a)    { sel.accion = a; sel.muelle = null; render(); }
function pickMuelle(m)    { sel.muelle = m; render(); }

function volver(desde) {
  if (desde === "nave")   { sel.numero = paramL ? sel.numero : null; if (!paramL) sel.numero = null; }
  if (desde === "accion") { sel.nave = null; }
  if (desde === "muelle") {
    if (sel.nave === "plaza") { sel.muelle = null; sel.accion = null; }
    else sel.nave = null;
  }
  render();
}

function nuevo() { sel = { numero: paramL ? +paramL : null, nave: null, accion: null, muelle: null }; render(); }

async function escribir(activa) {
  await db.collection("lanzaderas").doc(String(sel.numero)).set({
    numero:      sel.numero,
    nave:        sel.nave,
    accion:      sel.nave === "plaza" ? sel.accion : "presente",
    muelle:      sel.nave === "plaza" ? sel.muelle : null,
    activa:      activa,
    desde:       firebase.firestore.Timestamp.now(),
    actualizado: firebase.firestore.Timestamp.now()
  });
}

async function registrar() {
  try { await escribir(true); renderHecho(false); }
  catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

async function salir() {
  try { await escribir(false); renderHecho(true); }
  catch (e) { console.error(e); alert("No se pudo registrar la salida. Reintenta."); }
}

render();
