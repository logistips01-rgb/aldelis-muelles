// Pruebas de las funciones que mantienen "un conductor, una lanzadera".
// Invoca los handlers directamente con eventos simulados y comprueba el efecto
// real en el emulador de Firestore. No se despliega (test-*.js esta ignorado).
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test-chofer.js

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "aldelis-test";
process.env.MS_SECRET = "no-se-usa-aqui";
global.fetch = async () => { throw new Error("no deberia llamar a la red"); };

const admin = require("firebase-admin");
const fn    = require("./index.js");
const db    = admin.firestore();

const correr = (f) => (f.run ? f.run.bind(f) : f);
const choferUnaLanzadera  = correr(fn.choferUnaLanzadera);
const liberarChoferAlSalir = correr(fn.liberarChoferAlSalir);

// Evento de Firestore simulado: solo se usan after.exists, after.data() y params
function evento(id, datos) {
  return {
    params: { id: id },
    data: { after: { exists: datos !== null, data: () => datos } }
  };
}

let pass = 0, fail = 0;
async function t(nombre, f) {
  try { await f(); console.log("  OK   " + nombre); pass++; }
  catch (e) { console.log("  FALLO " + nombre + "\n         " + e.message); fail++; }
}
function igual(real, esperado, que) {
  if (real !== esperado) {
    throw new Error((que || "") + " esperaba " + JSON.stringify(esperado) + ", dio " + JSON.stringify(real));
  }
}

async function limpiar() {
  for (const c of ["lanzaderas_chofer", "lanzaderas"]) {
    const s = await db.collection(c).get();
    for (const d of s.docs) await d.ref.delete();
  }
}

async function ponChofer(n, nombre, tel) {
  const datos = { numero: n, nombre: nombre, telefono: tel, ts: admin.firestore.Timestamp.now() };
  await db.collection("lanzaderas_chofer").doc(String(n)).set(datos);
  return datos;
}

async function quienLleva(n) {
  const d = await db.collection("lanzaderas_chofer").doc(String(n)).get();
  return d.exists ? d.data().nombre : null;
}

(async () => {
  console.log("\n=== El problema que hay que arreglar ===");
  await t("Juan pasa de la 1 a la 3 y deja de aparecer en la 1", async () => {
    await limpiar();
    await ponChofer(1, "Juan Perez", "600 111 222");
    const d3 = await ponChofer(3, "Juan Perez", "600111222");   // mismo tel, otro formato
    await choferUnaLanzadera(evento("3", d3));
    igual(await quienLleva(1), null, "la 1 debe quedar libre:");
    igual(await quienLleva(3), "Juan Perez", "la 3 debe ser suya:");
  });

  await t("el telefono se compara sin espacios ni guiones", async () => {
    await limpiar();
    await ponChofer(1, "Ana Lopez", "611-33-44-55");
    const d2 = await ponChofer(2, "Ana Lopez", "611 334 455");
    await choferUnaLanzadera(evento("2", d2));
    igual(await quienLleva(1), null, "debe reconocer que es el mismo telefono:");
  });

  await t("arrastra el nombre nuevo si se cambio de persona el movil", async () => {
    await limpiar();
    await ponChofer(1, "Juan Perez", "600111222");
    const d4 = await ponChofer(4, "Juan P. Gomez", "600111222");
    await choferUnaLanzadera(evento("4", d4));
    igual(await quienLleva(1), null);
    igual(await quienLleva(4), "Juan P. Gomez");
  });

  console.log("\n=== Lo que NO debe tocar ===");
  await t("dos conductores distintos conviven sin pisarse", async () => {
    await limpiar();
    await ponChofer(1, "Juan Perez", "600111222");
    const d2 = await ponChofer(2, "Ana Lopez", "611334455");
    await choferUnaLanzadera(evento("2", d2));
    igual(await quienLleva(1), "Juan Perez", "Juan sigue en la 1:");
    igual(await quienLleva(2), "Ana Lopez",  "Ana en la 2:");
  });

  await t("un conductor sin telefono no libera a nadie", async () => {
    await limpiar();
    await ponChofer(1, "Juan Perez", "600111222");
    const d2 = await ponChofer(2, "Sin Telefono", "");
    await choferUnaLanzadera(evento("2", d2));
    igual(await quienLleva(1), "Juan Perez", "no debe tocar la 1:");
  });

  await t("un borrado no dispara nada", async () => {
    await limpiar();
    await ponChofer(1, "Juan Perez", "600111222");
    await choferUnaLanzadera(evento("2", null));
    igual(await quienLleva(1), "Juan Perez");
  });

  console.log("\n=== Fin de jornada libera la lanzadera ===");
  await t("al fichar fuera se borra el conductor", async () => {
    await limpiar();
    await ponChofer(2, "Ana Lopez", "611334455");
    await liberarChoferAlSalir(evento("2", { numero: 2, estado: "fuera", activa: false }));
    igual(await quienLleva(2), null, "la 2 debe quedar libre:");
  });

  await t("estando en nave NO se borra", async () => {
    await limpiar();
    await ponChofer(2, "Ana Lopez", "611334455");
    await liberarChoferAlSalir(evento("2", { numero: 2, estado: "en_nave", activa: true }));
    igual(await quienLleva(2), "Ana Lopez", "debe seguir:");
  });

  await t("en transito NO se borra", async () => {
    await limpiar();
    await ponChofer(3, "Miguel Sanz", "622556677");
    await liberarChoferAlSalir(evento("3", { numero: 3, estado: "transito", activa: true }));
    igual(await quienLleva(3), "Miguel Sanz");
  });

  await t("fichar fuera sin conductor asignado no falla", async () => {
    await limpiar();
    await liberarChoferAlSalir(evento("4", { numero: 4, estado: "fuera", activa: false }));
    igual(await quienLleva(4), null);
  });

  console.log("\n=========================================");
  console.log("  " + pass + " correctos, " + fail + " fallos");
  console.log("=========================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR DEL ARNES:", e); process.exit(1); });
