const functions  = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin      = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const MS_CLIENT_ID = "5c27366e-433f-4b07-a2a3-2b40f2217863";
const MS_TENANT_ID = "31f702d7-3d33-43a6-b35f-c15ff5aa0f1c";
const MS_SENDER    = "reservas@aldelis.com";
const MS_SECRET    = process.env.MS_SECRET;

// ── Helpers compartidos ─────────────────────────────────────────────────────

async function obtenerTokenMS() {
  const res = await fetch(
    "https://login.microsoftonline.com/" + MS_TENANT_ID + "/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     MS_CLIENT_ID,
        client_secret: MS_SECRET,
        scope:         "https://graph.microsoft.com/.default",
        grant_type:    "client_credentials"
      }).toString()
    }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error("Token error: " + (data.error_description || data.error));
  return data.access_token;
}

async function enviarConGraph(token, to, subject, html, body, imageBase64) {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/users/" + MS_SENDER + "/sendMail",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          subject,
          body: html ? { contentType: "HTML", content: html } : { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: to } }],
          attachments: imageBase64 ? [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "informe.png",
            contentType: "image/png",
            contentBytes: imageBase64,
            contentId: "informe-costes",
            isInline: true
          }] : []
        },
        saveToSentItems: false
      })
    }
  );
  console.log("Graph API status:", res.status, "a", to);
  return res.status;
}

function formatEuro(v) {
  if (v == null || isNaN(v)) return "—";
  const parts = v.toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return parts[0] + "," + parts[1] + " €";
}

function formatDur(min) {
  if (!min || isNaN(min)) return "0 min";
  if (min < 60) return Math.round(min) + " min";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m > 0 ? h + " h " + m + " min" : h + " h";
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ACCION_LABEL = { cargando: "Cargando", descargando: "Descargando", presente: "Presente" };

// Tarifas de las lanzaderas. Si cambian hay que cambiarlas TAMBIEN en
// public/js/admin.js (recalcLanzCosteMin), que calcula lo que se ve en el panel
// y lo que sale en el envio manual del informe.
const LANZ_MENSUAL = 16000;  // €/mes de las lanzaderas 1, 2 y 3
const LANZ4_HORA   = 150;    // €/hora de la lanzadera 4
const LANZ_MIN_DIA = { 1: 1440, 2: 1440, 3: 1440 };  // minutos disponibles al dia

// La funcion corre en UTC: hay que formatear la hora en zona Madrid o el
// detalle por lanzadera saldria desfasado una o dos horas.
function horaMadrid(ms) {
  return new Date(ms).toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false
  });
}

// ── Correccion de la fuente para Outlook ────────────────────────────────────
// Outlook de escritorio usa el motor de Word, que NO hereda font-family del
// <body> dentro de las celdas de tabla: cada <td> cae a Times New Roman. Hay
// que repetir la familia en cada elemento con texto. En lugar de escribirla 55
// veces a mano, se inyecta al final sobre el HTML ya construido: alli donde hay
// font-size hay texto.
// Sin comillas alrededor de Segoe UI a proposito: los estilos van dentro de
// atributos style='...' delimitados por comilla simple, y una comilla aqui
// cerraria el atributo y se perderia el resto de propiedades. En CSS un nombre
// de familia con espacios es valido sin comillas.
const FONT = "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;";

function forzarFuente(html) {
  return html.replace(/font-size:/g, FONT + "font-size:");
}

// Cabecera comun de los correos. color-scheme le dice al cliente que el diseño
// es para fondo claro, para que el modo oscuro no invierta las tarjetas blancas
// ni lave el rojo de la cabecera.
const HEAD_EMAIL =
  "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
  "<meta name='color-scheme' content='light only'>" +
  "<meta name='supported-color-schemes' content='light only'>" +
  "<style>:root{color-scheme:light only;supported-color-schemes:light only}</style>" +
  "</head>";

// ── Función callable: enviar email desde el cliente ─────────────────────────
//
// PASO 1 de la correccion de seguridad. Esta funcion enviaba correo desde
// reservas@aldelis.com con el destinatario, el asunto y el contenido que le
// pasara quien la llamase, sin exigir App Check ni login: era un relay abierto
// utilizable para spam y phishing con el dominio de la empresa.
//
// Aqui se cierra el acceso desde fuera de la web (App Check obligatorio) y se
// acotan los campos. PENDIENTE (paso 2): que el cliente deje de decidir el
// destinatario y el contenido, y que la funcion los resuelva en el servidor a
// partir del tipo de aviso. Hasta entonces, alguien con la consola del
// navegador abierta EN la propia web todavia puede elegir ambos.

const LIMITES = {
  to:      160,
  subject: 200,
  body:    20000,
  html:    300000,
  imagen:  5000000   // base64 del pantallazo del informe
};

// Una sola direccion: sin comas, puntos y coma, espacios ni saltos de linea,
// que son la via para colar varios destinatarios o cabeceras.
function destinatarioValido(to) {
  return typeof to === "string"
    && to.length > 0 && to.length <= LIMITES.to
    && /^[^\s,;:<>()[\]\\]+@[^\s,;:<>()[\]\\]+\.[A-Za-z]{2,}$/.test(to);
}

function dentroDeLimite(v, max) {
  return v == null || (typeof v === "string" && v.length <= max);
}

// Administradores de la aplicacion. Duplicado en public/js/admin.js (ADMINS) y
// en firestore.rules (esAdmin): si cambia, cambiarlo en los tres sitios.
const ADMINS_APP = ["mlorente@aldelis.com"];

// Destinatarios de los avisos de nueva reserva. Se pueden pasar a
// config/reservas.emails; si ese documento no existe se usan estos.
const AVISO_RESERVAS_DEFECTO = ["mlorente@aldelis.com", "garita@aldelis.com"];

async function emailsDeConfig(docId, porDefecto) {
  try {
    const d = await db.collection("config").doc(docId).get();
    const l = (d.exists && Array.isArray(d.data().emails)) ? d.data().emails : null;
    if (l && l.length) return l.filter(destinatarioValido);
  } catch (e) {
    console.warn("emailsDeConfig", docId, e.message);
  }
  return (porDefecto || []).filter(destinatarioValido);
}

// Mismo criterio que firestore.rules, incluido el refuerzo progresivo: si el
// usuario no tiene documento en /permisos conserva el acceso anterior.
async function puedeSeccion(email, seccion) {
  if (!email) return false;
  if (ADMINS_APP.includes(email)) return true;
  try {
    const d = await db.collection("permisos").doc(email).get();
    if (!d.exists) return true;
    const s = d.data().secciones;
    return Array.isArray(s) && s.includes(seccion);
  } catch (e) {
    console.warn("puedeSeccion", e.message);
    return false;
  }
}

const SECCION_LABEL = { seco: "Almacen Seco", frio: "Almacen Frio", lavadero: "Lavadero" };
const FIRMA = "\n\nAldelis — Gestion de muelles";
const CARD_RESET = "border-radius:8px;border:1px solid #e8e8e8;background:#ffffff;background-color:#ffffff;color:#1A1A1A";

// Envia a una lista y devuelve cuantos han salido bien.
async function enviarALista(destinatarios, asunto, cuerpo, html, imagen) {
  if (!destinatarios.length) return 0;
  const token = await obtenerTokenMS();
  let enviados = 0;
  for (const to of destinatarios) {
    try {
      const st = await enviarConGraph(token, to, asunto, html, cuerpo, imagen);
      if (st === 200 || st === 202) enviados++;
    } catch (e) {
      console.error("Error enviando a", to, e.message);
    }
  }
  return enviados;
}

