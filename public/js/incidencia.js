// Apertura de incidencia Bizerba por produccion (sin login)

const LINEAS_BIZERBA = Array.from({ length: 17 }, (_, i) => i); // 0..16

function val(id) { return document.getElementById(id).value.trim(); }

async function abrirIncidencia() {
  const lineaV = document.getElementById("i-linea").value;
  const averia = val("i-averia");
  if (lineaV === "") { alert("Selecciona la linea."); return; }
  if (!averia)       { alert("Describe la averia."); return; }

  const btn = document.getElementById("i-btn");
  btn.disabled = true; btn.textContent = "Abriendo...";
  try {
    await db.collection("incidencias").add({
      linea:        Number(lineaV),
      averia:       averia,
      estado:       "abierta",
      tecnico:      null,
      observaciones: "",
      creada:       firebase.firestore.Timestamp.now(),
      aceptada:     null,
      resuelta:     null,
      created_at:   firebase.firestore.Timestamp.now()
    });
    document.getElementById("i-form").style.display = "none";
    document.getElementById("i-hecho-linea").textContent = "Linea " + lineaV;
    document.getElementById("i-hecho").style.display = "block";
  } catch (e) {
    console.error(e);
    alert("No se pudo abrir la incidencia. Reintenta.");
    btn.disabled = false; btn.textContent = "Abrir incidencia";
  }
}

function nuevaIncidencia() { location.reload(); }

window.addEventListener("DOMContentLoaded", function () {
  document.getElementById("i-linea").innerHTML =
    "<option value=''>Selecciona linea</option>" +
    LINEAS_BIZERBA.map(l => "<option value='" + l + "'>Linea " + l + "</option>").join("");
});
