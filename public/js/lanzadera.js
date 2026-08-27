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
// Los datos del conductor se leen del propio dispositivo, no de Firestore.
// Se hace en cuanto se sabe la lanzadera (aqui o en pickLanzadera).

const app = document.getElementById("app");

// ── Conductor ───────────────────────────────────────────────────────────────
// El almacen necesita saber quien conduce y su telefono para poder llamarle. Se
// pide una sola vez por lanzadera y dispositivo: queda guardado en el propio
// movil, asi que en los turnos siguientes no se vuelve a preguntar.
let chofer = { nombre: "", telefono: "" };
let _editandoChofer = false;

// Una sola clave por dispositivo, NO una por lanzadera. Antes se guardaba por
// lanzadera y aparecia el mismo conductor en varias a la vez: si hoy llevas la
// 1 y mañana la 3, quedaban las dos con tu nombre. Con la identidad ligada al
// movil, al cambiar de lanzadera te sigue, y el servidor limpia la anterior.
const CHOFER_KEY = "chofer_datos";

function cargarChoferLocal() {
  chofer = { nombre: "", telefono: "" };
  try {
    let j = localStorage.getItem(CHOFER_KEY);
    // Migracion de las claves antiguas por lanzadera
    if (!j) {
      for (let n = 1; n <= 4; n++) {
        const viejo = localStorage.getItem("chofer_lanz_" + n);
        if (viejo) { j = viejo; localStorage.setItem(CHOFER_KEY, viejo); }
        localStorage.removeItem("chofer_lanz_" + n);
      }
    }
    if (j) {
      const o = JSON.parse(j);
      chofer.nombre   = o.nombre   || "";
      chofer.telefono = o.telefono || "";
    }
  } catch (e) { /* dato corrupto: se vuelve a pedir */ }
}

function renderChofer() {
  app.innerHTML =
    "<div class='card'><h2>¿Quien conduce?</h2>" +
    "<p class='card-desc'>Lanzadera " + sel.numero + ". El almacen lo necesita para poder " +
    "llamarte si hace falta. Solo se pregunta una vez en este movil.</p>" +
    "<div class='field'><label>Nombre</label>" +
    "<input type='text' id='ch-nombre' maxlength='120' placeholder='Nombre y apellidos' value='" +
    escTexto(chofer.nombre) + "'></div>" +
    "<div class='field'><label>Telefono</label>" +
    "<input type='tel' id='ch-tel' maxlength='20' inputmode='tel' placeholder='600 000 000' value='" +
    escTexto(chofer.telefono) + "'></div>" +
    "<div id='ch-error' style='color:#D41F3A;font-size:13px;margin-bottom:10px;display:none'></div>" +
    "<button class='btn-primary' onclick='guardarChofer()'>Continuar</button>" +
    (chofer.nombre ? "<button class='btn-ghost' style='margin-top:8px' onclick='cancelarChofer()'>Cancelar</button>" : "") +
    "</div>";
}

async function guardarChofer() {
  const nombre = document.getElementById("ch-nombre").value.trim();
  const tel    = document.getElementById("ch-tel").value.trim();
  const err    = document.getElementById("ch-error");

  if (!nombre) { err.textContent = "Escribe tu nombre."; err.style.display = "block"; return; }
  if (!tel)    { err.textContent = "Escribe tu telefono."; err.style.display = "block"; return; }

  chofer = { nombre: nombre, telefono: tel };
  try { localStorage.setItem(CHOFER_KEY, JSON.stringify(chofer)); } catch (e) {}

  _choferSync = "";        // forzar la escritura aunque sea la misma lanzadera
  await sincronizarChofer();

  _editandoChofer = false;
  render();
}

function cancelarChofer() { _editandoChofer = false; render(); }
function editarChofer()   { _editandoChofer = true;  render(); }

// Lleva la identidad del dispositivo a Firestore, que es de donde la lee el
// panel. Hace falta porque el formulario solo aparece la primera vez: sin esto,
// un conductor que ya tuviera sus datos guardados no volvia a escribir nunca y
// el panel se quedaba vacio. Se llama al saber la lanzadera y en cada
// movimiento; solo escribe si algo ha cambiado.
let _choferSync = "";