exports.enviarEmail = functions.https.onCall(async (request, context) => {
  // Compatible con las dos generaciones: en v2 los datos y el contexto vienen
  // en el primer argumento; en v1 los datos son el primero y el contexto el
  // segundo. Asi la comprobacion no depende de cual este desplegada.
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  // App Check obligatorio. Para las funciones callable esto NO se puede activar
  // desde la consola de Firebase, hay que comprobarlo aqui.
  if (!ctx.app) {
    console.warn("enviarEmail rechazado: sin App Check");
    return { ok: false, error: "No autorizado" };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "Faltan datos" };

  const tipo         = data.tipo;
  const emailUsuario = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  const conLogin     = !!emailUsuario;

  console.log("enviarEmail tipo:", tipo, "| usuario:", emailUsuario || "sin login");

  try {
    // ── Nueva reserva: confirmacion al transportista y aviso al almacen ─────
    // Publico (lo pide el formulario sin login), pero el destinatario sale del
    // documento y el texto se redacta aqui.
    if (tipo === "reserva_nueva") {
      const id = data.reservaId;
      if (typeof id !== "string" || !id || id.length > 60) return { ok: false, error: "Reserva no valida" };

      const ref  = db.collection("reservas").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return { ok: false, error: "Reserva no encontrada" };
      const r = snap.data();

      if (r.estado !== "pendiente") return { ok: false, error: "Estado no valido" };
      if (r.aviso_enviado)          return { ok: false, error: "Aviso ya enviado" };

      // Solo recien creada: evita que alguien reenvie avisos de reservas viejas.
      const creada = r.created_at && r.created_at.toMillis ? r.created_at.toMillis() : 0;
      if (!creada || Date.now() - creada > 15 * 60 * 1000) {
        return { ok: false, error: "Fuera de plazo" };
      }

      // Se marca antes de enviar: si alguien repite la llamada, ya no pasa.
      await ref.update({ aviso_enviado: true });

      const seccion = SECCION_LABEL[r.seccion] || r.seccion || "—";

      if (destinatarioValido(r.email)) {
        await enviarALista([r.email],
          "Reserva recibida en Aldelis — " + r.codigo,
          "Hola " + (r.empresa || "") + ",\n\n" +
          "Tu solicitud de reserva ha sido recibida correctamente.\n\n" +
          "Codigo de seguimiento: " + r.codigo + "\n" +
          "Fecha: " + r.fecha + "\n" +
          "Franja: " + r.franja + "\n" +
          "Seccion: " + seccion + "\n\n" +
          "El equipo de Aldelis confirmara tu reserva en breve.\n\n" +
          "Consulta el estado en:\nhttps://aldelis-muelles.web.app/consulta.html" + FIRMA,
          null, null);
      }

      const avisos = await emailsDeConfig("reservas", AVISO_RESERVAS_DEFECTO);
      await enviarALista(avisos,
        "Nueva solicitud de descarga pendiente — " + r.codigo,
        "Nueva solicitud de descarga recibida y pendiente de confirmacion.\n\n" +
        "Codigo: " + r.codigo + "\n" +
        "Empresa: " + (r.empresa || "—") + "\n" +
        "Matricula: " + (r.matricula || "—") + "\n" +
        "Fecha: " + r.fecha + "\n" +
        "Franja: " + r.franja + "\n" +
        "Seccion: " + (r.seccion || "—") + "\n" +
        "Mercancia: " + (r.mercancia || "No indicada") + "\n" +
        "Pales: " + (r.pales ? r.pales + " pales" : "No indicado") + "\n\n" +
        "Accede al panel para confirmar, reasignar o rechazar:\n" +
        "https://aldelis-muelles.web.app/admin.html" + FIRMA,
        null, null);

      return { ok: true };
    }

    // ── Cambio de estado de una reserva: avisa al transportista ─────────────
    if (tipo === "reserva_estado") {
      if (!conLogin) return { ok: false, error: "Requiere login" };

      const id = data.reservaId;
      if (typeof id !== "string" || !id || id.length > 60) return { ok: false, error: "Reserva no valida" };

      const snap = await db.collection("reservas").doc(id).get();
      if (!snap.exists) return { ok: false, error: "Reserva no encontrada" };
      const r = snap.data();

      if (!destinatarioValido(r.email)) return { ok: false, error: "La reserva no tiene email" };

      let asunto, cuerpo;
      if (r.estado === "confirmada") {
        const hora = String(r.franja || "").split(" - ")[0];
        asunto = "Reserva confirmada en Aldelis — " + r.codigo;
        cuerpo = "Hola " + (r.empresa || "") + ",\n\nTu reserva ha sido CONFIRMADA.\n\n" +
          "Muelle asignado: " + (r.muelle || "—") + "\nFranja: " + r.franja + "\nFecha: " + r.fecha +
          (r.nota_almacen ? "\n\nNota del almacen: " + r.nota_almacen : "") +
          "\n\nPresentate en el muelle " + (r.muelle || "—") + " a las " + hora + "." + FIRMA;
      } else if (r.estado === "reasignada") {
        asunto = "Reserva reasignada en Aldelis — " + r.codigo;
        cuerpo = "Hola " + (r.empresa || "") + ",\n\nTu reserva ha sido MODIFICADA.\n\n" +
          "Nueva franja: " + r.franja + "\nMuelle: " + (r.muelle || "—") +
          (r.motivo ? "\nMotivo: " + r.motivo : "") + FIRMA;
      } else if (r.estado === "rechazada") {
        asunto = "Reserva no aceptada en Aldelis — " + r.codigo;
        cuerpo = "Hola " + (r.empresa || "") + ",\n\nTu reserva NO ha sido aceptada.\n\n" +
          "Motivo: " + (r.motivo || "—") +
          (r.nota_almacen ? "\n" + r.nota_almacen : "") +
          "\n\nPuedes realizar una nueva reserva en:\nhttps://aldelis-muelles.web.app" + FIRMA;
      } else {
        return { ok: false, error: "Estado sin aviso" };
      }

      await enviarALista([r.email], asunto, cuerpo, null, null);
      return { ok: true };
    }

    // ── Alerta de lanzadera parada ──────────────────────────────────────────
    if (tipo === "alerta_lanzadera") {
      if (!conLogin) return { ok: false, error: "Requiere login" };

      const numero  = Number(data.numero);
      const minutos = Number(data.minutos);
      const lugar   = typeof data.lugar === "string" ? data.lugar.substring(0, 60) : "";
      if (!(numero >= 1 && numero <= 4)) return { ok: false, error: "Lanzadera no valida" };
      if (!lugar) return { ok: false, error: "Falta el lugar" };

      const destinatarios = await emailsDeConfig("alertas", []);
      if (!destinatarios.length) return { ok: false, error: "Sin destinatarios" };

      const enviados = await enviarALista(destinatarios,
        "ALERTA Aldelis — Lanzadera " + numero + " lleva mas de hora y media en " + lugar,
        "ALERTA de Aldelis Muelles\n\n" +
        "La Lanzadera " + numero + " lleva " +
        (minutos > 0 ? Math.round(minutos) + " minutos" : "mas de hora y media") +
        " parada en " + lugar + ".\n\n" +
        "Revisa el panel:\nhttps://aldelis-muelles.web.app/admin.html" + FIRMA,
        null, null);

      return { ok: enviados > 0 };
    }

    // ── Restablecer contraseña ──────────────────────────────────────────────
    // Publico por necesidad: quien ha olvidado la contraseña no puede estar
    // identificado. El enlace lo genera el SDK de administrador y lo enviamos
    // por Graph desde reservas@aldelis.com, en lugar de dejarselo a Firebase:
    // sus correos salen de noreply@aldelis-muelles.firebaseapp.com y Exchange
    // Online los manda a cuarentena.
    if (tipo === "password_reset") {
      const email = (typeof data.email === "string") ? data.email.trim().toLowerCase() : "";
      if (!destinatarioValido(email)) return { ok: false, error: "Email no valido" };

      // Respuesta siempre igual, exista la cuenta o no: si dijeramos la verdad,
      // esto serviria para averiguar quien tiene cuenta en el sistema.
      const RESPUESTA = { ok: true };

      // Un correo cada 5 minutos por direccion, para que no se pueda usar para
      // bombardear el buzon de alguien.
      const ref  = db.collection("password_resets").doc(email);
      const prev = await ref.get();
      if (prev.exists && prev.data().ts &&
          Date.now() - prev.data().ts.toMillis() < 5 * 60 * 1000) {
        console.warn("password_reset limitado por frecuencia:", email);
        return RESPUESTA;
      }
      await ref.set({ ts: admin.firestore.Timestamp.now() });

      let enlace;
      try {
        enlace = await admin.auth().generatePasswordResetLink(email, {
          url: "https://aldelis-muelles.web.app/admin.html"
        });
      } catch (e) {
        // Cuenta inexistente: no se distingue del caso correcto.
        console.warn("password_reset sin cuenta:", email, e.code || e.message);
        return RESPUESTA;
      }

      const htmlReset = forzarFuente(
        HEAD_EMAIL +
        "<body bgcolor='#f0f0f0' style='margin:0;padding:16px;background-color:#f0f0f0;" + FONT + "'>" +
        "<div style='max-width:520px;margin:0 auto'>" +
        "<div style='background:#D41F3A;border-radius:8px;padding:20px 22px;margin-bottom:12px'>" +
        "<div style='color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px'>Aldelis</div>" +
        "<div style='color:rgba(255,255,255,.8);font-size:12px;margin-top:2px'>Restablecer contraseña</div>" +
        "</div>" +
        "<div style='" + CARD_RESET + ";padding:22px'>" +
        "<div style='font-size:14px;color:#374151;line-height:1.6'>" +
        "Has pedido restablecer la contraseña de tu cuenta del panel de Aldelis." +
        "</div>" +
        "<div style='margin:20px 0'>" +
        "<a href='" + enlace + "' style='background:#D41F3A;color:#ffffff;text-decoration:none;" +
        "display:inline-block;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:600'>" +
        "Elegir contraseña nueva</a></div>" +
        "<div style='font-size:12px;color:#6B7280;line-height:1.6'>" +
        "El enlace caduca en una hora. Si no has pedido esto, ignora el correo: " +
        "tu contraseña no cambia mientras no uses el enlace." +
        "</div></div>" +
        "<div style='height:14px'></div>" +
        "<div style='text-align:center;font-size:11px;color:#aaa'>Aldelis &middot; Gestion de muelles</div>" +
        "</div></body></html>"
      );

      await enviarALista([email],
        "Restablecer tu contraseña de Aldelis",
        "Has pedido restablecer la contraseña del panel de Aldelis.\n\n" +
        "Abre este enlace para elegir una nueva:\n" + enlace + "\n\n" +
        "El enlace caduca en una hora. Si no has pedido esto, ignora el correo." + FIRMA,
        htmlReset, null);

      return RESPUESTA;
    }

    // ── Informe de costes enviado a mano desde el panel ─────────────────────
    // El pantallazo solo se puede generar en el navegador, asi que la imagen y
    // el html llegan del cliente. Los destinatarios NO: salen de config/costes,
    // y hace falta login con permiso de costes.
    if (tipo === "informe_costes") {
      if (!conLogin) return { ok: false, error: "Requiere login" };
      if (!(await puedeSeccion(emailUsuario, "costes"))) {
        console.warn("informe_costes rechazado, sin permiso:", emailUsuario);
        return { ok: false, error: "Sin permiso" };
      }

      const fechaFmt   = typeof data.fechaFmt === "string" ? data.fechaFmt.substring(0, 20) : "";
      const costeTotal = Number(data.costeTotal);
      const html       = data.html || null;
      const imagen     = data.imageBase64 || null;

      if (!fechaFmt) return { ok: false, error: "Falta la fecha" };
      if (!dentroDeLimite(html, LIMITES.html)) return { ok: false, error: "Contenido demasiado largo" };
      if (imagen != null && (typeof imagen !== "string" || imagen.length > LIMITES.imagen)) {
        return { ok: false, error: "Imagen no valida" };
      }

      const destinatarios = await emailsDeConfig("costes", []);
      if (!destinatarios.length) return { ok: false, error: "Sin destinatarios" };

      const total  = isNaN(costeTotal) ? "" : " — " + formatEuro(costeTotal);
      const asunto = "Informe de costes Lanzaderas — " + fechaFmt + total;
      const cuerpo = "Informe de costes " + fechaFmt +
        (isNaN(costeTotal) ? "" : " — Total operaciones: " + formatEuro(costeTotal));

      const enviados = await enviarALista(destinatarios, asunto, cuerpo, html, imagen);
      return { ok: enviados > 0, enviados: enviados };
    }

    return { ok: false, error: "Tipo no reconocido" };

  } catch (e) {
    console.error("ERROR enviarEmail:", e.message);
    return { ok: false, error: e.message };
  }
});

