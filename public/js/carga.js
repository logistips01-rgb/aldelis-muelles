// Registro de carga (al momento) por el transportista

const MUELLES_CARGA = ["M1", "M2", "M3", "M4", "M5"];

function val(id) { return document.getElementById(id).value.trim(); }

async function registrarCarga() {
  const c = {
    matricula_tractora: val("c-tractora").toUpperCase(),
    matricula_semi:     val("c-semi").toUpperCase(),
    chofer:             val("c-chofer"),
    dni:                val("c-dni").toUpperCase(),
    destino:            val("c-destino"),
    muelle:             document.getElementById("c-muelle").value
  };
  if (!c.matricula_tractora) { alert("Introduce la matricula de la tractora."); return; }
  if (!c.muelle)             { alert("Selecciona el muelle de carga."); return; }

  const btn = document.getElementById("c-btn");
  btn.disabled = true; btn.textContent = "Registrando...";
  try {
    await db.collection("cargas").add({
      matricula_tractora: c.matricula_tractora,
      matricula_semi:     c.matricula_semi,
      chofer:             c.chofer,
      dni:                c.dni,
      destino:            c.destino,
      muelle:             c.muelle,
      estado:             "cargando",
      inicio:             firebase.firestore.Timestamp.now(),
      fin:                null,
      created_at:         firebase.firestore.Timestamp.now()
    });
    document.getElementById("c-form").style.display = "none";
    document.getElementById("c-hecho-muelle").textContent = c.muelle;
    document.getElementById("c-hecho").style.display = "block";
  } catch (e) {
    console.error(e);
    alert("No se pudo registrar la carga. Reintenta.");
    btn.disabled = false; btn.textContent = "Registrar carga";
  }
}

function nuevaCarga() { location.reload(); }

// Rellenar el selector de muelles
window.addEventListener("DOMContentLoaded", function () {
  document.getElementById("c-muelle").innerHTML =
    "<option value=''>Selecciona muelle</option>" +
    MUELLES_CARGA.map(m => "<option value='" + m + "'>Muelle " + m.replace("M", "") + "</option>").join("");
});