// forzar=true ignora la cache local y reescribe siempre. Hace falta en cada
// movimiento real (escribir()): si el servidor borro la ficha por otro motivo
// (p.ej. choferUnaLanzadera al detectar el mismo telefono en otra lanzadera),
// el movil no se entera y, sin forzar, pensaria que ya esta sincronizado y no
// la volveria a escribir nunca -> la lanzadera se quedaria "sin identificar"
// aunque siga registrando movimientos con normalidad.
async function sincronizarChofer(forzar) {
  if (!sel.numero || !chofer.nombre) return;
  const huella = sel.numero + "|" + chofer.nombre + "|" + chofer.telefono;
  if (!forzar && _choferSync === huella) return;
  try {
    await db.collection("lanzaderas_chofer").doc(String(sel.numero)).set({
      numero:   sel.numero,
      nombre:   chofer.nombre,
      telefono: chofer.telefono,
      ts:       firebase.firestore.Timestamp.now()
    });
    _choferSync = huella;
  } catch (e) {
    console.warn("sincronizar chofer:", e.message);
  }
}

// Estado ya registrado en el servidor para esta lanzadera (en_nave/transito),
// para no volver a preguntar "¿donde estas?" si ya lo sabemos por Firestore.
// Se actualiza en cada escritura (escribir()) y se recupera al abrir la app
// (recuperarEstadoActivo()). null = no hay estado activo o aun no se sabe.
let estadoActivoServidor = null;

function render() {
  ensureChatLanz();
  if (!sel.numero) return renderLanzaderas();
  if (!chofer.nombre || _editandoChofer) return renderChofer();
  if (estadoActivoServidor) return renderHecho(estadoActivoServidor.estado);
  if (!sel.nave)   return renderNaves();
  if (sel.nave === "plaza" && !sel.muelle) return renderMuelles();
  if (sel.nave === "merca" && !sel.muelle) return renderMuellesMerca();
  return renderConfirmar();
}

// Al abrir la app, mira si esta lanzadera ya estaba registrada como activa
// (en una nave o en transito) y salta directo a esa pantalla, en vez de
// pedir otra vez "¿donde estas?". Si no hay nada activo, sigue el flujo
// normal de siempre.
async function recuperarEstadoActivo() {
  if (!sel.numero) { render(); return; }
  try {
    const d = await db.collection("lanzaderas").doc(String(sel.numero)).get();
    if (d.exists && d.data().activa) {
      const data = d.data();
      sel.nave    = data.nave    || null;
      sel.muelle  = data.muelle  || null;
      sel.accion  = data.accion  || null;
      sel.destino = data.destino || null;
      estadoActivoServidor = { estado: data.estado };
    } else {
      estadoActivoServidor = null;
    }
  } catch (e) { console.warn("recuperar estado lanzadera:", e.message); }
  render();
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
    "<div class='temp-btn' onclick=\"pedirOtroLugar('estoy')\" style='border-style:dashed'>" +
    "<div class='temp-icon'>📍</div><div class='temp-name'>Otro lugar</div></div>" +
    "</div>" +
    "<button class='btn-back' style='width:100%;margin-top:12px' onclick='volver(\"nave\")'>&#8592; Atras</button>" +
    "</div>";
}

// ── Lugares que no estan en la lista ────────────────────────────────────────
// El nombre escrito se guarda tal cual en el campo "nave" (o "destino"), que en
// las reglas ya es texto libre. El panel, la vista movil y los informes lo
// muestran sin cambios porque todos hacen NAVE_NOMBRE[x] || x.
//
// Los ultimos lugares escritos se recuerdan en el propio movil, para que el
// conductor que va a menudo al mismo sitio no tenga que teclearlo cada vez. Si
// un lugar se vuelve habitual, lo suyo es añadirlo en Config desde el panel.

const OTROS_KEY = "otros_lugares";
const MAX_OTROS = 6;