// ── Lógica compartida del informe ───────────────────────────────────────────

async function generarYEnviarInforme(label) {
    console.log("Iniciando envio automatico informe diario (" + label + ")...");
    try {

      // Config
      const [costesSnap, appSnap, destinosSnap] = await Promise.all([
        db.collection("config").doc("costes").get(),
        db.collection("config").doc("app").get(),
        db.collection("config").doc("destinos").get()
      ]);

      const emails = (costesSnap.exists && Array.isArray(costesSnap.data().emails))
        ? costesSnap.data().emails : [];
      if (!emails.length) { console.log("Sin destinatarios."); return null; }

      const diasLaborables = (appSnap.exists && appSnap.data().diasLaborables) || 22;
      const LANZ_COSTE_MIN = {
        1: LANZ_MENSUAL / (diasLaborables * LANZ_MIN_DIA[1]),
        2: LANZ_MENSUAL / (diasLaborables * LANZ_MIN_DIA[2]),
        3: LANZ_MENSUAL / (diasLaborables * LANZ_MIN_DIA[3]),
        4: LANZ4_HORA / 60
      };

      const NAVE_NOMBRE = {};
      if (destinosSnap.exists && Array.isArray(destinosSnap.data().lista)) {
        destinosSnap.data().lista.forEach(n => { NAVE_NOMBRE[n.id] = n.nombre; });
      }

      // Rango del día en hora Madrid
      const fechaStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
      const [y, m, d] = fechaStr.split("-").map(Number);
      const startOfDay = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)); // medianoche UTC para zona +0
      // Ajustar a medianoche Madrid (UTC+1 invierno / UTC+2 verano)
      // Usamos el offset real del día
      const tzOffset = -new Date(fechaStr + "T00:00:00").getTimezoneOffset(); // minutos
      // En Node sin zona local, calculamos con la fecha ISO + timeZone
      const madridMidnight = new Date(fechaStr + "T00:00:00");
      // Firestore query: todo el día
      const tsStart = admin.firestore.Timestamp.fromDate(
        new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - (new Date(fechaStr + "T00:00:00+02:00").getTime() - new Date(fechaStr + "T00:00:00Z").getTime()))
      );
      const tsEnd = admin.firestore.Timestamp.fromDate(
        new Date(tsStart.toDate().getTime() + 86400000)
      );

      const snap = await db.collection("lanzaderas_log")
        .where("desde", ">=", tsStart)
        .where("desde", "<", tsEnd)
        .orderBy("desde")
        .get();

      if (snap.empty) { console.log("Sin logs para hoy."); return null; }

      // Agrupar por lanzadera
      const byL = { 1: [], 2: [], 3: [], 4: [] };
      snap.forEach(doc => {
        const data = doc.data();
        if (byL[data.numero]) byL[data.numero].push(data);
      });

      const MAX_DUR = 480;
      const allSegs = [];
      [1, 2, 3, 4].forEach(n => {
        const arr = byL[n].sort((a, b) => a.desde.toMillis() - b.desde.toMillis());
        for (let i = 0; i < arr.length; i++) {
          const ev = arr[i];
          if (ev.estado === "fuera") continue;
          const startMs = ev.desde.toMillis();
          const nextMs  = i + 1 < arr.length ? arr[i + 1].desde.toMillis() : tsEnd.toDate().getTime();
          const durMin  = Math.round((nextMs - startMs) / 60000);
          if (durMin < 0 || durMin > MAX_DUR) continue;
          allSegs.push({
            numero: n, estado: ev.estado,
            nave: ev.nave || null, muelle: ev.muelle || null,
            accion: ev.accion || null, destino: ev.destino || null,
            startMs: startMs, durMin: durMin,
            coste: durMin * (LANZ_COSTE_MIN[n] || 0)
          });
        }
      });

      if (!allSegs.length) { console.log("Sin segmentos calculables."); return null; }

      const enNaveSegs  = allSegs.filter(s => s.estado === "en_nave");
      const transitoSegs = allSegs.filter(s => s.estado === "transito");
      const viajes      = enNaveSegs.length;
      const totalNaveMin = enNaveSegs.reduce((s, x) => s + x.durMin, 0);
      const totalTransMin = transitoSegs.reduce((s, x) => s + x.durMin, 0);
      const mediaNaveSeg  = viajes ? Math.round(totalNaveMin / viajes) : 0;

      const costePorLanz = { 1: 0, 2: 0, 3: 0, 4: 0 };
      allSegs.forEach(s => { costePorLanz[s.numero] += s.coste; });
      const costeTotal = allSegs.reduce((s, x) => s + x.coste, 0);
      const totalMin   = allSegs.reduce((s, x) => s + x.durMin, 0);
      const tasaMedia  = totalMin > 0 ? costeTotal / totalMin : 8.68;

      const naveStats = {};
      enNaveSegs.forEach(s => {
        if (!s.nave) return;
        if (!naveStats[s.nave]) naveStats[s.nave] = { sum: 0, n: 0, coste: 0 };
        naveStats[s.nave].sum += s.durMin;
        naveStats[s.nave].n++;
        naveStats[s.nave].coste += s.coste;
      });

      const muelleStats = {};
      enNaveSegs.filter(s => s.muelle).forEach(s => {
        if (!muelleStats[s.muelle]) muelleStats[s.muelle] = { sum: 0, n: 0 };
        muelleStats[s.muelle].sum += s.durMin;
        muelleStats[s.muelle].n++;
      });
      const muellesArr = Object.entries(muelleStats)
        .map(([k, v]) => ({ muelle: k, avg: Math.round(v.sum / v.n), n: v.n }))
        .sort((a, b) => a.avg - b.avg);
      const masRapido = muellesArr[0] || null;
      const masLento  = muellesArr[muellesArr.length - 1] || null;

      const navesCostes = Object.entries(naveStats).sort((a, b) => b[1].coste - a[1].coste);
      const topEsperas  = enNaveSegs.slice().sort((a, b) => b.coste - a.coste).slice(0, 8);

      const fechaFmt = d.toString().padStart(2,"0") + "/" + m.toString().padStart(2,"0") + "/" + y;
      const CARD = "border-radius:8px;border:1px solid #e8e8e8;background:#ffffff;background-color:#ffffff;color:#1A1A1A";

      // ── Construir HTML ───────────────────────────────────────────────────

      function mCard(val, label) {
        return "<td style='padding:5px'><div style='" + CARD + ";padding:14px 8px;text-align:center'>" +
          "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px'>" + label + "</div>" +
          "<div style='font-size:18px;font-weight:700;color:#1A1A1A'>" + val + "</div>" +
          "</div></td>";
      }

      function dataRow(label, value) {
        return "<tr><td style='padding:6px 0;color:#555;font-size:13px;border-bottom:1px solid #f0f0f0'>" + label + "</td>" +
          "<td style='padding:6px 0;font-weight:600;text-align:right;font-size:13px;color:#1A1A1A;border-bottom:1px solid #f0f0f0'>" + value + "</td></tr>";
      }

      const metricRow =
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
        mCard(viajes + "", "Viajes a nave") +
        mCard(formatDur(mediaNaveSeg), "Tiempo medio por visita") +
        mCard(formatDur(totalNaveMin), "Total en nave") +
        mCard(formatDur(totalTransMin), "Total en transito") +
        "</tr></table>";

      // Nave times
      let naveRows = Object.entries(naveStats)
        .sort((a, b) => b[1].n - a[1].n)
        .map(([nave, s]) => dataRow(esc(NAVE_NOMBRE[nave] || nave), formatDur(Math.round(s.sum / s.n)) + " &middot; " + s.n + " vis."))
        .join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

      // Muelle times + ahorro
      const plazaM = ["M6","M7","M8","M18","M19","M20"].filter(m => muelleStats[m]);
      const mercaM  = ["M2","M4"].filter(m => muelleStats[m]);
      let muelleRows = "";
      if (plazaM.length) {
        muelleRows += "<tr><td colspan='2' style='padding:4px 0 2px;font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em'>Plaza</td></tr>";
        plazaM.forEach(mu => { const s = muelleStats[mu]; muelleRows += dataRow(mu, formatDur(Math.round(s.sum/s.n)) + " &middot; " + s.n + " vis."); });
      }
      if (mercaM.length) {
        muelleRows += "<tr><td colspan='2' style='padding:8px 0 2px;font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em'>Merca</td></tr>";
        mercaM.forEach(mu => { const s = muelleStats[mu]; muelleRows += dataRow(mu, formatDur(Math.round(s.sum/s.n)) + " &middot; " + s.n + " vis."); });
      }
      if (!muelleRows) muelleRows = "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

      if (masRapido && masLento && masRapido.muelle !== masLento.muelle) {
        const diffMin = masLento.avg - masRapido.avg;
        const ahorroVisita = diffMin * tasaMedia;
        const ahorroTotal  = ahorroVisita * masRapido.n;
        muelleRows += "<tr><td colspan='2'><div style='margin-top:12px;padding-top:10px;border-top:1px solid #eee'>" +
          "<div style='font-size:12px;color:#1D9E75;margin-bottom:3px'>&#9650; Mas rapido: <strong>" + esc(masRapido.muelle) + "</strong> &middot; " + formatDur(masRapido.avg) + " media</div>" +
          "<div style='font-size:12px;color:#D41F3A;margin-bottom:8px'>&#9660; Mas lento: <strong>" + esc(masLento.muelle) + "</strong> &middot; " + formatDur(masLento.avg) + " media</div>" +
          "<div style='font-size:12px;background:#f0faf5;border-radius:6px;padding:8px;color:#374151'>" +
          "Diferencia: <strong>" + formatDur(diffMin) + "</strong> por visita &middot; Ahorro estimado en " + esc(masRapido.muelle) + ": <strong style='color:#1D9E75'>" + formatEuro(ahorroTotal) + "</strong> (" + masRapido.n + " vis. &times; " + formatEuro(ahorroVisita) + ")" +
          "</div></div></td></tr>";
      }

      const lanzCards = [1,2,3,4].map(n =>
        "<td style='padding:5px'><div style='" + CARD + ";padding:12px 6px;text-align:center'>" +
        "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px'>Lanzadera " + n + "</div>" +
        "<div style='font-size:16px;font-weight:700;color:" + (costePorLanz[n] > 0 ? "#1A1A1A" : "#ccc") + "'>" + (costePorLanz[n] > 0 ? formatEuro(costePorLanz[n]) : "—") + "</div>" +
        "</div></td>"
      ).join("");

      const naveCosteRows = navesCostes.map(([nave, s]) =>
        dataRow(esc(NAVE_NOMBRE[nave] || nave), formatEuro(s.coste))
      ).join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

      const esperasTh = "<tr style='background:#f5f5f5'>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Lanzadera</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Nave</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Muelle</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Duracion</th>" +
        "<th style='padding:5px 8px;text-align:right;font-size:11px;color:#888;font-weight:600'>Coste</th></tr>";
      const esperasTr = topEsperas.map(s =>
        "<tr><td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>L" + s.numero + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(NAVE_NOMBRE[s.nave] || s.nave || "?") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(s.muelle || "—") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + formatDur(s.durMin) + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;font-weight:700;color:#D41F3A;text-align:right;border-bottom:1px solid #f5f5f5'>" + formatEuro(s.coste) + "</td></tr>"
      ).join("");

      // Detalle por lanzadera: misma tabla que muestra el panel
      const TH = "padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600";
      const TD = "padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5";

      const detalleLanz = [1, 2, 3, 4].map(n => {
        const segsN = allSegs.filter(s => s.numero === n).sort((a, b) => a.startMs - b.startMs);
        if (!segsN.length) return "";
        const totalN = segsN.reduce((acc, s) => acc + s.coste, 0);
        const filas = segsN.map(s => {
          const nave = s.estado === "transito"
            ? ("&rarr; " + esc(NAVE_NOMBRE[s.destino] || s.destino || NAVE_NOMBRE[s.nave] || s.nave || "?"))
            : esc(NAVE_NOMBRE[s.nave] || s.nave || "—");
          const accion = s.accion
            ? (ACCION_LABEL[s.accion] || s.accion)
            : (s.estado === "transito" ? "Transito" : "—");
          return "<tr>" +
            "<td style='" + TD + "'>" + horaMadrid(s.startMs) + "</td>" +
            "<td style='" + TD + "'>" + (s.estado === "en_nave" ? "En nave" : "Transito") + "</td>" +
            "<td style='" + TD + "'>" + nave + "</td>" +
            "<td style='" + TD + "'>" + esc(s.muelle || "—") + "</td>" +
            "<td style='" + TD + "'>" + esc(accion) + "</td>" +
            "<td style='" + TD + "'>" + formatDur(s.durMin) + "</td>" +
            "<td style='" + TD + ";text-align:right'>" + formatEuro(s.coste) + "</td>" +
            "</tr>";
        }).join("");
        return "<div style='height:10px'></div>" +
          "<div style='" + CARD + ";padding:14px'>" +
          "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>" +
          "Lanzadera " + n + " &mdash; coste hoy: " + formatEuro(totalN) + "</div>" +
          "<table width='100%' cellpadding='0' cellspacing='0'>" +
          "<tr style='background:#f5f5f5'>" +
          "<th style='" + TH + "'>Entrada</th><th style='" + TH + "'>Estado</th>" +
          "<th style='" + TH + "'>Nave</th><th style='" + TH + "'>Muelle</th>" +
          "<th style='" + TH + "'>Accion</th><th style='" + TH + "'>Duracion</th>" +
          "<th style='" + TH + ";text-align:right'>Coste</th></tr>" +
          filas + "</table></div>";
      }).join("");

      const htmlBruto =
        HEAD_EMAIL + "<body bgcolor='#f0f0f0' style='margin:0;padding:16px;background-color:#f0f0f0;" + FONT + "'>" +
        "<div style='max-width:900px;margin:0 auto'>" +

        "<div style='background:#D41F3A;border-radius:8px;padding:20px 22px;margin-bottom:12px'>" +
        "<div style='color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px'>Aldelis</div>" +
        "<div style='color:rgba(255,255,255,.8);font-size:12px;margin-top:2px'>Informe de costes de operacion &middot; " + fechaFmt + "</div>" +
        "</div>" +

        metricRow +

        "<div style='height:10px'></div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
        "<td width='49%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Tiempo medio por nave</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + naveRows + "</table></td>" +
        "<td width='2%'></td>" +
        "<td width='49%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Tiempo medio por muelle</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + muelleRows + "</table></td>" +
        "</tr></table>" +

        // Costes de operacion: las dos tarjetas van dentro, como en el panel
        "<div style='height:10px'></div>" +
        "<div style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Costes de operacion</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" + lanzCards + "</tr></table>" +
        "<div style='height:12px'></div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
        "<td width='35%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Coste por nave</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + naveCosteRows + "</table></td>" +
        "<td width='2%'></td>" +
        "<td width='63%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Esperas mas caras</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + esperasTh + esperasTr + "</table></td>" +
        "</tr></table>" +
        "</div>" +

        detalleLanz +

        "<div style='height:14px'></div>" +
        "<div style='text-align:center;font-size:11px;color:#aaa'>Costes de operacion del dia, no importe fijo del contrato &middot; " + diasLaborables + " dias laborables configurados</div>" +
        "</div></body></html>";

      // Repite la familia tipografica en cada elemento con texto: sin esto,
      // Outlook de escritorio pinta las tablas en Times New Roman.
      const html = forzarFuente(htmlBruto);

      const asunto = "Informe de costes Lanzaderas — " + fechaFmt + " — " + formatEuro(costeTotal);
      const cuerpo = "Informe de costes " + fechaFmt + " — Total operaciones: " + formatEuro(costeTotal);

      const token = await obtenerTokenMS();
      for (const email of emails) {
        await enviarConGraph(token, email, asunto, html, cuerpo, null);
      }

      console.log("Informe diario enviado a", emails.length, "destinatarios. Total:", formatEuro(costeTotal));
      return null;

    } catch(e) {
      console.error("Error en generarYEnviarInforme:", e);
      return null;
    }
}

