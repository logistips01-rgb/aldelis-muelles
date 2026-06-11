// Envio de email via Firebase Function
async function enviarEmailMS(to, subject, body) {
  if (!to) return;
  try {
    const enviarEmail = firebase.functions().httpsCallable("enviarEmail");
    await enviarEmail({ to, subject, body });
    console.log("Email enviado OK a " + to);
  } catch(e) {
    console.error("Error enviando email:", e);
  }
}

async function enviarEmailAdminMS(datos) {
  const admins = [
    "mlorente@aldelis.com",
    "garita@aldelis.com"
  ];
  const subject = "Nueva solicitud de descarga pendiente — " + datos.codigo;
  const body = "Nueva solicitud de descarga recibida y pendiente de confirmacion.\n\n" +
    "Codigo: " + datos.codigo + "\n" +
    "Empresa: " + datos.empresa + "\n" +
    "Matricula: " + datos.matricula + "\n" +
    "Fecha: " + datos.fecha + "\n" +
    "Franja: " + datos.franja + "\n" +
    "Seccion: " + datos.seccion + "\n" +
    "Mercancia: " + (datos.mercancia || "No indicada") + "\n" +
    "Pales: " + (datos.pales ? datos.pales + " pales" : "No indicado") + "\n\n" +
    "Accede al panel para confirmar, reasignar o rechazar:\nhttps://aldelis-muelles.web.app/admin.html";

  for (const admin of admins) {
    await enviarEmailMS(admin, subject, body);
  }
}

// ─── RESTO DEL SISTEMA ───────────────────────────────────────────────

const reserva = {
  matricula: "", empresa: "", conductor: "", email: "",
  temperatura: "", seccion: "", mercancia: "", pales: "", peso: "", observaciones: "",
  franja: "", fecha: "", codigo: ""
};

const MUELLES_SECO     = ["M6", "M7", "M8"];
const MUELLES_FRIO     = ["M20", "M18", "M19"];
const MUELLES_LAVADERO = ["M9", "M10"];

const FRANJAS_SECO = [
  "21:30 - 22:00",
  "06:00 - 06:30", "06:30 - 07:00",
  "07:00 - 07:30", "07:30 - 08:00",
  "08:00 - 08:30", "08:30 - 09:00",
  "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00",
  "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00",
  "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00"
];

const FRANJAS_FRIO = [
  "06:00 - 06:30", "06:30 - 07:00",
  "07:00 - 07:30", "07:30 - 08:00",
  "08:00 - 08:30", "08:30 - 09:00",
  "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00",
  "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00",
  "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00",
  "15:00 - 15:30", "15:30 - 16:00",
  "16:00 - 16:30", "16:30 - 17:00",
  "17:00 - 17:30", "17:30 - 18:00",
  "18:00 - 18:30", "18:30 - 19:00",
  "19:00 - 19:30", "19:30 - 20:00",
  "20:00 - 20:30", "20:30 - 21:00",
  "21:00 - 21:30", "21:30 - 22:00"
];

const FRANJAS_LAVADERO = [
  "08:30 - 09:00",
  "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00",
  "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00",
  "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00",
  "15:00 - 15:30", "15:30 - 16:00",
  "16:00 - 16:30", "16:30 - 17:00"
];

function getFranjas(seccion) {
  if (seccion === "lavadero") return FRANJAS_LAVADERO;
  if (seccion === "frio")     return FRANJAS_FRIO;
  return FRANJAS_SECO;
}

function getMuelles(seccion) {
  if (seccion === "lavadero") return MUELLES_LAVADERO;
  if (seccion === "frio")     return MUELLES_FRIO;
  return MUELLES_SECO;
}