function otrosLugares() {
  try {
    const l = JSON.parse(localStorage.getItem(OTROS_KEY) || "[]");
    return Array.isArray(l) ? l.filter(x => typeof x === "string" && x) : [];
  } catch (e) { return []; }
}

function recordarLugar(nombre) {
  try {
    const l = otrosLugares().filter(x => x.toLowerCase() !== nombre.toLowerCase());
    l.unshift(nombre);
    localStorage.setItem(OTROS_KEY, JSON.stringify(l.slice(0, MAX_OTROS)));
  } catch (e) {}
}

// modo: "estoy" (donde esta ahora) o "voy" (hacia donde sale)
function pedirOtroLugar(modo) {
  const recientes = otrosLugares();
  app.innerHTML =
    "<div class='card'>" + cabecera() +
    "<h2>" + (modo === "voy" ? "¿A donde vas?" : "¿Donde estas?") + "</h2>" +
    "<p class='card-desc'>Escribe el nombre del sitio. Lo vera el almacen tal cual.</p>" +
    (recientes.length
      ? "<p class='card-desc' style='margin-bottom:6px'>Ultimos sitios:</p>" +
        "<div style='display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px'>" +
        recientes.map(r =>
          "<button class='chatov-chip' style='background:#F3F4F6;border:none;border-radius:16px;" +
          "padding:7px 14px;font-size:13px;font-family:Inter,sans-serif'" +
          " onclick=\"usarOtroLugar('" + modo + "', '" + escTexto(r).replace(/'/g, "&#39;") + "')\">" +
          escTexto(r) + "</button>"
        ).join("") + "</div>"
      : "") +
    "<div class='field'><label>Nombre del sitio</label>" +
    "<input type='text' id='otro-nombre' maxlength='60' autocomplete='off' " +
    "placeholder='Ej: Mercadona Plaza'></div>" +
    "<div id='otro-error' style='color:#D41F3A;font-size:13px;margin-bottom:10px;display:none'></div>" +
    "<button class='btn-primary' onclick=\"confirmarOtroLugar('" + modo + "')\">Continuar</button>" +
    "<button class='btn-back' style='width:100%;margin-top:8px' onclick='" +
    (modo === "voy" ? "salir()" : "render()") + "'>&#8592; Atras</button>" +
    "</div>";
  const i = document.getElementById("otro-nombre");
  if (i) i.focus();
}

function confirmarOtroLugar(modo) {
  const nombre = (document.getElementById("otro-nombre").value || "").trim();
  const err = document.getElementById("otro-error");
  if (nombre.length < 2) {
    err.textContent = "Escribe el nombre del sitio.";
    err.style.display = "block";
    return;
  }
  usarOtroLugar(modo, nombre);
}

function usarOtroLugar(modo, nombre) {
  recordarLugar(nombre);
  if (modo === "voy") {
    sel.destino = nombre;
    registrarTransito();
  } else {
    // Un lugar de fuera no tiene muelles nuestros: se registra como presencia.
    sel.nave   = nombre;
    sel.accion = "presente";
    sel.muelle = null;
    render();
  }
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
    // Un lugar escrito a mano no esta en NOMBRE_NAVE: se muestra tal cual.
    : (NOMBRE_NAVE[sel.nave] || sel.nave || "—");
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
    const conMuelle = sel.nave === "plaza" || sel.nave === "merca";
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>✓</div><h2>Registrado</h2>" +
      "<p class='card-desc'>Lanzadera " + sel.numero + " en " + escTexto(NOMBRE_NAVE[sel.nave] || sel.nave || "—") +
      (conMuelle && sel.muelle ? " · " + escTexto(sel.muelle) : "") + ".</p>" +
      "<button class='btn-primary' style='width:100%' onclick='salir()'>Salir de la nave</button>" +
      (conMuelle ? "<button class='btn-back' style='width:100%;margin-top:8px' onclick='cambiarMuelle()'>Cambiar de muelle</button>" : "") +
      "<button class='btn-back' style='width:100%;margin-top:8px' onclick='nuevo()'>Nuevo registro</button>" +
      "<button class='btn-back' style='width:100%;margin-top:8px;color:#D41F3A;border-color:#F5C0C8' onclick='finJornada()'>Fin de jornada</button>" +
      "</div>";
  } else if (estado === "transito") {
    app.innerHTML =
      "<div class='card text-center'>" +
      "<div class='done-icon'>🚚</div><h2>En transito</h2>" +
      "<p class='card-desc'>Lanzadera " + sel.numero + " en transito hacia <strong>" + escTexto(NOMBRE_NAVE[sel.destino] || sel.destino || "destino") + "</strong>.</p>" +
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
  return "<div class='step-indicator'>Lanzadera " + sel.numero +
    (chofer.nombre ? " &middot; " + escTexto(chofer.nombre) : "") + "</div>" +
    (chofer.nombre
      ? "<div style='text-align:center;margin:-6px 0 10px'>" +
        "<a href='#' onclick='editarChofer();return false' " +
        "style='font-size:12px;color:#9CA3AF;text-decoration:none'>No soy yo, cambiar conductor</a></div>"
      : "");
}