// ── Funciones programadas ────────────────────────────────────────────────────

exports.enviarInformeDiario = onSchedule(
  { schedule: "59 23 * * *", timeZone: "Europe/Madrid" },
  () => generarYEnviarInforme("23:59")
);

exports.enviarInformeManana = onSchedule(
  { schedule: "30 8 * * *", timeZone: "Europe/Madrid" },
  () => generarYEnviarInforme("08:30")
);

// ── Informe diario Bizerba ───────────────────────────────────────────────────

async function generarYEnviarInformeBizerba() {
  console.log("Iniciando informe diario Bizerba...");
  try {
    const [bizSnap] = await Promise.all([
      db.collection("config").doc("bizerba").get()
    ]);

    const emails = (bizSnap.exists && Array.isArray(bizSnap.data().emails))
      ? bizSnap.data().emails : [];
    if (!emails.length) { console.log("Sin destinatarios Bizerba."); return null; }

    // Rango del día en hora Madrid
    const fechaStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
    const [y, m, d] = fechaStr.split("-").map(Number);
    const tsStart = admin.firestore.Timestamp.fromDate(
      new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - (new Date(fechaStr + "T00:00:00+02:00").getTime() - new Date(fechaStr + "T00:00:00Z").getTime()))
    );
    const tsEnd = admin.firestore.Timestamp.fromDate(
      new Date(tsStart.toDate().getTime() + 86400000)
    );

    const snap = await db.collection("incidencias")
      .where("creada", ">=", tsStart)
      .where("creada", "<", tsEnd)
      .orderBy("creada")
      .get();

    const fechaFmt = d.toString().padStart(2,"0") + "/" + m.toString().padStart(2,"0") + "/" + y;
    const CARD = "border-radius:8px;border:1px solid #e8e8e8;background:#ffffff;background-color:#ffffff;color:#1A1A1A";

    const incs = [];
    snap.forEach(doc => incs.push({ id: doc.id, ...doc.data() }));

    const total     = incs.length;
    const resueltas = incs.filter(i => i.estado === "resuelta");
    const sinResolver = incs.filter(i => i.estado !== "resuelta");
    const conRepuesto = incs.filter(i => i.estado === "repuesto");

    // Tiempos de respuesta (creada → aceptada)
    const tResps = incs.filter(i => i.aceptada && i.creada)
      .map(i => (i.aceptada.toMillis() - i.creada.toMillis()) / 60000);
    const mediaResp = tResps.length ? Math.round(tResps.reduce((a,b) => a+b,0) / tResps.length) : null;

    // Tiempos de resolución (aceptada → resuelta)
    const tResos = resueltas.filter(i => i.aceptada && i.resuelta)
      .map(i => (i.resuelta.toMillis() - i.aceptada.toMillis()) / 60000);
    const mediaReso = tResos.length ? Math.round(tResos.reduce((a,b) => a+b,0) / tResos.length) : null;

    // Stats por técnico
    const porTecnico = {};
    incs.filter(i => i.tecnico).forEach(i => {
      if (!porTecnico[i.tecnico]) porTecnico[i.tecnico] = { total: 0, resueltas: 0, tResps: [], tResos: [] };
      porTecnico[i.tecnico].total++;
      if (i.estado === "resuelta") porTecnico[i.tecnico].resueltas++;
      if (i.aceptada && i.creada) porTecnico[i.tecnico].tResps.push((i.aceptada.toMillis() - i.creada.toMillis()) / 60000);
      if (i.resuelta && i.aceptada) porTecnico[i.tecnico].tResos.push((i.resuelta.toMillis() - i.aceptada.toMillis()) / 60000);
    });

    // Stats por línea
    const porLinea = {};
    incs.forEach(i => {
      if (!porLinea[i.linea]) porLinea[i.linea] = 0;
      porLinea[i.linea]++;
    });
    const lineasOrdenadas = Object.entries(porLinea).sort((a,b) => b[1] - a[1]);

    function mCard(val, label) {
      return "<td style='padding:5px'><div style='" + CARD + ";padding:14px 8px;text-align:center'>" +
        "<div style='font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px'>" + label + "</div>" +
        "<div style='font-size:18px;font-weight:700;color:#1A1A1A'>" + val + "</div>" +
        "</div></td>";
    }

    function dataRow(label, value) {
      return "<tr><td style='padding:6px 0;color:#555;font-size:13px;border-bottom:1px solid #f0f0f0'>" + label + "</td>" +
        "<td style='padding:6px 0;font-weight:600;text-align:right;font-size:13px;color:#1A1A1A;border-bottom:1px solid #f0f0f0'>" + value + "</td></tr>";
    }

    const metricRow =
      "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
      mCard(total + "", "Total") +
      mCard(resueltas.length + "", "Resueltas") +
      mCard(sinResolver.length + "", "Sin resolver") +
      mCard(conRepuesto.length + "", "Falta repuesto") +
      "</tr></table>";

    const tiemposRow =
      "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
      mCard(mediaResp != null ? formatDur(mediaResp) : "—", "T. medio respuesta") +
      mCard(mediaReso != null ? formatDur(mediaReso) : "—", "T. medio resolución") +
      "</tr></table>";

    // Tabla por técnico
    const tecnicoRows = Object.entries(porTecnico).sort((a,b) => b[1].total - a[1].total).map(([t, s]) => {
      const mR = s.tResps.length ? Math.round(s.tResps.reduce((a,b)=>a+b,0)/s.tResps.length) : null;
      const mO = s.tResos.length ? Math.round(s.tResos.reduce((a,b)=>a+b,0)/s.tResos.length) : null;
      return dataRow("Técnico " + t, s.resueltas + "/" + s.total + " · resp: " + (mR != null ? formatDur(mR) : "—") + " · reso: " + (mO != null ? formatDur(mO) : "—"));
    }).join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

    // Tabla por línea
    const lineaRows = lineasOrdenadas.slice(0, 10).map(([l, n]) =>
      dataRow("Línea " + l, n + " incidencia" + (n > 1 ? "s" : ""))
    ).join("") || "<tr><td colspan='2' style='color:#bbb;font-size:13px;padding:8px 0'>Sin datos</td></tr>";

    // Incidencias sin resolver
    const sinResolverRows = sinResolver.length ? sinResolver.map(i => {
      const espera = i.creada ? Math.round((Date.now() - i.creada.toMillis()) / 60000) : null;
      const estadoLbl = { abierta: "Sin coger", aceptada: "En curso", repuesto: "Falta repuesto" }[i.estado] || i.estado;
      return "<tr>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>L" + i.linea + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(i.averia || "—") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + estadoLbl + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + (i.tecnico ? "T" + i.tecnico : "—") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5;color:#D41F3A;font-weight:600'>" + (espera != null ? formatDur(espera) : "—") + "</td>" +
        "</tr>";
    }).join("") : "<tr><td colspan='5' style='padding:8px;color:#1D9E75;font-size:13px;text-align:center'>Todas resueltas ✓</td></tr>";

    const htmlBruto =
      HEAD_EMAIL + "<body bgcolor='#f0f0f0' style='margin:0;padding:16px;background-color:#f0f0f0;" + FONT + "'>" +
      "<div style='max-width:700px;margin:0 auto'>" +

      "<div style='background:#1A1A1A;border-radius:8px;padding:20px 22px;margin-bottom:12px'>" +
      "<div style='color:#fff;font-size:20px;font-weight:700;letter-spacing:-.5px'>Aldelis</div>" +
      "<div style='color:rgba(255,255,255,.7);font-size:12px;margin-top:2px'>Informe de incidencias Bizerba &middot; " + fechaFmt + "</div>" +
      "</div>" +

      metricRow +
      "<div style='height:8px'></div>" +
      tiemposRow +

      "<div style='height:10px'></div>" +
      "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
      "<td width='49%' valign='top' style='" + CARD + ";padding:14px'>" +
      "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Por técnico</div>" +
      "<table width='100%' cellpadding='0' cellspacing='0'>" + tecnicoRows + "</table></td>" +
      "<td width='2%'></td>" +
      "<td width='49%' valign='top' style='" + CARD + ";padding:14px'>" +
      "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Líneas con más incidencias</div>" +
      "<table width='100%' cellpadding='0' cellspacing='0'>" + lineaRows + "</table></td>" +
      "</tr></table>" +

      "<div style='height:10px'></div>" +
      "<div style='" + CARD + ";padding:14px'>" +
      "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Incidencias sin resolver al cierre</div>" +
      "<table width='100%' cellpadding='0' cellspacing='0'>" +
      "<tr style='background:#f5f5f5'>" +
      "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Línea</th>" +
      "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Avería</th>" +
      "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Estado</th>" +
      "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Técnico</th>" +
      "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>T. abierta</th>" +
      "</tr>" +
      sinResolverRows +
      "</table></div>" +

      "<div style='height:14px'></div>" +
      "<div style='text-align:center;font-size:11px;color:#aaa'>Informe de incidencias de etiquetado Bizerba &middot; " + fechaFmt + "</div>" +
      "</div></body></html>";

    const html = forzarFuente(htmlBruto);

    const asunto = "Informe Bizerba — " + fechaFmt + " — " + total + " incidencias (" + resueltas.length + " resueltas)";
    const cuerpo = "Informe Bizerba " + fechaFmt + " — Total: " + total + " incidencias, " + resueltas.length + " resueltas, " + sinResolver.length + " sin resolver.";

    const token = await obtenerTokenMS();
    for (const email of emails) {
      await enviarConGraph(token, email, asunto, html, cuerpo, null);
    }

    console.log("Informe Bizerba enviado a", emails.length, "destinatarios.");
    return null;

  } catch(e) {
    console.error("Error en generarYEnviarInformeBizerba:", e);
    return null;
  }
}