function goStep(n) {
  if (n === 2) {
    const mat = document.getElementById("matricula").value.trim();
    const emp = document.getElementById("empresa").value.trim();
    if (!mat || !emp) { alert("Por favor rellena la matricula y la empresa."); return; }
    reserva.matricula = mat.toUpperCase();
    reserva.empresa   = emp;
    reserva.conductor = document.getElementById("conductor").value.trim();
    reserva.email     = document.getElementById("email").value.trim();
  }

  if (n === 3) {
    if (!reserva.seccion) { alert("Por favor selecciona la seccion de descarga."); return; }
    if (reserva.seccion === "frio") {
      const sel = document.getElementById("select-temperatura");
      if (sel) reserva.temperatura = sel.value;
    }
    reserva.mercancia     = document.getElementById("mercancia").value.trim();
    reserva.pales         = document.getElementById("pales").value.trim();
    reserva.peso          = document.getElementById("peso").value.trim();
    reserva.observaciones = document.getElementById("observaciones").value.trim();
    const hoy = new Date().toISOString().split("T")[0];
    const inputFecha = document.getElementById("fecha-reserva");
    inputFecha.min = hoy;
    if (!inputFecha.value) inputFecha.value = hoy;
    reserva.fecha = inputFecha.value;
    cargarFranjas();
    inputFecha.onchange = () => {
      reserva.fecha  = inputFecha.value;
      reserva.franja = "";
      cargarFranjas();
    };
  }

  if (n === 4) {
    if (!reserva.franja) { alert("Por favor selecciona una franja horaria."); return; }
    reserva.fecha = document.getElementById("fecha-reserva").value;
    mostrarResumen();
  }

  document.querySelectorAll(".step").forEach(s => s.classList.remove("active"));
  const target = document.getElementById("step-" + n);
  if (target) target.classList.add("active");
  window.scrollTo(0, 0);
}

function selectSeccion(sec, el) {
  reserva.seccion     = sec;
  reserva.temperatura = sec === "frio" ? "refrigerado" : "ambiente";
  reserva.franja      = "";
  document.querySelectorAll(".temp-btn").forEach(b => b.classList.remove("selected"));
  el.classList.add("selected");
  const hint = document.getElementById("hint-temperatura");
  if (hint) hint.style.display = sec === "frio" ? "block" : "none";
}

async function cargarFranjas() {
  const fecha = document.getElementById("fecha-reserva").value;
  const container = document.getElementById("franjas-container");
  container.innerHTML = "<p style='color:#6B7280;font-size:13px;padding:8px 0'>Cargando franjas...</p>";

  const snap = await db.collection("reservas")
    .where("fecha", "==", fecha)
    .where("seccion", "==", reserva.seccion)
    .where("estado", "in", ["pendiente", "confirmada", "en_curso"])
    .get();

  const ocupacion = {};
  snap.forEach(doc => {
    const d = doc.data();
    if (!ocupacion[d.franja]) ocupacion[d.franja] = 0;
    ocupacion[d.franja]++;
  });

  const franjas   = getFranjas(reserva.seccion);
  const muelles   = getMuelles(reserva.seccion);
  const maxFranja = muelles.length;
  container.innerHTML = "";

  franjas.forEach(franja => {
    const ocupadas = ocupacion[franja] || 0;
    const libre = ocupadas < maxFranja;
    const btn = document.createElement("div");
    btn.className = "franja-btn" + (libre ? "" : " ocupada");
    btn.innerHTML =
      "<div class='franja-hora'>" + franja + "</div>" +
      "<div class='franja-estado " + (libre ? "franja-libre" : "franja-ocupada") + "'>" +
      (libre ? "Disponible" : "Completo") + "</div>";
    if (libre) {
      btn.onclick = () => {
        document.querySelectorAll(".franja-btn").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        reserva.franja = franja;
      };
    }
    container.appendChild(btn);
  });
}

