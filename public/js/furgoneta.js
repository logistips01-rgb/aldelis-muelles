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
    "<div class='temp-btn' onclick=\"pedirOtroLugarFurgo('" + modo + "')\" style='border-style:dashed'>" +
    "<div class='temp-icon'>📍</div><div class='temp-name'>Otro lugar</div></div>" +
    "</div></div>";
}

function pickNaveFurgo(id, modo) {
  if (modo === "destino") { sel.destino = id; registrarTransito(); return; }
  sel.nave = id;
  render();
}

// ── Lugares que no estan en la lista ────────────────────────────────────────
// El nombre escrito se guarda tal cual en "nave"/"destino" (texto libre en las
// reglas). Se recuerdan los ultimos en el propio movil para no teclearlos
// cada vez, igual que ya hacen las lanzaderas.
const OTROS_KEY_FURGO = "furgo_otros_lugares";
const MAX_OTROS_FURGO = 6;

function otrosLugaresFurgo() {
  try {
    const l = JSON.parse(localStorage.getItem(OTROS_KEY_FURGO) || "[]");
    return Array.isArray(l) ? l.filter(x => typeof x === "string" && x) : [];
  } catch (e) { return []; }
}

function recordarLugarFurgo(nombre) {
  try {
    const l = otrosLugaresFurgo().filter(x => x.toLowerCase() !== nombre.toLowerCase());
    l.unshift(nombre);
    localStorage.setItem(OTROS_KEY_FURGO, JSON.stringify(l.slice(0, MAX_OTROS_FURGO)));
  } catch (e) {}
}

function pedirOtroLugarFurgo(modo) {
  const recientes = otrosLugaresFurgo();
  app.innerHTML =
    "<div class='card'>" +
    "<h2>" + (modo === "destino" ? "¿A donde vas?" : "¿Donde estas?") + "</h2>" +
    "<p class='card-desc'>Escribe el nombre del sitio.</p>" +
    (recientes.length
      ? "<p class='card-desc' style='margin-bottom:6px'>Ultimos sitios:</p>" +
        "<div style='display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px'>" +
        recientes.map(r =>
          "<button class='chatov-chip' style='background:#F3F4F6;border:none;border-radius:16px;" +
          "padding:7px 14px;font-size:13px;font-family:Inter,sans-serif'" +
          " onclick=\"usarOtroLugarFurgo('" + modo + "', '" + escTexto(r).replace(/'/g, "&#39;") + "')\">" +
          escTexto(r) + "</button>"
        ).join("") + "</div>"
      : "") +
    "<div class='field'><label>Nombre del sitio</label>" +
    "<input type='text' id='otro-nombre-furgo' maxlength='60' autocomplete='off' " +
    "placeholder='Ej: Mercadona Plaza'></div>" +
    "<div id='otro-error-furgo' style='color:#D41F3A;font-size:13px;margin-bottom:10px;display:none'></div>" +
    "<button class='btn-primary' onclick=\"confirmarOtroLugarFurgo('" + modo + "')\">Continuar</button>" +
    "<button class='btn-back' style='width:100%;margin-top:8px' onclick='render()'>&#8592; Atras</button>" +
    "</div>";
  const i = document.getElementById("otro-nombre-furgo");
  if (i) i.focus();
}

function confirmarOtroLugarFurgo(modo) {
  const nombre = (document.getElementById("otro-nombre-furgo").value || "").trim();
  const err = document.getElementById("otro-error-furgo");
  if (nombre.length < 2) {
    err.textContent = "Escribe el nombre del sitio.";
    err.style.display = "block";
    return;
  }
  usarOtroLugarFurgo(modo, nombre);
}

function usarOtroLugarFurgo(modo, nombre) {
  recordarLugarFurgo(nombre);
  pickNaveFurgo(nombre, modo);
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