exports.enviarInformeBizerba = onSchedule(
  { schedule: "59 23 * * *", timeZone: "Europe/Madrid" },
  () => generarYEnviarInformeBizerba()
);

// ── Borrado de fotos del chat ───────────────────────────────────────────────
// Las fotos ocupan mucho mas que el texto, asi que si no se borran la base de
// datos crece sin control. Los mensajes SI se conservan: lo que se hace con
// ellos es no leer los de dias anteriores, que es distinto de borrarlos. Al
// tocar una foto ya borrada, el cliente avisa de que caduco.

const DIAS_FOTOS = 3;

exports.limpiarFotos = onSchedule(
  { schedule: "15 4 * * *", timeZone: "Europe/Madrid" },
  async () => {
    const corte = admin.firestore.Timestamp.fromMillis(
      Date.now() - DIAS_FOTOS * 24 * 60 * 60 * 1000
    );

    let total = 0;
    // En tandas: un lote de Firestore admite 500 operaciones.
    for (;;) {
      const snap = await db.collection("fotos")
        .where("ts", "<", corte)
        .limit(400)
        .get();
      if (snap.empty) break;

      const lote = db.batch();
      snap.forEach(d => lote.delete(d.ref));
      await lote.commit();
      total += snap.size;

      if (snap.size < 400) break;
    }

    console.log("Fotos borradas por antiguedad (" + DIAS_FOTOS + " dias):", total);
    return null;
  }
);

