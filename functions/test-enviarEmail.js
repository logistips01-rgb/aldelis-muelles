// Arnes de prueba de enviarEmail. Intercepta fetch (para no llamar a Microsoft)
// y usa el emulador de Firestore. No se despliega: es un fichero de pruebas.
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node test-enviarEmail.js

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "aldelis-test";
process.env.MS_SECRET = "secreto-de-prueba";

const enviados = [];
global.fetch = async (url, opts) => {
  if (String(url).includes("login.microsoftonline.com")) {
    return { json: async () => ({ access_token: "token-falso" }) };
  }
  if (String(url).includes("graph.microsoft.com")) {
    const msg = JSON.parse(opts.body).message;
    enviados.push({
      to: msg.toRecipients[0].emailAddress.address,
      subject: msg.subject,
      contenido: (msg.body.content || "").substring(0, 400),
      tieneImagen: (msg.attachments || []).length > 0
    });
    return { status: 202 };
  }
  throw new Error("fetch inesperado: " + url);
};

const admin = require("firebase-admin");
const fn    = require("./index.js");
const db    = admin.firestore();

// El handler v2 recibe un CallableRequest; se invoca la implementacion directa.
const handler = fn.enviarEmail.run ? fn.enviarEmail.run.bind(fn.enviarEmail) : fn.enviarEmail;

const APP  = { appId: "app-de-prueba" };
const ADMIN_USER  = { token: { email: "mlorente@aldelis.com" } };
const OTRO_USER   = { token: { email: "otro@aldelis.com" } };
const SIN_COSTES  = { token: { email: "sincostes@aldelis.com" } };

function llamar(data, opts) {
  opts = opts || {};
  return handler({ data: data, app: opts.sinAppCheck ? undefined : APP, auth: opts.auth });
}

let pass = 0, fail = 0;
async function t(nombre, fn) {
  enviados.length = 0;
  try { await fn(); console.log("  OK   " + nombre); pass++; }
  catch (e) { console.log("  FALLO " + nombre + "\n         " + e.message); fail++; }
}
function igual(real, esperado, que) {
  if (real !== esperado) throw new Error((que || "") + " esperaba " + JSON.stringify(esperado) + ", dio " + JSON.stringify(real));
}

async function sembrar() {
  await db.collection("config").doc("alertas").set({ emails: ["mlorente@aldelis.com", "garita@aldelis.com"] });
  await db.collection("config").doc("costes").set({ emails: ["mlorente@aldelis.com"] });
  await db.collection("permisos").doc("sincostes@aldelis.com").set({ secciones: ["lanzaderas"] });
  await db.collection("permisos").doc("otro@aldelis.com").set({ secciones: ["costes", "lanzaderas"] });
}

async function nuevaReserva(id, extra) {
  await db.collection("reservas").doc(id).set(Object.assign({
    codigo: "ALD-TEST-" + id, empresa: "Transportes Prueba", matricula: "1234ABC",
    email: "transportista@ejemplo.com", seccion: "frio", mercancia: "Palets",
    pales: 12, franja: "08:00 - 08:30", fecha: "2026-07-31", estado: "pendiente",
    muelle: null, nota_almacen: "", motivo: "",
    created_at: admin.firestore.Timestamp.now()
  }, extra || {}));
}