function pickLanzadera(n) { sel.numero = n; cargarChoferLocal(); sincronizarChofer(); precalentarPermisoUbicacion(); recuperarEstadoActivo(); }
function pickNave(id)     { sel.nave = id; sel.accion = null; sel.muelle = null; render(); }
function pickMuelle(m) {
  sel.muelle = m;
  // En Plaza se deduce carga/descarga segun el muelle elegido
  if (sel.nave === "plaza") sel.accion = MUELLES_CARGA.indexOf(m) !== -1 ? "cargando" : "descargando";
  render();
}

// Cuando ya estan "en_nave" en Plaza o Merca, permite ir directo a elegir
// otro muelle sin pasar por todo el ciclo de salir/elegir destino/llegar.
// Se guarda el muelle anterior para poder volver sin perderlo si se
// arrepienten a mitad del cambio.
let _muelleAnterior = null;

function cambiarMuelle() {
  _muelleAnterior = sel.muelle;
  sel.muelle = null;
  estadoActivoServidor = null;
  render();
}

function cancelarCambioMuelle() {
  sel.muelle = _muelleAnterior;
  _muelleAnterior = null;
  estadoActivoServidor = { estado: "en_nave" };
  render();
}

function volver(desde) {
  if (desde === "nave")   { sel.numero = paramL ? sel.numero : null; if (!paramL) sel.numero = null; }
  if (desde === "muelle") {
    if (sel.nave === "plaza") { sel.muelle = null; sel.accion = null; }
    else if (sel.nave === "merca") { sel.muelle = null; }
    else { sel.nave = null; sel.accion = null; }   // externa o lugar manual
  }
  if (desde === "merca-nave" || desde === "plaza-nave") {
    if (_muelleAnterior !== null) { cancelarCambioMuelle(); return; }
    sel.nave = null; sel.muelle = null; sel.accion = null;
  }
  render();
}

function nuevo() {
  sel = { numero: paramL ? +paramL : null, nave: null, accion: null, muelle: null, destino: null };
  estadoActivoServidor = null; // registro manual: no volver a saltar al estado anterior
  _muelleAnterior = null;
  render();
}

// Ubicacion GPS solo en el momento de registrar un movimiento (no en
// continuo, para no gastar bateria/datos del chofer). Si el navegador no
// tiene geolocalizacion, el permiso esta denegado o tarda demasiado,
// sencillamente no se manda lat/lng y el mapa del panel lo trata como
// "sin señal" para esa lanzadera.
function obtenerUbicacion() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      e => { console.warn("GPS:", e.message); resolve(null); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  });
}

// La primera vez que el navegador pide permiso de ubicacion, el chofer puede
// tardar en contestar al aviso mas de lo que se espera dentro de un registro
// (obtenerUbicacion corta a los 8s para no retrasar el "Registrar"). Por eso
// se pide el permiso pronto, en cuanto se sabe la lanzadera, sin bloquear
// nada: si tarda o lo deniegan aqui no pasa nada, solo es para que el
// permiso ya este concedido de antemano cuando llegue el primer movimiento
// real y esa lectura sea instantanea.
function precalentarPermisoUbicacion() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 20000, maximumAge: 60000 });
}