// ── Un conductor, una lanzadera ─────────────────────────────────────────────
// El conductor escribe su nombre y telefono en el documento de la lanzadera que
// lleva, pero no puede borrar el de otra (las reglas no le dejan, y mejor asi).
// De eso se encarga el servidor: en cuanto alguien se identifica en una
// lanzadera, se libera cualquier otra que tuviera su mismo telefono.

function soloDigitos(t) {
  return String(t || "").replace(/[^0-9]/g, "");
}

exports.choferUnaLanzadera = onDocumentWritten("lanzaderas_chofer/{id}", async (event) => {
  const nuevo = event.data && event.data.after && event.data.after.exists
    ? event.data.after.data() : null;
  if (!nuevo) return;

  const tel = soloDigitos(nuevo.telefono);
  if (!tel) return;

  const snap = await db.collection("lanzaderas_chofer").get();
  const sobran = [];
  snap.forEach(d => {
    if (d.id === event.params.id) return;
    if (soloDigitos(d.data().telefono) === tel) sobran.push(d.id);
  });

  for (const id of sobran) {
    try {
      await db.collection("lanzaderas_chofer").doc(id).delete();
      console.log("Liberada la lanzadera", id, "porque", nuevo.nombre,
                  "paso a la", event.params.id);
    } catch (e) { console.error("liberar", id, e.message); }
  }
});