function mostrarResumen() {
  const seccionLabel = { seco: "Almacen Seco", frio: "Almacen Frio / M20", lavadero: "Lavadero" };
  const rows = [
    ["Empresa",   reserva.empresa],
    ["Matricula", reserva.matricula],
    ["Fecha",     reserva.fecha],
    ["Franja",    reserva.franja],
    ["Seccion",   seccionLabel[reserva.seccion] || reserva.seccion],
    ["Temperatura", reserva.temperatura.charAt(0).toUpperCase() + reserva.temperatura.slice(1)],
    ["Mercancia", reserva.mercancia || "No indicada"],
    ["Pales",     reserva.pales ? reserva.pales + " pales" : "No indicado"],
    ["Peso",      reserva.peso  ? reserva.peso  + " kg"    : "No indicado"],
  ];
  document.getElementById("resumen-content").innerHTML = rows.map(function(r) {
    return "<div class='resumen-row'><span class='resumen-label'>" + r[0] + "</span><span class='resumen-value'>" + r[1] + "</span></div>";
  }).join("");
}

function generarCodigo() {
  const fecha = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const rand  = Math.random().toString(36).substring(2, 6).toUpperCase();
  return "ALD-" + fecha + "-" + rand;
}

async function enviarReserva() {
  const btn = document.querySelector("#step-4 .btn-primary");
  btn.disabled = true;
  btn.textContent = "Enviando...";

  try {
    const codigo = generarCodigo();

    await db.collection("reservas").add({
      codigo,
      matricula:     reserva.matricula,
      empresa:       reserva.empresa,
      conductor:     reserva.conductor,
      email:         reserva.email,
      temperatura:   reserva.temperatura,
      seccion:       reserva.seccion,
      mercancia:     reserva.mercancia,
      pales:         reserva.pales  ? Number(reserva.pales)  : null,
      peso:          reserva.peso   ? Number(reserva.peso)   : null,
      observaciones: reserva.observaciones,
      franja:        reserva.franja,
      fecha:         reserva.fecha,
      estado:        "pendiente",
      muelle:        null,
      nota_almacen:  "",
      motivo:        "",
      created_at:    firebase.firestore.Timestamp.now()
    });

    reserva.codigo = codigo;

    // Email al transportista
    if (reserva.email) {
      const secLabel = { seco: "Almacen Seco", frio: "Almacen Frio", lavadero: "Lavadero" };
      await enviarEmailMS(reserva.email,
        "Reserva recibida en Aldelis — " + codigo,
        "Hola " + reserva.empresa + ",\n\n" +
        "Tu solicitud de reserva ha sido recibida correctamente.\n\n" +
        "Codigo de seguimiento: " + codigo + "\n" +
        "Fecha: " + reserva.fecha + "\n" +
        "Franja: " + reserva.franja + "\n" +
        "Seccion: " + (secLabel[reserva.seccion] || reserva.seccion) + "\n\n" +
        "El equipo de Aldelis confirmara tu reserva en breve.\n\n" +
        "Consulta el estado en:\nhttps://aldelis-muelles.web.app/consulta.html\n\n" +
        "Aldelis — Gestion de muelles"
      );
    }

    // Email al equipo de almacen
    await enviarEmailAdminMS({
      codigo,
      empresa:   reserva.empresa,
      matricula: reserva.matricula,
      fecha:     reserva.fecha,
      franja:    reserva.franja,
      seccion:   reserva.seccion,
      mercancia: reserva.mercancia,
      pales:     reserva.pales
    });

    document.getElementById("codigo-generado").textContent = codigo;
    document.querySelectorAll(".step").forEach(s => s.classList.remove("active"));
    document.getElementById("step-done").classList.add("active");
    window.scrollTo(0, 0);

  } catch(e) {
    console.error(e);
    alert("Error al enviar la reserva. Intentalo de nuevo.");
    btn.disabled = false;
    btn.textContent = "Enviar solicitud";
  }
}

function copiarCodigo() {
  const codigo = document.getElementById("codigo-generado").textContent;
  navigator.clipboard.writeText(codigo).then(() => {
    const btn = document.getElementById("btn-copiar");
    btn.textContent = "Copiado!";
    setTimeout(() => btn.textContent = "Copiar codigo", 2000);
  });
}