async function escribir(estado, activa) {
  const geo = await obtenerUbicacion();
  const datos = {
    numero:      sel.numero,
    estado:      estado,
    nave:        sel.nave,
    accion:      sel.nave === "plaza" ? sel.accion : "presente",
    muelle:      (sel.nave === "plaza" || sel.nave === "merca") ? sel.muelle : null,
    destino:     estado === "transito" ? (sel.destino || null) : null,
    activa:      activa,
    lat:         geo ? geo.lat : null,
    lng:         geo ? geo.lng : null,
    desde:       firebase.firestore.Timestamp.now(),
    actualizado: firebase.firestore.Timestamp.now()
  };
  await db.collection("lanzaderas").doc(String(sel.numero)).set(datos); // estado en vivo
  await db.collection("lanzaderas_log").add(datos);                     // historico
  // Aprende donde esta cada nave (y cada muelle dentro de Plaza/Merca, que
  // no estan todos en el mismo sitio) a partir de los GPS reales de
  // llegada: asi el mapa del panel ubica cada lanzadera en su muelle real
  // en vez de en un punto generico de la nave, sin tener que introducir
  // coordenadas a mano en ningun sitio.
  if (estado === "en_nave" && geo && sel.nave) {
    const ts = firebase.firestore.Timestamp.now();
    if (sel.muelle) {
      db.collection("ubicaciones_naves").doc(sel.nave + "_" + sel.muelle).set({
        lat: geo.lat, lng: geo.lng, actualizado: ts
      }).catch(e => console.warn("ubicacion muelle:", e.message));
    }
    // Entrada general de la nave (sin muelle): aproximada al ultimo muelle
    // usado, para cuando se traza la ruta de un transito hacia ahi sin
    // saber aun a que muelle exacto va a ir.
    db.collection("ubicaciones_naves").doc(sel.nave).set({
      lat: geo.lat, lng: geo.lng, actualizado: ts
    }).catch(e => console.warn("ubicacion nave:", e.message));
  }
  estadoActivoServidor = activa ? { estado: estado } : null;
  _muelleAnterior = null; // el cambio de muelle (si lo habia) ya quedo confirmado
  // Al fichar fin de jornada el servidor borra el conductor, asi que no se
  // vuelve a escribir; en cualquier otro movimiento se fuerza la reescritura
  // (ver comentario en sincronizarChofer) para que se autorepare sola si el
  // servidor la borro por otro motivo.
  if (estado !== "fuera") await sincronizarChofer(true);
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
    "<div class='temp-btn' onclick=\"pedirOtroLugar('voy')\" style='border-style:dashed'>" +
    "<div class='temp-icon'>📍</div><div class='temp-name'>Otro lugar</div></div>" +
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
  estadoActivoServidor = null; // se sale del "transito" registrado, toca elegir muelle antes de volver a escribir
  if (sel.nave && sel.nave !== "plaza" && sel.nave !== "merca") registrar(); // llegada directa a nave externa (cierra el transito)
  else render();                                      // Plaza o Merca: elegir muelle
}

// ─── CHAT con el almacen ─────────────────────────────────────────────
let _chatUnsub = null, _chatMsgs = [], _chatNum = null;
let _beepInit = false, _beepMaxTs = 0;

// ─── AVISO SONORO ────────────────────────────────────────────────────
let _audioCtx = null;
function unlockAudio() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
  } catch (e) {}
}
document.addEventListener("click", unlockAudio);
document.addEventListener("touchstart", unlockAudio);

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
      g.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      o.start(start); o.stop(start + 0.18);
    });
  } catch (e) {}
}