// Al fichar fin de jornada se libera la lanzadera: si no, el conductor seguiria
// apareciendo al dia siguiente hasta que alguien lo pisara.
exports.liberarChoferAlSalir = onDocumentWritten("lanzaderas/{id}", async (event) => {
  const d = event.data && event.data.after && event.data.after.exists
    ? event.data.after.data() : null;
  if (!d) return;
  if (d.estado !== "fuera" && d.activa !== false) return;

  const ref = db.collection("lanzaderas_chofer").doc(event.params.id);
  const prev = await ref.get();
  if (!prev.exists) return;

  try {
    await ref.delete();
    console.log("Fin de jornada: liberada la lanzadera", event.params.id);
  } catch (e) { console.error("liberar al salir:", e.message); }
});

// ── Notificación push al chat de lanzaderas ─────────────────────────────────

exports.notifChat = onDocumentCreated("mensajes/{msgId}", async (event) => {
  const msg = event.data ? event.data.data() : null;
  if (!msg || !msg.texto) return;

  // Se avisa solo al lado que NO ha escrito, y en el caso del conductor solo al
  // de su lanzadera. Antes se leia la coleccion entera y se enviaba a todos:
  // el conductor de la 3 recibia los mensajes de la 1 y el almacen los suyos.
  let query;
  let titulo;
  if (msg.de === "almacen") {
    if (!msg.lanzadera) return;
    query  = db.collection("push_tokens")
               .where("rol", "==", "lanzadera")
               .where("lanzadera", "==", msg.lanzadera);
    titulo = "Almacen" + (msg.emisor ? " · " + msg.emisor : "");
  } else {
    query  = db.collection("push_tokens").where("rol", "==", "almacen");
    titulo = "Lanzadera " + (msg.lanzadera || "?");
  }

  const snap = await query.get();
  if (snap.empty) return;

  const tokens = [];
  snap.forEach(d => { if (d.data().token) tokens.push(d.data().token); });
  if (!tokens.length) return;

  const cuerpo = msg.texto.length > 120 ? msg.texto.slice(0, 117) + "…" : msg.texto;
  const destino = msg.de === "almacen" ? "/lanzadera.html" : "/admin.html";

  const caducados = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const lote = tokens.slice(i, i + 500);
    // Solo "data": el service worker construye el aviso. Si se enviara el
    // bloque "notification" el navegador mostraria otro por su cuenta y
    // saldrian dos, sin control sobre icono ni vibracion.
    const res = await admin.messaging().sendEachForMulticast({
      tokens: lote,
      data: {
        title: titulo,
        body:  cuerpo,
        url:   destino,
        tag:   "chat-" + (msg.lanzadera || "0")
      },
      webpush: {
        headers: { Urgency: "high", TTL: "600" },
        fcmOptions: { link: destino }
      }
    });
    res.responses.forEach((r, idx) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token") {
        caducados.push(lote[idx]);
      }
    });
  }

  // Los tokens que ya no valen se borran: si no, la coleccion crece sin limite
  // y cada mensaje del chat cuesta mas lecturas.
  for (const t of caducados) {
    try { await db.collection("push_tokens").doc(t).delete(); } catch (e) {}
  }
  if (caducados.length) console.log("Tokens caducados eliminados:", caducados.length);
});

// ── Palets pendientes en almacenes externos (Avitrans/Caserfri/Txt) ────────
//
// Modelo: cada pedido de transferencia (codigo "PT......") es un documento
// en pedidos_transferencia con cuantos palets trae. Al crearse, se SUMA al
// saldo pendiente de su almacen (almacenes_pendientes). Cada vez que un
// chofer sale de ese almacen y dice cuantos palets se lleva, se crea un
// documento en recogidas_palets, que RESTA de ese mismo saldo. El saldo en
// si (almacenes_pendientes) solo lo toca el servidor, nunca el cliente,
// para que sea siempre la suma real de lo dado de alta menos lo recogido.

const ALMACENES_PT = ["avitrans", "caserfri", "txt"];

exports.sumarPedidoTransferencia = onDocumentCreated("pedidos_transferencia/{id}", async (event) => {
  const d = event.data ? event.data.data() : null;
  if (!d || !ALMACENES_PT.includes(d.almacen)) return;
  await db.collection("almacenes_pendientes").doc(d.almacen).set({
    pedido: admin.firestore.FieldValue.increment(d.palets || 0)
  }, { merge: true });
});

exports.restarRecogidaPalets = onDocumentCreated("recogidas_palets/{id}", async (event) => {
  const d = event.data ? event.data.data() : null;
  if (!d || !ALMACENES_PT.includes(d.almacen)) return;
  await db.collection("almacenes_pendientes").doc(d.almacen).set({
    recogido: admin.firestore.FieldValue.increment(d.palets || 0)
  }, { merge: true });

  // El chofer marca que PT concretos se lleva y cuantos palets de CADA uno
  // (no siempre cargan el pedido completo), asi que cada item de "pts" trae
  // su propia cantidad en vez de repartir el total a partes iguales.
  if (Array.isArray(d.pts) && d.pts.length) {
    for (const item of d.pts) {
      const ptCode = item && item.pt;
      const palets = item && item.palets;
      if (!ptCode || !(palets > 0)) continue;
      try {
        const ref = db.collection("pedidos_transferencia").doc(ptCode);
        await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref);
          if (!doc.exists) return;
          const actual = doc.data();
          const recogidoNuevo = (actual.recogido || 0) + palets;
          tx.update(ref, {
            recogido: recogidoNuevo,
            cerrado: recogidoNuevo >= (actual.palets || 0)
          });
        });
      } catch (e) { console.error("marcar PT recogido:", ptCode, e.message); }
    }
  }
});

// ── Lectura automatica del correo de pedidos ────────────────────────────────
//
// Revisa cada 10 minutos el buzon indicado (Microsoft Graph, misma app que
// ya usamos para enviar correos) en busca de mensajes nuevos con adjunto.
// Identifica el almacen mirando el dominio de los destinatarios (Para/CC):
// si alguno termina en "@avitrans.com" (etc.), ese es el almacen del
// pedido. Procesa el Excel si lo hay; si solo mandan PDF, procesa el PDF.
// Cada linea del archivo (cada SSCC) cuenta como un palet.
//
// Requiere que la app de Microsoft 365 tenga concedido el permiso de
// aplicacion "Mail.Read" sobre el buzon indicado (ver README). Sin eso, la
// funcion no falla ni avisa por email, simplemente no encuentra nada que
// procesar cada vez que se ejecuta.

