// Registro de movimientos de la Furgoneta (uso interno, sin coste por minuto,
// sin chat, sin GPS): solo se quiere saber donde ha estado a lo largo del dia
// para verlo en el panel como una linea de tiempo, igual que las lanzaderas
// pero mas simple. Coleccion propia (furgoneta / furgoneta_log), separada de
// lanzaderas para no tocar el calculo de costes ni las reglas ya afinadas de
// las 4 lanzaderas.

const NAVES_FURGO = [
  { id: "plaza",    nombre: "Plaza" },
  { id: "caserfri", nombre: "Caserfri" },
  { id: "merca",    nombre: "Merca" },
  { id: "arento",   nombre: "Arento" },
  { id: "avitrans", nombre: "Avitrans" },
  { id: "txt",      nombre: "Txt" },
  { id: "upasa",    nombre: "Upasa" },
  { id: "sabeco",   nombre: "Sabeco" }
];
const NOMBRE_NAVE_FURGO = {};
NAVES_FURGO.forEach(n => { NOMBRE_NAVE_FURGO[n.id] = n.nombre; });

function escTexto(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

let sel = { nave: null, destino: null };
let estadoActivoServidor = null;
const app = document.getElementById("app");
const DOC_ID = "furgoneta"; // un unico vehiculo: un unico documento de estado

// Al abrir, recupera si ya estaba registrada activa (en nave o en transito)
// en vez de preguntar otra vez "¿donde estas?".
async function recuperarEstadoActivo() {
  try {
    const d = await db.collection("furgoneta").doc(DOC_ID).get();
    if (d.exists && d.data().activa) {
      const data = d.data();
      sel.nave = data.nave || null;
      sel.destino = data.destino || null;
      estadoActivoServidor = { estado: data.estado };
    } else {
      estadoActivoServidor = null;
    }
  } catch (e) { console.warn("recuperar estado furgoneta:", e.message); }
  render();
}

function render() {
  if (estadoActivoServidor) return renderHecho(estadoActivoServidor.estado);
  if (!sel.nave) return renderNaves("¿Donde estas?", "nave");
  return renderConfirmar();
}

function renderNaves(titulo, modo) {
  app.innerHTML =
    "<div class='card'><h2>" + titulo + "</h2><p class='card-desc'>Selecciona la nave.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr'>" +
    NAVES_FURGO.map(n =>
      "<div class='temp-btn' onclick=\"pickNaveFurgo('" + n.id + "', '" + modo + "')\">" +
      "<div class='temp-icon'>🚐</div><div class='temp-name'>" + escTexto(n.nombre) + "</div></div>"
    ).join("") +
    "</div></div>";
}

function pickNaveFurgo(id, modo) {
  if (modo === "destino") { sel.destino = id; registrarTransito(); return; }
  sel.nave = id;
  render();
}

function renderConfirmar() {
  app.innerHTML =
    "<div class='card text-center'>" +
    "<div class='temp-icon' style='font-size:40px'>📍</div>" +
    "<h2>Furgoneta</h2>" +
    "<p class='card-desc'>" + escTexto(NOMBRE_NAVE_FURGO[sel.nave] || sel.nave) + "</p>" +
    "<button class='btn-primary' style='width:100%' onclick='registrar()'>Registrar</button>" +
    "<button class='btn-back' style='width:100%;margin-top:8px' onclick='volverFurgo()'>&#8592; Atras</button>" +
    "</div>";
}

function volverFurgo() {
  sel.nave = null;
  render();
}

function renderHecho(estado) {
  if (estado === "en_nave") {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>✓</div><h2>Registrado</h2>" +
      "<p class='card-desc'>Furgoneta en " + escTexto(NOMBRE_NAVE_FURGO[sel.nave] || sel.nave || "—") + ".</p>" +
      "<button class='btn-primary' style='width:100%' onclick='salirFurgo()'>Salir de la nave</button>" +
      "<button class='btn-back' style='width:100%;margin-top:8px' onclick='finServicio()'>Fin de servicio</button>" +
      "</div>";
  } else if (estado === "transito") {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='temp-icon' style='font-size:40px'>🚐</div><h2>En transito</h2>" +
      "<p class='card-desc'>Hacia " + escTexto(NOMBRE_NAVE_FURGO[sel.destino] || sel.destino || "—") + "</p>" +
      "<button class='btn-primary' style='width:100%' onclick='heLlegadoFurgo()'>He llegado</button>" +
      "</div>";
  } else {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='temp-icon' style='font-size:40px'>🌙</div><h2>Fuera de servicio</h2>" +
      "<button class='btn-primary' style='width:100%' onclick='nuevoFurgo()'>Registrar movimiento</button>" +
      "</div>";
  }
}

function salirFurgo() {
  estadoActivoServidor = null;
  sel.destino = null;
  renderNaves("¿A donde vas?", "destino");
}

function heLlegadoFurgo() {
  sel.nave = sel.destino;
  sel.destino = null;
  registrar();
}

function nuevoFurgo() {
  sel = { nave: null, destino: null };
  estadoActivoServidor = null;
  render();
}

async function escribir(estado, activa) {
  const datos = {
    estado: estado,
    nave: sel.nave,
    destino: estado === "transito" ? (sel.destino || null) : null,
    activa: activa,
    desde: firebase.firestore.Timestamp.now(),
    actualizado: firebase.firestore.Timestamp.now()
  };
  await db.collection("furgoneta").doc(DOC_ID).set(datos);
  await db.collection("furgoneta_log").add(datos);
}

async function registrar() {
  try {
    await escribir("en_nave", true);
    renderHecho("en_nave");
  } catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

async function registrarTransito() {
  try {
    await escribir("transito", true);
    renderHecho("transito");
  } catch (e) { console.error(e); alert("No se pudo registrar la salida. Reintenta."); }
}

async function finServicio() {
  try { await escribir("fuera", false); renderHecho("fuera"); }
  catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

recuperarEstadoActivo();
