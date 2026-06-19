// Registro de descarga de proveedor en Merca (al momento)

const MUELLES_MERCA = ["M2", "M4"];

function val(id) { return document.getElementById(id).value.trim(); }

async function registrarMerca() {
  const empresa   = val("m-empresa");
  const matricula = val("m-matricula").toUpperCase();
  const muelle    = document.getElementById("m-muelle").value;
  if (!empresa)   { alert("Introduce la empresa / proveedor."); return; }
  if (!matricula) { alert("Introduce la matricula."); return; }
  if (!muelle)    { alert("Selecciona el muelle."); return; }

  const btn = document.getElementById("m-btn");
  btn.disabled = true; btn.textContent = "Registrando...";
  const palesV = val("m-pales");
  try {
    await db.collection("descargas_merca").add({
      empresa:    empresa,
      matricula:  matricula,
      mercancia:  val("m-mercancia"),
      pales:      palesV ? Number(palesV) : null,
      muelle:     muelle,
      estado:     "descargando",
      inicio:     firebase.firestore.Timestamp.now(),
      fin:        null,
      created_at: firebase.firestore.Timestamp.now()
    });
    document.getElementById("m-form").style.display = "none";
    document.getElementById("m-hecho-muelle").textContent = "Muelle " + muelle.replace("M", "");
    document.getElementById("m-hecho").style.display = "block";
  } catch (e) {
    console.error(e);
    alert("No se pudo registrar la descarga. Reintenta.");
    btn.disabled = false; btn.textContent = "Registrar descarga";
  }
}

function nuevaMerca() { location.reload(); }

window.addEventListener("DOMContentLoaded", function () {
  document.getElementById("m-muelle").innerHTML =
    "<option value=''>Selecciona muelle</option>" +
    MUELLES_MERCA.map(m => "<option value='" + m + "'>Muelle " + m.replace("M", "") + "</option>").join("");
});