(async () => {
  await sembrar();

  console.log("\n=== App Check y tipo ===");
  await t("sin App Check se rechaza", async () => {
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "x" }, { sinAppCheck: true });
    igual(r.ok, false); igual(r.error, "No autorizado");
    igual(enviados.length, 0, "no debe enviar nada:");
  });
  await t("tipo desconocido se rechaza", async () => {
    const r = await llamar({ tipo: "cualquier_cosa" });
    igual(r.ok, false); igual(r.error, "Tipo no reconocido");
  });
  await t("el modo antiguo (to/subject/body) ya no funciona", async () => {
    const r = await llamar({ to: "atacante@ejemplo.com", subject: "spam", body: "spam" });
    igual(r.ok, false);
    igual(enviados.length, 0, "no debe enviar nada:");
  });

  console.log("\n=== reserva_nueva (publico, sin login) ===");
  await t("envia confirmacion al transportista y aviso al almacen", async () => {
    await nuevaReserva("r1");
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r1" });
    igual(r.ok, true);
    igual(enviados.length, 3, "correos enviados:");
    igual(enviados[0].to, "transportista@ejemplo.com");
    if (!enviados[0].subject.includes("Reserva recibida")) throw new Error("asunto: " + enviados[0].subject);
    if (!enviados[0].contenido.includes("Transportes Prueba")) throw new Error("no personaliza la empresa");
    if (!enviados[0].contenido.includes("Almacen Frio")) throw new Error("no traduce la seccion");
    igual(enviados[1].to, "mlorente@aldelis.com");
    igual(enviados[2].to, "garita@aldelis.com");
    if (!enviados[1].subject.includes("Nueva solicitud")) throw new Error("asunto almacen: " + enviados[1].subject);
  });
  await t("no se puede repetir el aviso (anti-spam)", async () => {
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r1" });
    igual(r.ok, false); igual(r.error, "Aviso ya enviado");
    igual(enviados.length, 0, "no debe reenviar:");
  });
  await t("reserva inexistente se rechaza", async () => {
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "no-existe" });
    igual(r.ok, false); igual(r.error, "Reserva no encontrada");
  });
  await t("reserva ya confirmada no dispara el aviso de nueva", async () => {
    await nuevaReserva("r2", { estado: "confirmada" });
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r2" });
    igual(r.ok, false); igual(r.error, "Estado no valido");
    igual(enviados.length, 0);
  });
  await t("reserva de hace 2 horas se rechaza (fuera de plazo)", async () => {
    await nuevaReserva("r3", {
      created_at: admin.firestore.Timestamp.fromMillis(Date.now() - 2 * 3600 * 1000)
    });
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r3" });
    igual(r.ok, false); igual(r.error, "Fuera de plazo");
    igual(enviados.length, 0);
  });
  await t("sin email del transportista solo avisa al almacen", async () => {
    await nuevaReserva("r4", { email: "" });
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r4" });
    igual(r.ok, true);
    igual(enviados.length, 2, "solo los dos del almacen:");
    igual(enviados[0].to, "mlorente@aldelis.com");
  });
  await t("no se puede colar otro destinatario en la llamada", async () => {
    await nuevaReserva("r5");
    const r = await llamar({ tipo: "reserva_nueva", reservaId: "r5", to: "atacante@ejemplo.com" });
    igual(r.ok, true);
    const destinos = enviados.map(e => e.to);
    if (destinos.includes("atacante@ejemplo.com")) throw new Error("se colo el destinatario del cliente");
  });

  console.log("\n=== reserva_estado (requiere login) ===");
  await t("sin login se rechaza", async () => {
    const r = await llamar({ tipo: "reserva_estado", reservaId: "r2" });
    igual(r.ok, false); igual(r.error, "Requiere login");
    igual(enviados.length, 0);
  });
  await t("confirmada: avisa con muelle y hora", async () => {
    await db.collection("reservas").doc("r2").update({ estado: "confirmada", muelle: "M20", nota_almacen: "Traer albaran" });
    const r = await llamar({ tipo: "reserva_estado", reservaId: "r2" }, { auth: ADMIN_USER });
    igual(r.ok, true); igual(enviados.length, 1);
    igual(enviados[0].to, "transportista@ejemplo.com");
    if (!enviados[0].subject.includes("confirmada")) throw new Error("asunto: " + enviados[0].subject);
    if (!enviados[0].contenido.includes("M20")) throw new Error("falta el muelle");
    if (!enviados[0].contenido.includes("08:00")) throw new Error("falta la hora");
    if (!enviados[0].contenido.includes("Traer albaran")) throw new Error("falta la nota");
  });
  await t("rechazada: avisa con el motivo", async () => {
    await db.collection("reservas").doc("r2").update({ estado: "rechazada", motivo: "Sin hueco", nota_almacen: "Prueba otro dia" });
    const r = await llamar({ tipo: "reserva_estado", reservaId: "r2" }, { auth: ADMIN_USER });
    igual(r.ok, true);
    if (!enviados[0].contenido.includes("Sin hueco")) throw new Error("falta el motivo");
  });
  await t("reasignada: avisa con la nueva franja", async () => {
    await db.collection("reservas").doc("r2").update({ estado: "reasignada", franja: "10:00 - 10:30", muelle: "M18" });
    const r = await llamar({ tipo: "reserva_estado", reservaId: "r2" }, { auth: ADMIN_USER });
    igual(r.ok, true);
    if (!enviados[0].contenido.includes("10:00 - 10:30")) throw new Error("falta la franja nueva");
  });
  await t("en_curso no manda aviso", async () => {
    await db.collection("reservas").doc("r2").update({ estado: "en_curso" });
    const r = await llamar({ tipo: "reserva_estado", reservaId: "r2" }, { auth: ADMIN_USER });
    igual(r.ok, false); igual(r.error, "Estado sin aviso");
    igual(enviados.length, 0);
  });

  console.log("\n=== alerta_lanzadera (requiere login) ===");
  await t("sin login se rechaza", async () => {
    const r = await llamar({ tipo: "alerta_lanzadera", numero: 2, lugar: "Merca", minutos: 95 });
    igual(r.ok, false); igual(r.error, "Requiere login");
  });
  await t("con login avisa a config/alertas", async () => {
    const r = await llamar({ tipo: "alerta_lanzadera", numero: 2, lugar: "Merca", minutos: 95 }, { auth: ADMIN_USER });
    igual(r.ok, true); igual(enviados.length, 2);
    igual(enviados[0].to, "mlorente@aldelis.com");
    if (!enviados[0].subject.includes("Lanzadera 2")) throw new Error("asunto: " + enviados[0].subject);
    if (!enviados[0].contenido.includes("Merca")) throw new Error("falta el lugar");
  });
  await t("lanzadera 9 se rechaza", async () => {
    const r = await llamar({ tipo: "alerta_lanzadera", numero: 9, lugar: "Merca" }, { auth: ADMIN_USER });
    igual(r.ok, false); igual(r.error, "Lanzadera no valida");
  });

  console.log("\n=== informe_costes (login + permiso costes) ===");
  await t("sin login se rechaza", async () => {
    const r = await llamar({ tipo: "informe_costes", fechaFmt: "31/07/2026", costeTotal: 100 });
    igual(r.ok, false); igual(r.error, "Requiere login");
  });
  await t("usuario sin permiso de costes se rechaza", async () => {
    const r = await llamar({ tipo: "informe_costes", fechaFmt: "31/07/2026", costeTotal: 100 }, { auth: SIN_COSTES });
    igual(r.ok, false); igual(r.error, "Sin permiso");
    igual(enviados.length, 0);
  });
  await t("admin envia a config/costes con imagen", async () => {
    const r = await llamar({
      tipo: "informe_costes", fechaFmt: "31/07/2026", costeTotal: 2281.82,
      html: "<b>informe</b>", imageBase64: "AAAA"
    }, { auth: ADMIN_USER });
    igual(r.ok, true); igual(enviados.length, 1);
    igual(enviados[0].to, "mlorente@aldelis.com");
    igual(enviados[0].tieneImagen, true, "debe llevar la imagen:");
    if (!enviados[0].subject.includes("2.281,82")) throw new Error("asunto sin total: " + enviados[0].subject);
  });
  await t("usuario con permiso de costes puede enviar", async () => {
    const r = await llamar({ tipo: "informe_costes", fechaFmt: "31/07/2026", costeTotal: 50 }, { auth: OTRO_USER });
    igual(r.ok, true);
  });
  await t("imagen enorme se rechaza", async () => {
    const r = await llamar({
      tipo: "informe_costes", fechaFmt: "31/07/2026", costeTotal: 1,
      imageBase64: "x".repeat(5000001)
    }, { auth: ADMIN_USER });
    igual(r.ok, false); igual(r.error, "Imagen no valida");
  });

  console.log("\n=========================================");
  console.log("  " + pass + " correctos, " + fail + " fallos");
  console.log("=========================================\n");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR DEL ARNES:", e); process.exit(1); });