const BUZON_PEDIDOS = "avitrans@aldelis.com"; // ajustar aqui si se decide otro buzon

// Dominio de correo de cada almacen externo. "avitrans.com" confirmado por
// el usuario; caserfri.com y txt.com son un supuesto razonable a falta de
// confirmarlos - hay que revisarlos con un correo real de cada uno antes de
// confiar en la deteccion automatica para esos dos.
const DOMINIOS_ALMACEN = {
  "avitrans.com": "avitrans",
  "caserfri.com": "caserfri",
  "txt.com":      "txt"
};

async function graphGet(token, url) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Graph GET " + res.status + ": " + (await res.text()).slice(0, 300));
  return res.json();
}

async function graphMarcarLeido(token, msgId) {
  await fetch("https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msgId, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ isRead: true })
  });
}

function detectarAlmacenPorDestinatarios(msg) {
  const direcciones = []
    .concat((msg.toRecipients || []).map(r => r.emailAddress && r.emailAddress.address))
    .concat((msg.ccRecipients || []).map(r => r.emailAddress && r.emailAddress.address))
    .filter(Boolean)
    .map(a => a.toLowerCase());
  for (const dir of direcciones) {
    for (const dominio in DOMINIOS_ALMACEN) {
      if (dir.endsWith("@" + dominio)) return DOMINIOS_ALMACEN[dominio];
    }
  }
  return null;
}

// Cada fila con SSCC es un palet. Busca la columna "SSCC" en la primera fila
// que la tenga (por si el archivo trae cabeceras u otras filas antes) y
// cuenta valores distintos en esa columna.
function contarPaletsExcel(buffer) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let colSscc = -1, inicio = 0;
  for (let i = 0; i < filas.length; i++) {
    const idx = (filas[i] || []).findIndex(c => String(c || "").toUpperCase().trim() === "SSCC");
    if (idx !== -1) { colSscc = idx; inicio = i + 1; break; }
  }
  if (colSscc === -1) return { palets: 0, lineas: [] };
  const ssccs = new Set();
  for (let i = inicio; i < filas.length; i++) {
    const v = (filas[i] || [])[colSscc];
    if (v) ssccs.add(String(v).trim());
  }
  return { palets: ssccs.size, lineas: [...ssccs].map(sscc => ({ sscc })) };
}

// El PDF no trae columnas fiables al extraer el texto, pero el SSCC son
// siempre 18 digitos seguidos: contar esos patrones (sin repetir) da el
// numero de palets sin depender del formato exacto de la plantilla.
async function contarPaletsPdf(buffer) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  let texto = "";
  try {
    const resultado = await parser.getText();
    texto = resultado.text || "";
  } finally {
    await parser.destroy();
  }
  const ssccs = [...new Set(texto.match(/\b\d{18}\b/g) || [])];
  const ptMatch = texto.match(/PT\d{6}/);
  return { palets: ssccs.length, lineas: ssccs.map(sscc => ({ sscc })), pt: ptMatch ? ptMatch[0] : null };
}

async function crearPedidoTransferencia(pt, almacen, resultado, origen) {
  if (!resultado.palets) return;
  const ref = db.collection("pedidos_transferencia").doc(pt);
  try {
    await ref.create({
      almacen, palets: resultado.palets, recogido: 0, cerrado: false,
      lineas: resultado.lineas || [], origen,
      creado: admin.firestore.Timestamp.now()
    });
  } catch (e) {
    // Ya existe (mismo PT procesado antes, p.ej. el correo llego duplicado):
    // no se pisa el progreso de recogida que ya pudiera tener.
    if (e.code !== 6 /* ALREADY_EXISTS */) throw e;
    console.log("PT ya existia, no se repite:", pt);
  }
}

// Subida manual desde el panel (arrastrar/elegir archivo). Pasa por el
// servidor en vez de leerse en el navegador para reutilizar exactamente el
// mismo analisis de Excel/PDF que usa la lectura automatica del correo, sin
// duplicar la logica ni depender de una libreria de PDF en el cliente.
exports.procesarPedidoTransferencia = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccion(email, "lanzaderas"))) return { ok: false, error: "Sin permiso" };

  if (!data || typeof data !== "object") return { ok: false, error: "Faltan datos" };
  const almacen = data.almacen;
  const nombreArchivo = String(data.nombreArchivo || "");
  const contenidoBase64 = data.contenidoBase64;
  if (!ALMACENES_PT.includes(almacen)) return { ok: false, error: "Almacen no valido" };
  if (typeof contenidoBase64 !== "string" || !contenidoBase64) return { ok: false, error: "Falta el archivo" };
  if (contenidoBase64.length > 15 * 1024 * 1024) return { ok: false, error: "Archivo demasiado grande" };

  let buffer;
  try { buffer = Buffer.from(contenidoBase64, "base64"); }
  catch (e) { return { ok: false, error: "Archivo no valido" }; }

  const esExcel = /\.xlsx?$/i.test(nombreArchivo);
  const esPdf   = /\.pdf$/i.test(nombreArchivo);
  if (!esExcel && !esPdf) return { ok: false, error: "Solo se admite Excel o PDF" };

  let resultado;
  try {
    resultado = esExcel ? contarPaletsExcel(buffer) : await contarPaletsPdf(buffer);
  } catch (e) {
    console.error("procesarPedidoTransferencia: parseo:", e.message);
    return { ok: false, error: "No se pudo leer el archivo" };
  }

  if (!resultado.palets) return { ok: false, error: "No se encontraron palets (SSCC) en el archivo" };

  const pt = resultado.pt
    || (nombreArchivo.match(/PT\d{6}/) || [])[0]
    || ("SINPT-" + Date.now().toString(36).toUpperCase());

  try {
    await crearPedidoTransferencia(pt, almacen, resultado, "manual");
  } catch (e) {
    console.error("procesarPedidoTransferencia: guardar:", e.message);
    return { ok: false, error: "No se pudo guardar el pedido" };
  }

  return { ok: true, pt, palets: resultado.palets };
});

exports.revisarCorreoPedidos = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Europe/Madrid" },
  async () => {
    if (!MS_SECRET) { console.warn("revisarCorreoPedidos: falta MS_SECRET"); return; }

    let token;
    try { token = await obtenerTokenMS(); }
    catch (e) { console.error("revisarCorreoPedidos: token:", e.message); return; }

    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25" +
        "&$select=id,subject,toRecipients,ccRecipients,hasAttachments");
    } catch (e) { console.error("revisarCorreoPedidos: listar mensajes:", e.message); return; }

    for (const msg of (data.value || [])) {
      try {
        if (!msg.hasAttachments) { await graphMarcarLeido(token, msg.id); continue; }

        const almacen = detectarAlmacenPorDestinatarios(msg);
        if (!almacen) {
          console.log("revisarCorreoPedidos: sin almacen reconocido en", msg.subject);
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const adjuntos = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "/attachments");
        const conContenido = (adjuntos.value || []).filter(a => a.contentBytes);
        const excel = conContenido.find(a => /\.xlsx?$/i.test(a.name || ""));
        const pdfAdj = conContenido.find(a => /\.pdf$/i.test(a.name || ""));
        const elegido = excel || pdfAdj;
        if (!elegido) { await graphMarcarLeido(token, msg.id); continue; }

        const buffer = Buffer.from(elegido.contentBytes, "base64");
        const resultado = elegido === excel ? contarPaletsExcel(buffer) : await contarPaletsPdf(buffer);
        const pt = (resultado.pt)
          || (elegido.name.match(/PT\d{6}/) || [])[0]
          || ((msg.subject || "").match(/PT\d{6}/) || [])[0]
          || ("SINPT-" + msg.id.slice(-8));

        await crearPedidoTransferencia(pt, almacen, resultado, "email");
        await graphMarcarLeido(token, msg.id);
      } catch (e) {
        console.error("revisarCorreoPedidos: mensaje", msg.id, e.message);
      }
    }
  }
);
