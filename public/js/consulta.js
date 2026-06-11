// Escapa texto antes de insertarlo como HTML (proteccion anti-XSS)
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

async function buscarReserva() {
  const input = document.getElementById("input-buscar").value.trim().toUpperCase();
  const err   = document.getElementById("buscar-error");
  err.style.display = "none";

  if (!input) {
    err.textContent = "Introduce un codigo o matricula.";
    err.style.display = "block";
    return;
  }

  let reserva = null;

  const porCodigo = await db.collection("reservas").where("codigo", "==", input).get();
  if (!porCodigo.empty) {
    reserva = porCodigo.docs[0].data();
  } else {
    const porMatricula = await db.collection("reservas").where("matricula", "==", input).get();
    if (!porMatricula.empty) {
      const todas = porMatricula.docs.map(d => d.data());
      todas.sort((a, b) => b.fecha.localeCompare(a.fecha));
      reserva = todas[0];
    }
  }

  if (!reserva) {
    err.textContent = "No se encontro ninguna reserva con ese codigo o matricula.";
    err.style.display = "block";
    return;
  }

  mostrarResultado(reserva);
}

function mostrarResultado(r) {
  const configs = {
    pendiente:  { color: "#633806", bg: "#FAEEDA", border: "#FAC775", icono: "⏱", titulo: "Pendiente de confirmacion", desc: "Tu solicitud ha sido recibida. El equipo de Aldelis la confirmara en breve." },
    confirmada: { color: "#27500A", bg: "#EAF3DE", border: "#A8D87A", icono: "✓", titulo: "Reserva confirmada", desc: "Tu descarga esta confirmada. Presentate con este codigo a tu llegada." },
    reasignada: { color: "#0C447C", bg: "#E6F1FB", border: "#B5D4F4", icono: "⇄", titulo: "Reserva reasignada", desc: "El almacen ha modificado tu reserva. Revisa el nuevo horario." },
    rechazada:  { color: "#D41F3A", bg: "#FBEAED", border: "#F5C0C8", icono: "✕", titulo: "Reserva no aceptada", desc: "No ha sido posible aceptar tu solicitud." },
    en_curso:   { color: "#D41F3A", bg: "#FBEAED", border: "#F5C0C8", icono: "▶", titulo: "Descarga en curso", desc: "Tu vehiculo esta siendo atendido en el muelle." },
    completada: { color: "#6B7280", bg: "#F0F0F0", border: "#E0E0E0", icono: "✔", titulo: "Descarga completada", desc: "La descarga ha sido completada correctamente." },
  };

  const c = configs[r.estado] || configs.pendiente;

  const rows = [
    ["Codigo", r.codigo], ["Empresa", r.empresa], ["Matricula", r.matricula],
    ["Fecha", r.fecha], ["Franja", r.franja], ["Temperatura", r.temperatura],
    r.muelle       ? ["Muelle asignado", r.muelle]       : null,
    r.motivo       ? ["Motivo",          r.motivo]       : null,
    r.nota_almacen ? ["Nota almacen",    r.nota_almacen] : null,
  ].filter(Boolean);

  document.getElementById("resultado-content").innerHTML =
    "<div class='card' style='margin-bottom:12px;border:1.5px solid " + c.border + ";background:" + c.bg + "'>" +
    "<div style='display:flex;align-items:center;gap:12px'>" +
    "<div style='font-size:32px'>" + c.icono + "</div>" +
    "<div><div style='font-size:16px;font-weight:600;color:" + c.color + "'>" + c.titulo + "</div>" +
    "<div style='font-size:13px;color:" + c.color + ";margin-top:3px'>" + c.desc + "</div></div></div></div>" +
    "<div class='card'><div class='resumen'>" +
    rows.map(function(row) {
      return "<div class='resumen-row'><span class='resumen-label'>" + esc(row[0]) + "</span><span class='resumen-value'>" + esc(row[1]) + "</span></div>";
    }).join("") +
    "</div>" +
    (r.estado === "rechazada" ? "<button class='btn-primary' style='margin-top:16px' onclick=\"window.location.href='index.html'\">Hacer nueva reserva</button>" : "") +
    (r.estado === "reasignada" ? "<div class='notice' style='margin-top:16px'>Tu franja original ha sido modificada. Si el nuevo horario no te conviene, contacta con el almacen.</div>" : "") +
    "</div>";

  document.getElementById("pantalla-buscar").style.display    = "none";
  document.getElementById("pantalla-resultado").style.display = "block";
  window.scrollTo(0, 0);
}

function volver() {
  document.getElementById("pantalla-buscar").style.display    = "block";
  document.getElementById("pantalla-resultado").style.display = "none";
  document.getElementById("input-buscar").value = "";
}