function ensureChatLanz() {
  if (!sel.numero) return;
  document.getElementById("chat-fab").style.display = "block";
  if (typeof initPush === "function") initPush("lanzadera", sel.numero);
  if (_chatNum === sel.numero) return;
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
  _chatNum = sel.numero; _chatMsgs = [];
  _beepInit = false; _beepMaxTs = 0;
  // Solo mensajes del dia y maximo 100: evita releer todo el historico en cada reconexion
  const _hoy0 = new Date(); _hoy0.setHours(0, 0, 0, 0);
  _chatUnsub = db.collection("mensajes").where("lanzadera", "==", sel.numero)
    .where("ts", ">=", firebase.firestore.Timestamp.fromDate(_hoy0))
    .orderBy("ts", "desc").limit(100)
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
  // Aviso sonoro al recibir un mensaje nuevo del almacen
  let maxAlm = 0;
  _chatMsgs.forEach(m => { if (m.de === "almacen" && m.ts) maxAlm = Math.max(maxAlm, m.ts.toMillis()); });
  if (_beepInit && maxAlm > _beepMaxTs) beep();
  _beepMaxTs = Math.max(_beepMaxTs, maxAlm);
  _beepInit = true;
  if (document.getElementById("chat-overlay").style.display !== "none") renderChatLanz();
}

function horaChat(ts) {
  if (!ts) return "";
  const d = ts.toDate();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

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

function renderChatLanz() {
  const cont = document.getElementById("chat-ov-msgs");
  let _prevDia = null;
  cont.innerHTML = _chatMsgs.length
    ? _chatMsgs.map(m => {
        const right = m.de === "lanzadera";
        const emisor = (!right && m.emisor)
          ? "<span class='chat-emisor'>" + escTexto(m.emisor) + "</span>" : "";
        const hora = "<span class='chat-time'>" + horaChat(m.ts) + "</span>";
        let sep = "";
        const dia = m.ts ? diaChat(m.ts) : "";
        if (dia && dia !== _prevDia) { sep = "<div class='chat-day'>" + dia + "</div>"; _prevDia = dia; }
        const foto = (typeof Fotos !== "undefined") ? Fotos.thumbHtml(m) : "";
        return sep + "<div class='chat-row " + (right ? "r" : "l") + "'><div class='chat-b " + (right ? "chat-b-out" : "chat-b-in") + "'>" + emisor + foto + escTexto(m.texto) + hora + "</div></div>";
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
    ["👍", "🙏", "Voy", "OK", "5 min", "Cargando", "Problema"].map(q => "<button class='chatov-chip' onclick=\"enviarChatLanz('" + q + "')\">" + q + "</button>").join("");
  document.getElementById("chat-overlay").style.display = "flex";
  renderChatLanz();
}

function cerrarChat() { document.getElementById("chat-overlay").style.display = "none"; }

function enviarFotoLanz() {
  if (!sel.numero || typeof Fotos === "undefined") return;
  Fotos.enviar({
    lanzadera: sel.numero,
    de:        "lanzadera",
    onEstado:  function (txt) {
      const b = document.getElementById("chat-ov-text");
      if (b) b.placeholder = txt || "Escribe un mensaje...";
    }
  });
}

async function enviarChatLanz(textoOpt) {
  const inp = document.getElementById("chat-ov-text");
  const texto = (textoOpt != null ? textoOpt : inp.value).trim();
  if (!texto || !sel.numero) return;
  try {
    await db.collection("mensajes").add({ lanzadera: sel.numero, de: "lanzadera", texto: texto, ts: firebase.firestore.Timestamp.now() });
    if (textoOpt == null) inp.value = "";
  } catch (e) { console.error(e); alert("No se pudo enviar."); }
}

// Carga destinos configurados desde Firestore (si existen) y lanza render
db.collection("config").doc("destinos").onSnapshot(d => {
  if (d.exists && Array.isArray(d.data().lista) && d.data().lista.length) {
    NAVES.splice(0, NAVES.length, ...d.data().lista.map(n => ({
      id: n.id, nombre: n.nombre, externa: n.id !== "plaza"
    })));
    d.data().lista.forEach(n => { NOMBRE_NAVE[n.id] = n.nombre; });
    render();
  }
}, () => {});

// Si la lanzadera venia fijada en el QR (?l=N), recuperar los datos del
// conductor guardados en este movil antes del primer pintado.
cargarChoferLocal();
sincronizarChofer();
if (sel.numero) precalentarPermisoUbicacion();

if (sel.numero) recuperarEstadoActivo(); else render();
