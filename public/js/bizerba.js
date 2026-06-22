// App del tecnico Bizerba: ficha con QR (?t=1), ve incidencias abiertas,
// las coge y las marca como resueltas.

const NUM_TECNICOS = 6; // numerados; los nombres se asignaran mas adelante

function escTexto(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

let tecnico = null;
const paramT = new URLSearchParams(location.search).get("t");
if (paramT && +paramT >= 1 && +paramT <= NUM_TECNICOS) tecnico = +paramT;

const app = document.getElementById("app");
let _incidencias = [];
let _unsub = null;

function tiempoDesde(ts) {
  if (!ts) return "";
  const min = Math.floor((Date.now() - ts.toMillis()) / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return "hace " + min + " min";
  const h = Math.floor(min / 60), m = min % 60;
  return "hace " + h + " h" + (m ? " " + String(m).padStart(2, "0") : "");
}

function iniciar() {
  if (!tecnico) return renderIdentificar();
  if (_unsub) return render();
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  _unsub = db.collection("incidencias")
    .where("creada", ">=", firebase.firestore.Timestamp.fromMillis(hoy.getTime()))
    .onSnapshot(s => {
      _incidencias = []; s.forEach(d => _incidencias.push({ id: d.id, ...d.data() }));
      _incidencias.sort((a, b) => (a.creada ? a.creada.toMillis() : 0) - (b.creada ? b.creada.toMillis() : 0));
      render();
    }, e => console.error(e));
  render();
}

function renderIdentificar() {
  app.innerHTML =
    "<div class='card'><h2>Identificate</h2>" +
    "<p class='card-desc'>Selecciona tu numero de tecnico.</p>" +
    "<div class='temp-grid' style='grid-template-columns:1fr 1fr 1fr'>" +
    Array.from({ length: NUM_TECNICOS }, (_, i) => i + 1).map(n =>
      "<div class='temp-btn' onclick='pickTecnico(" + n + ")'>" +
      "<div class='temp-icon'>🔧</div><div class='temp-name'>Tecnico " + n + "</div></div>"
    ).join("") +
    "</div></div>";
}

function pickTecnico(n) { tecnico = n; iniciar(); }

function render() {
  if (!tecnico) return renderIdentificar();
  const mias = _incidencias.filter(i => (i.estado === "aceptada" || i.estado === "repuesto") && i.tecnico === tecnico);
  const abiertas = _incidencias.filter(i => i.estado === "abierta");

  let html = "<div class='card'>" +
    "<div class='step-indicator'>Tecnico " + tecnico + "</div>";

  // Incidencia(s) que estoy atendiendo
  if (mias.length) {
    html += "<h2>Atendiendo ahora</h2>";
    mias.forEach(i => {
      const enRepuesto = i.estado === "repuesto";
      const borde = enRepuesto ? "#E08A00" : "#1D9E75";
      const fondo = enRepuesto ? "#FBF0DA" : "#EAF3DE";
      html += "<div style='border:1.5px solid " + borde + ";border-radius:10px;padding:12px 14px;margin-bottom:10px;background:" + fondo + "'>" +
        "<div style='font-size:16px;font-weight:700;color:#1A1A1A'>Linea " + i.linea + "</div>" +
        "<div style='font-size:14px;color:#374151;margin:4px 0'>" + escTexto(i.averia || "Sin detalle") + "</div>" +
        (enRepuesto ? "<div style='font-size:13px;font-weight:600;color:#B36A00;margin:2px 0'>⏳ Esperando repuesto</div>" : "") +
        (i.observaciones ? "<div style='font-size:13px;color:#4B5563;font-style:italic;margin:2px 0'>“" + escTexto(i.observaciones) + "”</div>" : "") +
        "<div style='font-size:12px;color:#6B7280'>Cogida " + tiempoDesde(i.aceptada) + "</div>" +
        "<textarea id='obs-" + i.id + "' rows='2' placeholder='Que le pasaba / que has hecho / falta repuesto...' " +
        "style='width:100%;margin-top:8px;padding:8px;border:1px solid #B7BDC6;border-radius:8px;font-family:inherit;font-size:14px;box-sizing:border-box'>" + escTexto(i.observaciones || "") + "</textarea>" +
        "<button class='btn-primary' style='width:100%;margin-top:6px' onclick=\"resolver('" + i.id + "')\">Marcar resuelta</button>" +
        "<button class='btn-back' style='width:100%;margin-top:6px' onclick=\"faltaRepuesto('" + i.id + "')\">Falta repuesto (dejar pendiente)</button>" +
        "</div>";
    });
  }

  // Incidencias abiertas para coger
  html += "<h2 style='margin-top:" + (mias.length ? "16px" : "0") + "'>Incidencias abiertas</h2>";
  if (!abiertas.length) {
    html += "<p class='card-desc'>No hay incidencias abiertas ahora mismo.</p>";
  } else {
    abiertas.forEach(i => {
      html += "<div style='border:1px solid #E0E0E0;border-radius:10px;padding:12px 14px;margin-bottom:10px'>" +
        "<div style='display:flex;justify-content:space-between;align-items:center'>" +
        "<div style='font-size:16px;font-weight:700;color:#D41F3A'>Linea " + i.linea + "</div>" +
        "<div style='font-size:12px;color:#9CA3AF'>" + tiempoDesde(i.creada) + "</div></div>" +
        "<div style='font-size:14px;color:#374151;margin:4px 0'>" + escTexto(i.averia || "Sin detalle") + "</div>" +
        "<button class='btn-primary' style='width:100%;margin-top:6px' onclick=\"coger('" + i.id + "')\">Coger esta incidencia</button>" +
        "</div>";
    });
  }

  html += "<button class='btn-back' style='width:100%;margin-top:8px' onclick='cambiarTecnico()'>Cambiar de tecnico</button>";
  html += "</div>";
  app.innerHTML = html;
}

function cambiarTecnico() { if (!paramT) { tecnico = null; renderIdentificar(); } }

async function coger(id) {
  const inc = _incidencias.find(x => x.id === id);
  if (!inc || inc.estado !== "abierta") { alert("Esa incidencia ya no esta disponible."); return; }
  try {
    await db.collection("incidencias").doc(id).update({
      estado: "aceptada",
      tecnico: tecnico,
      aceptada: firebase.firestore.Timestamp.now()
    });
  } catch (e) { console.error(e); alert("No se pudo coger. Reintenta."); }
}

function leerObs(id) {
  const el = document.getElementById("obs-" + id);
  return el ? el.value.trim() : "";
}

async function resolver(id) {
  if (!confirm("¿Marcar esta incidencia como resuelta?")) return;
  try {
    await db.collection("incidencias").doc(id).update({
      estado: "resuelta",
      observaciones: leerObs(id),
      resuelta: firebase.firestore.Timestamp.now()
    });
  } catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

async function faltaRepuesto(id) {
  const obs = leerObs(id);
  if (!obs) { alert("Indica en observaciones que repuesto falta."); return; }
  try {
    await db.collection("incidencias").doc(id).update({
      estado: "repuesto",
      observaciones: obs
    });
  } catch (e) { console.error(e); alert("No se pudo registrar. Reintenta."); }
}

iniciar();
