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

// adjuntosExtra: array opcional de adjuntos "de verdad" (no inline), p.ej.
// [{ name, contentType, contentBytes }], para mandar un archivo descargable
// ademas de (o en vez de) la imagen inline de siempre.
async function enviarConGraph(token, to, subject, html, body, imageBase64, adjuntosExtra) {
  const attachments = imageBase64 ? [{
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "informe.png",
    contentType: "image/png",
    contentBytes: imageBase64,
    contentId: "informe-costes",
    isInline: true
  }] : [];
  (adjuntosExtra || []).forEach(a => {
    attachments.push({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.contentBytes,
      contentId: a.contentId || undefined,
      isInline: !!a.isInline
    });
  });

  // "to" puede ser un string (un solo destinatario, como siempre) o un
  // array (varios destinatarios reales en el mismo correo, para que cada
  // uno vea en el "Para" a quien mas se le ha mandado - antes se mandaba
  // una copia aparte a cada uno, y nadie veia al resto).
  const destinatarios = Array.isArray(to) ? to : [to];

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
          toRecipients: destinatarios.map(d => ({ emailAddress: { address: d } })),
          attachments
        },
        saveToSentItems: false
      })
    }
  );
  console.log("Graph API status:", res.status, "a", destinatarios.join(", "));
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

// Como puedeSeccion(), pero sin el refuerzo progresivo: sin ficha en
// /permisos que lo incluya, no hay acceso. Para secciones nuevas que no
// tienen un pasado que proteger (mismo criterio que permitidoEstricto en
// firestore.rules).
async function puedeSeccionEstricto(email, seccion) {
  if (!email) return false;
  if (ADMINS_APP.includes(email)) return true;
  try {
    const d = await db.collection("permisos").doc(email).get();
    if (!d.exists) return false;
    const s = d.data().secciones;
    return Array.isArray(s) && s.includes(seccion);
  } catch (e) {
    console.warn("puedeSeccionEstricto", e.message);
    return false;
  }
}

const SECCION_LABEL = { seco: "Almacen Seco", frio: "Almacen Frio", lavadero: "Lavadero" };
const FIRMA = "\n\nAldelis — Gestion de almacenes";
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
        "<div style='text-align:center;font-size:11px;color:#aaa'>Aldelis &middot; Gestion de almacenes</div>" +
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

      // Palets recogidos hoy en los almacenes externos (Avitrans/Caserfri/
      // Txt): resumen por almacen y detalle por pedido, con las lineas
      // (SSCC + descripcion) de los pedidos que se han cerrado del todo hoy.
      // En una recogida parcial no sabemos que SSCC exactos se llevaron
      // (el chofer solo dice cuantos, no cuales), asi que esos se listan
      // solo con la cantidad, sin lineas.
      let recogidasHoyHtml = "";
      try {
        const recogSnap = await db.collection("recogidas_palets")
          .where("ts", ">=", tsStart).where("ts", "<", tsEnd).get();
        const recogidasHoy = [];
        recogSnap.forEach(doc => recogidasHoy.push(doc.data()));

        if (recogidasHoy.length) {
          const porAlmacen = {};
          const ptsUsados = new Set();
          recogidasHoy.forEach(r => {
            porAlmacen[r.almacen] = (porAlmacen[r.almacen] || 0) + (r.palets || 0);
            (r.pts || []).forEach(item => { if (item && item.pt) ptsUsados.add(item.pt); });
          });

          const ptDocs = {};
          await Promise.all([...ptsUsados].map(async pt => {
            const d = await db.collection("pedidos_transferencia").doc(pt).get();
            if (d.exists) ptDocs[pt] = d.data();
          }));

          const NOMBRE_ALMACEN = { avitrans: "Avitrans", caserfri: "Caserfri", txt: "Txt" };
          const resumenRows = Object.entries(porAlmacen)
            .sort((a, b) => b[1] - a[1])
            .map(([alm, n]) => dataRow(NOMBRE_ALMACEN[alm] || alm, n + " palets"))
            .join("");

          const detalleRows = recogidasHoy.flatMap(r => (r.pts || []).map(item => {
            const ptDoc = ptDocs[item.pt];
            const lineas = ptDoc && Array.isArray(ptDoc.lineas) ? ptDoc.lineas : [];
            const cerradoDelTodo = ptDoc && ptDoc.cerrado;
            // Los envases (referencia+descripcion del catalogo, sin SSCC por
            // naturaleza) se distinguen porque sus lineas llevan "ref": ese
            // contenido siempre se muestra, aunque la recogida sea parcial,
            // porque no hay un SSCC individual que perder al no cerrarse del
            // todo (es la misma cantidad pedida, no unidades sueltas).
            const esEnvase = lineas.length && lineas[0].ref !== undefined;
            const detalleLineas = !lineas.length
              ? "<span style='color:#999'>sin detalle</span>"
              : esEnvase
              ? lineas.map(l => esc(l.desc || l.ref || "") + " x" + l.cantidad).join("<br>")
              : (cerradoDelTodo
                ? lineas.map(l => esc(l.descripcion || "") + (l.sscc ? " <span style='color:#999'>(" + esc(l.sscc) + ")</span>" : "")).join("<br>")
                : "<span style='color:#999'>recogida parcial, sin SSCC concretos</span>");
            return "<tr>" +
              "<td style='" + TD + "'>" + (NOMBRE_ALMACEN[r.almacen] || r.almacen) + "</td>" +
              "<td style='" + TD + "'>" + esc(item.pt) + "</td>" +
              "<td style='" + TD + "'>" + (item.palets || 0) + "</td>" +
              "<td style='" + TD + "'>" + detalleLineas + "</td>" +
              "</tr>";
          })).join("");

          recogidasHoyHtml =
            "<div style='height:10px'></div>" +
            "<div style='" + CARD + ";padding:14px'>" +
            "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Palets recogidos hoy en almacenes externos</div>" +
            "<table width='100%' cellpadding='0' cellspacing='0'>" + resumenRows + "</table>" +
            "<div style='height:12px'></div>" +
            "<table width='100%' cellpadding='0' cellspacing='0'>" +
            "<tr style='background:#f5f5f5'>" +
            "<th style='" + TH + "'>Almacen</th><th style='" + TH + "'>Pedido</th>" +
            "<th style='" + TH + "'>Palets</th><th style='" + TH + "'>Contenido</th></tr>" +
            detalleRows + "</table></div>";
        }
      } catch (e) {
        console.error("generarYEnviarInforme: recogidas:", e.message);
      }

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

        recogidasHoyHtml +

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

// Robin saluda cuando un chofer se registra por primera vez ese dia (se crea
// el documento en lanzaderas_chofer) y se despide cuando termina su jornada
// (liberarChoferAlSalir, justo arriba, borra ese mismo documento). Funcion
// aparte y puramente aditiva: solo escribe un mensaje de chat, nunca toca el
// estado de la lanzadera ni nada mas.
// Segun la hora real en Madrid, para que un cambio de turno de tarde no
// salude con un "buenos dias" que no toca.
function saludoSegunHora() {
  const local = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }); // "YYYY-MM-DD HH:MM:SS"
  const hora = Number(local.split(" ")[1].split(":")[0]);
  if (hora >= 6 && hora < 14) return "Buenos días";
  if (hora >= 14 && hora < 21) return "Buenas tardes";
  return "Buenas noches";
}

// Robin se presenta ("Soy Robin, el asistente de Aldelis") solo el dia en
// que se estrena; a partir del dia siguiente, saludo normal sin repetir
// quien es cada vez que un chofer se conecta.
const FECHA_PRESENTACION_ROBIN = "2026-09-21";
function esFechaPresentacionRobin() {
  const hoy = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).split(" ")[0];
  return hoy === FECHA_PRESENTACION_ROBIN;
}

// Robin solo saluda o se despide si el propio chofer lo hace primero en el
// chat - no lo hace ya por iniciativa propia ni al conectarse ni al cerrar
// la jornada (antes se despedia automaticamente al borrarse el documento de
// lanzaderas_chofer, incluso si el chofer simplemente cerraba sin decir
// nada). Maximo un saludo y una despedida por lanzadera y dia.
// Solo cuenta como saludo/despedida si el mensaje ES basicamente eso (un
// saludo general), no si va dirigido a otra persona ("hola Manolo") o lleva
// mas texto detras - eso ya no es un saludo a Robin, es una conversacion
// normal que empieza con esa palabra.
function normalizarTextoChat(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quita acentos (día -> dia)
    .replace(/[^a-z\s]/g, "") // quita signos de puntuacion, emoji, numeros...
    .replace(/\s+/g, " ")
    .trim();
}
const SALUDOS_GENERALES = ["buenos dias", "buenas tardes", "buenas noches", "buenas", "hola"];
const DESPEDIDAS_GENERALES = ["adios", "hasta luego", "hasta manana", "nos vemos", "me voy", "chao", "chau"];

async function nombreChoferActual(numero) {
  const choferDoc = await db.collection("lanzaderas_chofer").doc(String(numero)).get();
  return choferDoc.exists ? (choferDoc.data().nombre || "").trim().split(" ")[0] : "";
}

exports.robinRespondeSaludoChofer = onDocumentCreated("mensajes/{msgId}", async (event) => {
  const msg = event.data ? event.data.data() : null;
  if (!msg || msg.de !== "lanzadera" || !msg.texto) return;
  const numero = Number(msg.lanzadera);
  if (!(numero >= 1 && numero <= 4)) return;
  if (!SALUDOS_GENERALES.includes(normalizarTextoChat(msg.texto))) return;

  const hoy = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).split(" ")[0];
  const ref = db.collection("robin_saludos_chofer").doc(String(numero));
  try {
    const doc = await ref.get();
    if (doc.exists && doc.data().fecha === hoy) return; // ya saludado hoy en esta lanzadera

    const nombre = await nombreChoferActual(numero);
    const saludo = saludoSegunHora();
    const texto = (nombre ? "¡" + saludo + ", " + nombre + "! " : "¡" + saludo + "! ") +
      (esFechaPresentacionRobin() ? "Soy Robin, el asistente de Aldelis. Que tengas un buen turno 🚚" : "Que tengas un buen turno 🚚");

    await db.collection("mensajes").add({
      lanzadera: numero, de: "almacen", emisor: "Robin (IA Muelles)", texto,
      ts: admin.firestore.Timestamp.now()
    });
    await ref.set({ fecha: hoy, actualizado: admin.firestore.Timestamp.now() });
  } catch (e) { console.error("robinRespondeSaludoChofer:", e.message); }
});

exports.robinRespondeDespedidaChofer = onDocumentCreated("mensajes/{msgId}", async (event) => {
  const msg = event.data ? event.data.data() : null;
  if (!msg || msg.de !== "lanzadera" || !msg.texto) return;
  const numero = Number(msg.lanzadera);
  if (!(numero >= 1 && numero <= 4)) return;
  if (!DESPEDIDAS_GENERALES.includes(normalizarTextoChat(msg.texto))) return;

  const hoy = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).split(" ")[0];
  const ref = db.collection("robin_despedidas_chofer").doc(String(numero));
  try {
    const doc = await ref.get();
    if (doc.exists && doc.data().fecha === hoy) return; // ya despedido hoy en esta lanzadera

    const nombre = await nombreChoferActual(numero);
    const texto = (nombre ? "¡Hasta la próxima, " + nombre + "! " : "¡Hasta la próxima! ") + saludoSegunHora() + " 👋";

    await db.collection("mensajes").add({
      lanzadera: numero, de: "almacen", emisor: "Robin (IA Muelles)", texto,
      ts: admin.firestore.Timestamp.now()
    });
    await ref.set({ fecha: hoy, actualizado: admin.firestore.Timestamp.now() });
  } catch (e) { console.error("robinRespondeDespedidaChofer:", e.message); }
});

// Robin pregunta por el chat cuando una lanzadera lleva mucho rato parada en
// un muelle (45 min, luego cada 45 min mas si sigue sin moverse: 45, 90,
// 135...). El segundo aviso en adelante es mas insistente. El motivo que da
// depende de la nave: en Avitrans/Caserfri/Txt (si hay algo pendiente de
// recoger), en Merca/Arento (esperando producto) o en Plaza (bajar cosas a
// Merca); en el resto de naves pregunta sin dar un motivo concreto.
const NAVES_CON_PENDIENTE_RECOGIDA = ["avitrans", "caserfri", "txt"];
const NAVES_PRODUCTO_PEDIDOS = ["merca", "arento"];
const NOMBRE_NAVE_TEXTO = {
  plaza: "Plaza", caserfri: "Caserfri", merca: "Merca", arento: "Arento",
  avitrans: "Avitrans", txt: "Txt", upasa: "Upasa", sabeco: "Sabeco"
};

async function mensajeLanzaderaParada(numero, nave, elapsedMin, autoritario) {
  const nombreNave = NOMBRE_NAVE_TEXTO[nave] || nave;
  const tiempo = formatDur(elapsedMin);
  let motivo = "";

  if (NAVES_CON_PENDIENTE_RECOGIDA.includes(nave)) {
    try {
      const doc = await db.collection("almacenes_pendientes").doc(nave).get();
      const d = doc.exists ? doc.data() : {};
      const pendiente = Math.max((d.pedido || 0) - (d.recogido || 0), 0);
      if (pendiente > 0) {
        motivo = autoritario
          ? " Seguimos con " + pendiente + " palets pendientes de recoger en " + nombreNave + ", hace falta agilizar."
          : " Todavía tenemos pendiente de recoger " + pendiente + " palets en " + nombreNave + ".";
      }
    } catch (e) { console.error("mensajeLanzaderaParada: pendientes:", e.message); }
  } else if (NAVES_PRODUCTO_PEDIDOS.includes(nave)) {
    motivo = autoritario
      ? " Necesitamos que baje el producto cuanto antes, se están retrasando los pedidos."
      : " Estamos esperando producto para los pedidos.";
  } else if (nave === "plaza") {
    motivo = autoritario
      ? " Hace falta bajar el material a Merca cuanto antes."
      : " Hay que bajar cosas a Merca.";
  }

  if (!autoritario) {
    return "¿Cómo va este camión? Lleva " + tiempo + " en " + nombreNave + "." + motivo;
  }
  return "Lanzadera " + numero + ": lleva ya " + tiempo + " parada en " + nombreNave + "." + motivo + " Por favor, dadme una actualización.";
}

exports.revisarLanzaderasParadas = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Madrid" },
  async () => {
    for (let numero = 1; numero <= 4; numero++) {
      try {
        const doc = await db.collection("lanzaderas").doc(String(numero)).get();
        if (!doc.exists) continue;
        const d = doc.data();
        if (!d.activa || d.estado !== "en_nave" || !d.nave || !d.desde) continue;

        const elapsedMin = (Date.now() - d.desde.toMillis()) / 60000;
        const nivel = Math.floor(elapsedMin / 45);
        if (nivel < 1) continue;

        const avisoRef = db.collection("lanzaderas_avisos_parada").doc(String(numero));
        const avisoDoc = await avisoRef.get();
        const aviso = avisoDoc.exists ? avisoDoc.data() : null;
        const mismaParada = !!(aviso && aviso.desde && aviso.desde.isEqual(d.desde));
        const nivelAvisado = mismaParada ? (aviso.nivel || 0) : 0;
        if (nivel <= nivelAvisado) continue;

        const texto = await mensajeLanzaderaParada(numero, d.nave, elapsedMin, nivel >= 2);
        await db.collection("mensajes").add({
          lanzadera: numero, de: "almacen", emisor: "Robin (IA Muelles)", texto,
          ts: admin.firestore.Timestamp.now()
        });
        await avisoRef.set({ desde: d.desde, nivel, actualizado: admin.firestore.Timestamp.now() });
        console.log("revisarLanzaderasParadas: lanzadera", numero, "nivel", nivel, "(" + Math.round(elapsedMin) + " min en " + d.nave + ") - mensaje enviado.");
      } catch (e) { console.error("revisarLanzaderasParadas: lanzadera", numero, e.message); }
    }
  }
);

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

// "YYYY-MM-DD" de hoy en la zona horaria de la empresa, para poder comparar
// fechas como texto (ordenan igual que cronologicamente).
function fechaHoyMadrid() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

// Un pedido con fecha futura (p.ej. metido hoy pero para recoger manana) no
// debe sumar todavia al pendiente de hoy: se guarda con activado=false y lo
// activa activarPedidosProgramados() en cuanto llega su fecha.
exports.sumarPedidoTransferencia = onDocumentCreated("pedidos_transferencia/{id}", async (event) => {
  const d = event.data ? event.data.data() : null;
  if (!d || !ALMACENES_PT.includes(d.almacen) || !d.activado) return;
  await db.collection("almacenes_pendientes").doc(d.almacen).set({
    pedido: admin.firestore.FieldValue.increment(d.palets || 0)
  }, { merge: true });
});

// Cada dia activa los pedidos cuya fecha ya ha llegado (los de fecha futura
// se quedan esperando). Corre varias veces al dia por si se entra un pedido
// "para hoy" pasada la primera pasada del dia.
exports.activarPedidosProgramados = onSchedule(
  { schedule: "every 60 minutes", timeZone: "Europe/Madrid" },
  async () => {
    const hoy = fechaHoyMadrid();
    let snap;
    try {
      snap = await db.collection("pedidos_transferencia")
        .where("activado", "==", false).where("fecha", "<=", hoy).get();
    } catch (e) { console.error("activarPedidosProgramados: consulta:", e.message); return; }

    for (const doc of snap.docs) {
      const d = doc.data();
      if (!ALMACENES_PT.includes(d.almacen)) continue;
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists || fresh.data().activado) return;
          tx.update(doc.ref, { activado: true });
          tx.set(db.collection("almacenes_pendientes").doc(d.almacen), {
            pedido: admin.firestore.FieldValue.increment(d.palets || 0)
          }, { merge: true });
        });
      } catch (e) { console.error("activarPedidosProgramados: activar:", doc.id, e.message); }
    }
  }
);

exports.restarRecogidaPalets = onDocumentCreated("recogidas_palets/{id}", async (event) => {
  const d = event.data ? event.data.data() : null;
  if (!d || !ALMACENES_PT.includes(d.almacen)) return;

  // Los palets "sin pedido asociado" (campo Otros) no corresponden a ningun
  // pedido nuestro, asi que NO deben restar del pendiente por pedidos: solo
  // cuenta lo que el chofer marca contra un PT concreto. Si no, el pendiente
  // del almacen bajaria sin que ningun pedido real avance.
  const totalPts = (Array.isArray(d.pts) ? d.pts : [])
    .reduce((s, item) => s + (item && item.palets > 0 ? item.palets : 0), 0);
  if (totalPts > 0) {
    await db.collection("almacenes_pendientes").doc(d.almacen).set({
      recogido: admin.firestore.FieldValue.increment(totalPts)
    }, { merge: true });
  }

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

const BUZON_PEDIDOS = MS_SENDER; // mismo buzon que ya usa el envio de correos (reservas@aldelis.com)

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
  const res = await fetch("https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msgId, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ isRead: true })
  });
  if (!res.ok) console.error("graphMarcarLeido: fallo al marcar", msgId, res.status);
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

// El documento de control de transporte trae su propio campo "Origen" con
// el almacen de verdad (visto en un PDF real: "CASERFRI"), mucho mas fiable
// que adivinar por el dominio del correo. Se usa siempre que este presente.
function normalizarAlmacen(valor) {
  const v = String(valor || "").trim().toUpperCase();
  if (v === "AVITRANS") return "avitrans";
  if (v === "CASERFRI") return "caserfri";
  if (v === "TXT") return "txt";
  return null;
}

// Cada fila con SSCC es un palet. Busca la columna "SSCC" en la primera fila
// que la tenga (por si el archivo trae cabeceras u otras filas antes) y
// cuenta valores distintos en esa columna. Si tambien hay una columna
// "Origen", se toma el almacen de ahi; si hay "Referencia"/"Descripcion"/
// "Producto", se guarda como descripcion de cada palet.
function contarPaletsExcel(buffer) {
  const XLSX = require("xlsx-js-style");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const NOMBRES_DESCRIPCION = ["DESCRIPCION", "REFERENCIA", "PRODUCTO"];
  let colSscc = -1, colOrigen = -1, colDesc = -1, inicio = 0;
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i] || [];
    const idxSscc = fila.findIndex(c => String(c || "").toUpperCase().trim() === "SSCC");
    const idxOrigen = fila.findIndex(c => String(c || "").toUpperCase().trim() === "ORIGEN");
    const idxDesc = fila.findIndex(c => NOMBRES_DESCRIPCION.includes(String(c || "").toUpperCase().trim()));
    if (idxOrigen !== -1) colOrigen = idxOrigen;
    if (idxDesc !== -1) colDesc = idxDesc;
    if (idxSscc !== -1) { colSscc = idxSscc; inicio = i + 1; break; }
  }
  if (colSscc === -1) return { palets: 0, lineas: [] };
  const porSscc = new Map();
  let almacenDetectado = null;
  for (let i = inicio; i < filas.length; i++) {
    const fila = filas[i] || [];
    const v = fila[colSscc];
    if (v) {
      // Si la columna esta formateada como numero en vez de texto, Excel
      // puede añadir un ".0" al final; se quita para que coincida con el
      // SSCC de texto tal cual llega en el correo de verificacion.
      const sscc = String(v).trim().replace(/\.0+$/, "");
      if (!porSscc.has(sscc)) {
        porSscc.set(sscc, colDesc !== -1 && fila[colDesc] ? String(fila[colDesc]).trim() : "");
      }
    }
    if (!almacenDetectado && colOrigen !== -1 && fila[colOrigen]) {
      almacenDetectado = normalizarAlmacen(fila[colOrigen]);
    }
  }
  const lineas = [...porSscc].map(([sscc, descripcion]) => ({ sscc, descripcion }));
  return { palets: lineas.length, lineas, almacenDetectado };
}

// El PDF no trae columnas fiables al extraer el texto, pero el SSCC son
// siempre 18 digitos seguidos: contar esos patrones (sin repetir) da el
// numero de palets sin depender del formato exacto de la plantilla. El
// texto SI conserva el orden visual de la cabecera "Origen ... " seguida de
// la fila de datos, asi que el almacen se saca de ahi.
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
  const origenMatch = texto.match(/Origen\b[^\n]*\n([A-ZÁÉÍÓÚÑ]+)\b/);

  // Cada fila de producto trae "Descripcion Lote Peso KG Cajas SSCC
  // Caducidad": se recorta el texto para no empezar antes de la cabecera de
  // esa tabla, y para cada SSCC se toma el texto anterior (hasta el peso en
  // KG), quitando el ultimo trozo (el Lote) para quedarse solo con el
  // producto. En filas donde el texto se corta por salto de linea puede
  // quedar algo de mas al final: es un mejor esfuerzo, no perfecto.
  const descPorSscc = new Map();
  const cabecera = texto.match(/Producto\s+Lote\s+Peso[\s\S]*?Caducidad/);
  const cuerpo = cabecera ? texto.slice(cabecera.index + cabecera[0].length) : texto;
  const filaRe = /([\s\S]+?)\s+[\d.,]+\s*KG\s+\d+\s+(\d{18})\s+\d{2}\/\d{2}\/\d{4}/g;
  let fm;
  while ((fm = filaRe.exec(cuerpo))) {
    const partes = fm[1].replace(/\s+/g, " ").trim().split(" ");
    partes.pop(); // el lote
    if (!descPorSscc.has(fm[2])) descPorSscc.set(fm[2], partes.join(" "));
  }

  return {
    palets: ssccs.length,
    lineas: ssccs.map(sscc => ({ sscc, descripcion: descPorSscc.get(sscc) || "" })),
    pt: ptMatch ? ptMatch[0] : null,
    almacenDetectado: origenMatch ? normalizarAlmacen(origenMatch[1]) : null
  };
}

async function crearPedidoTransferencia(pt, almacen, resultado, origen, fecha) {
  if (!resultado.palets) {
    // Si esto pasa, el documento adjunto no se pudo leer (formato distinto al
    // esperado, columna SSCC no encontrada, etc.): antes se descartaba en
    // silencio y el correo se marcaba como leido igualmente, asi que el
    // pedido desaparecia sin dejar rastro. Ahora al menos queda constancia en
    // los logs para poder revisarlo a mano.
    console.warn("crearPedidoTransferencia: 0 palets detectados, PT descartado sin crear:", pt, almacen, origen);
    return;
  }
  const hoy = fechaHoyMadrid();
  const fechaFinal = (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) ? fecha : hoy;
  const ref = db.collection("pedidos_transferencia").doc(pt);
  try {
    await ref.create({
      almacen, palets: resultado.palets, recogido: 0, cerrado: false,
      lineas: resultado.lineas || [], origen,
      fecha: fechaFinal, activado: fechaFinal <= hoy,
      creado: admin.firestore.Timestamp.now()
    });
    console.log("crearPedidoTransferencia: creado", pt, almacen, resultado.palets, "palets, fecha", fechaFinal, "origen", origen);
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
  const fecha = data.fecha;
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

  // El "Origen" del propio documento manda sobre el almacen elegido a mano
  // en el boton: es un dato real del pedido, no una suposicion.
  const almacenFinal = resultado.almacenDetectado || almacen;

  try {
    await crearPedidoTransferencia(pt, almacenFinal, resultado, "manual", fecha);
  } catch (e) {
    console.error("procesarPedidoTransferencia: guardar:", e.message);
    return { ok: false, error: "No se pudo guardar el pedido" };
  }

  return { ok: true, pt, palets: resultado.palets, almacen: almacenFinal, detectado: !!resultado.almacenDetectado };
});

// Pedidos de envases (IFCO, europool, logifruit, palet, chep...) que llegan
// solo por correo, con la tabla en el propio cuerpo del mensaje y sin ningun
// archivo adjunto que se pueda procesar. Se registran a mano desde el panel:
// el europool va remontado (dos unidades por hueco de camion), el resto
// cuenta 1 a 1. Se guarda como un pedido_transferencia mas, con un codigo
// sintetico, para que sume igual en almacenes_pendientes y el chofer pueda
// marcarlo como cualquier otro PT al recogerlo.
exports.registrarPedidoEnvases = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccion(email, "lanzaderas"))) return { ok: false, error: "Sin permiso" };

  if (!data || typeof data !== "object") return { ok: false, error: "Faltan datos" };
  const almacen = data.almacen;
  const normal = Number(data.normal) || 0;
  const europool = Number(data.europool) || 0;
  if (!ALMACENES_PT.includes(almacen)) return { ok: false, error: "Almacen no valido" };
  if (normal < 0 || europool < 0) return { ok: false, error: "Cantidad no valida" };

  const total = normal + Math.ceil(europool / 2);
  if (!total) return { ok: false, error: "Pon al menos una cantidad" };

  const pt = "ENV-" + Date.now().toString(36).toUpperCase();
  try {
    await crearPedidoTransferencia(pt, almacen, { palets: total, lineas: [] }, "manual-envases", data.fecha);
  } catch (e) {
    console.error("registrarPedidoEnvases: guardar:", e.message);
    return { ok: false, error: "No se pudo guardar el pedido" };
  }

  return { ok: true, pt, palets: total };
});

// Version detallada del pedido de envases, de momento restringida al admin:
// en vez de dos totales sueltos (normal/europool), se manda el desglose por
// referencia exacto (mismo catalogo que se pide siempre a Avitrans por
// correo), y ademas de guardar el pedido, se manda el correo de verdad a
// almacen@avitrans.com con la tabla y el numero de pedido - antes esto se
// escribia a mano cada vez.
const CATALOGO_ENVASES_AVITRANS = {
  "999979": { desc: "IFCO 6420",       tipo: "normal" },
  "999957": { desc: "IFCO 6413",       tipo: "normal" },
  "999908": { desc: "IFCO 6418",       tipo: "normal" },
  "999905": { desc: "IFCO 4314",       tipo: "normal" },
  "999952": { desc: "EUROPOOL 156",    tipo: "europool" },
  "999981": { desc: "EUROPOOL 154",    tipo: "europool" },
  "999989": { desc: "EUROPOOL 106",    tipo: "europool" },
  "999913": { desc: "EUROPOOL 216",    tipo: "europool" },
  "999907": { desc: "EUROPOOL 104",    tipo: "europool" },
  "999948": { desc: "LOGIFRUIT 612",   tipo: "normal" },
  "999951": { desc: "LOGIFRUIT 618",   tipo: "normal" },
  "999978": { desc: "PALET LOGIFRUIT", tipo: "normal" },
  "999988": { desc: "PALET LPR ROJO",  tipo: "normal" },
  "999932": { desc: "CHEP PLASTICO",   tipo: "normal" }
};

// Cada linea de envases se guarda tambien aqui (turno, si fue "sin pedido",
// etc.), aparte de en pedidos_transferencia, para poder aprender el patron
// de cada dia de la semana y, mas adelante, sugerir/enviar un pedido
// estimado si un turno se queda sin mandar a la hora habitual. Ver
// revisarEnvasesTurno mas abajo.
function formatoFechaEs(fechaStr) {
  return fechaStr.slice(8, 10) + "/" + fechaStr.slice(5, 7) + "/" + fechaStr.slice(0, 4);
}

// fecha (opcional, "YYYY-MM-DD"): si se pasa, añade el saludo "Buenos días,
// paso pedido de envases para recogida el DD/MM/AAAA" y la despedida con
// firma. Sin fecha, se queda solo con la tabla (compatibilidad con quien no
// la pase).
function htmlPedidoEnvases(pt, filas, etiquetaExtra, fecha) {
  const filasHtml = filas.map(f =>
    "<tr><td style='padding:5px 10px;border-bottom:1px solid #eee'>" + esc(f.ref) + "</td>" +
    "<td style='padding:5px 10px;border-bottom:1px solid #eee'>" + esc(f.desc) + "</td>" +
    "<td style='padding:5px 10px;border-bottom:1px solid #eee;text-align:center'>" + f.cantidad + "</td></tr>"
  ).join("");
  const saludo = fecha
    ? "<p>Buenos días,</p><p>Paso pedido de envases para recogida el " + esc(formatoFechaEs(fecha)) + ":</p>"
    : "";
  const despedida = fecha ? "<p>Muchas gracias.</p><p>Robin - IA Almacén</p>" : "";
  return "<html><body style='font-family:Arial,sans-serif;font-size:13px;color:#1A1A1A'>" +
    (etiquetaExtra || "") + saludo +
    "<p>Pedido nº " + esc(pt) + "</p>" +
    "<table style='border-collapse:collapse;width:100%;max-width:480px'>" +
    "<thead><tr style='background:#F5F5F5;text-align:left'>" +
    "<th style='padding:5px 10px'>Referencia</th><th style='padding:5px 10px'>Descripcion envase</th>" +
    "<th style='padding:5px 10px'>Cantidad</th></tr></thead>" +
    "<tbody>" + filasHtml + "</tbody></table>" +
    despedida +
    "</body></html>";
}

// Version en texto plano del mismo saludo/despedida, para el cuerpo
// alternativo del correo (por si el cliente de correo no muestra el HTML).
function textoPedidoEnvases(pt, filas, fecha, prefijo) {
  const cabecera = (prefijo || "") + "Buenos días,\nPaso pedido de envases para recogida el " +
    formatoFechaEs(fecha) + ":\n\nPedido nº " + pt + "\n\n";
  const cuerpo = filas.map(f => f.ref + " - " + f.desc + ": " + f.cantidad).join("\n");
  return cabecera + cuerpo + "\n\nMuchas gracias.\nRobin - IA Almacén";
}

// Destinatarios del correo de recogida segun el almacen elegido en el
// formulario. Avitrans tiene ademas el flujo de turnos/estimacion automatica
// (ver mas abajo); Txt es solo un pedido puntual manual, sin ese seguimiento.
// mlorente va siempre en copia (como destinatario aparte) en los dos casos,
// para poder verificar que el pedido se ha mandado de verdad.
const ENVASES_DESTINATARIOS = {
  avitrans: ["almacen@avitrans.com", "mlorente@aldelis.com"],
  txt: ["mariola.arcos@txt.es", "almacenplaza.logistica@txt.es", "mlorente@aldelis.com"]
};

exports.registrarPedidoEnvasesAvitrans = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };

  const almacen = (data && data.almacen) === "txt" ? "txt" : "avitrans";

  const fecha = data && String(data.fecha || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { ok: false, error: "Fecha no valida" };

  // El turno (y el "sin pedido") solo existen para el flujo de dos envios al
  // dia de Avitrans; un pedido a Txt es puntual y no lleva ese seguimiento.
  let turno = null;
  if (almacen === "avitrans") {
    turno = data && data.turno;
    if (!["noche", "dia"].includes(turno)) return { ok: false, error: "Falta el turno (noche o dia)" };
  }
  const sinPedido = almacen === "avitrans" && !!(data && data.sinPedido);

  // "Sin pedido": deja constancia de que hoy no hacia falta pedir nada para
  // este turno, sin crear ningun pedido ni mandar correo a Avitrans - pero
  // asi el envio automatico de mas abajo sabe que ya se decidio a mano y no
  // tiene que inventarse una estimacion.
  if (sinPedido) {
    try {
      await db.collection("envases_avitrans_turnos").add({
        fecha, turno, sinPedido: true, lineas: [], total: 0, origen: "manual", pt: null,
        fechaEnvio: fechaHoyMadrid(), creado: admin.firestore.Timestamp.now()
      });
    } catch (e) {
      console.error("registrarPedidoEnvasesAvitrans: guardar sin pedido:", e.message);
      return { ok: false, error: "No se pudo guardar" };
    }
    return { ok: true, sinPedido: true };
  }

  const lineasEntrada = Array.isArray(data && data.lineas) ? data.lineas : [];
  const filas = [];
  let normal = 0, europool = 0;
  for (const l of lineasEntrada) {
    const ref = l && String(l.ref || "");
    const cantidad = Number(l && l.cantidad) || 0;
    const cat = CATALOGO_ENVASES_AVITRANS[ref];
    if (!cat || cantidad <= 0) continue;
    filas.push({ ref, desc: cat.desc, cantidad });
    if (cat.tipo === "europool") europool += cantidad; else normal += cantidad;
  }
  if (!filas.length) return { ok: false, error: "Pon al menos una cantidad (o marca \"sin pedido\")" };

  const total = normal + Math.ceil(europool / 2);
  const pt = "ENV-" + Date.now().toString(36).toUpperCase();
  try {
    await crearPedidoTransferencia(pt, almacen, { palets: total, lineas: filas }, "manual-envases", fecha);
  } catch (e) {
    console.error("registrarPedidoEnvasesAvitrans: guardar:", e.message);
    return { ok: false, error: "No se pudo guardar el pedido" };
  }

  // El historico de aprendizaje/estimacion automatica es solo de Avitrans.
  if (almacen === "avitrans") {
    try {
      await db.collection("envases_avitrans_turnos").add({
        fecha, turno, sinPedido: false, lineas: filas, total, origen: "manual", pt,
        fechaEnvio: fechaHoyMadrid(), creado: admin.firestore.Timestamp.now()
      });
    } catch (e) { console.error("registrarPedidoEnvasesAvitrans: guardar historico:", e.message); }
  }

  // El correo es informativo para el almacen: si fallara, el pedido ya se ha
  // guardado igualmente (lo importante es que cuente en los pendientes), asi
  // que no se hace fallar la peticion completa por un problema de envio.
  try {
    const html = htmlPedidoEnvases(pt, filas, null, fecha);
    const cuerpo = textoPedidoEnvases(pt, filas, fecha);
    const token = await obtenerTokenMS();
    const asunto = "Recogida " + formatoFechaEs(fecha);
    // Un solo correo con todos los destinatarios reales en el "Para" (antes
    // se mandaba una copia aparte a cada uno, y ninguno veia a los demas).
    await enviarConGraph(token, ENVASES_DESTINATARIOS[almacen], asunto, html, cuerpo, null);
  } catch (e) {
    console.error("registrarPedidoEnvasesAvitrans: envio de correo:", e.message);
  }

  return { ok: true, pt, palets: total };
});

// Que dia de la semana (0=domingo...6=sabado) es una fecha "YYYY-MM-DD",
// tratandola como fecha de calendario en Madrid (mediodia UTC evita
// cualquier lio de borde de dia).
function diaSemanaDeFecha(fechaStr) {
  return new Date(fechaStr + "T12:00:00Z").getUTCDay();
}

// Turno "dia": recogida mañana, salvo que hoy sea viernes, que entonces es
// el lunes (se salta el fin de semana). Turno "noche": siempre hoy.
function fechaRecogidaTurno(turno, hoy) {
  if (turno === "noche") return hoy;
  return diaSemanaDeFecha(hoy) === 5 ? sumarDiasFecha(hoy, 3) : sumarDiasFecha(hoy, 1);
}

// Media de los ultimos envios manuales (no "sin pedido") del mismo turno Y
// del mismo dia de la semana que hoy - un viernes se compara con viernes
// anteriores, no con el resto de dias, porque el patron es distinto. Con una
// sola semana de historico (1 muestra) ya da una estimacion; sin ninguna,
// no se inventa nada.
async function estimarPedidoEnvasesTurno(turno, hoy) {
  const diaSemanaHoy = diaSemanaDeFecha(hoy);
  const desde = sumarDiasFecha(hoy, -60); // dos meses de historico, de sobra
  let snap;
  try {
    snap = await db.collection("envases_avitrans_turnos")
      .where("turno", "==", turno).where("fechaEnvio", ">=", desde).get();
  } catch (e) { console.error("estimarPedidoEnvasesTurno: consulta:", e.message); return null; }

  const muestras = [];
  snap.forEach(doc => {
    const d = doc.data();
    if (d.origen !== "manual" || d.sinPedido) return;
    if (diaSemanaDeFecha(d.fechaEnvio) !== diaSemanaHoy) return;
    muestras.push(d);
  });
  if (!muestras.length) return null;

  const sumaPorRef = {};
  muestras.forEach(m => {
    (m.lineas || []).forEach(l => { sumaPorRef[l.ref] = (sumaPorRef[l.ref] || 0) + (l.cantidad || 0); });
  });
  const filas = Object.keys(sumaPorRef).map(ref => {
    const cat = CATALOGO_ENVASES_AVITRANS[ref];
    const media = Math.round(sumaPorRef[ref] / muestras.length);
    return media > 0 ? { ref, desc: cat ? cat.desc : ref, cantidad: media } : null;
  }).filter(Boolean);
  if (!filas.length) return null;

  let normal = 0, europool = 0;
  filas.forEach(f => {
    const cat = CATALOGO_ENVASES_AVITRANS[f.ref];
    if (cat && cat.tipo === "europool") europool += f.cantidad; else normal += f.cantidad;
  });
  return { filas, total: normal + Math.ceil(europool / 2), muestras: muestras.length };
}

// EN PRUEBA: el correo del pedido estimado va solo al admin (nunca a
// Avitrans todavia), y no crea ningun pedido_transferencia real - es puramente
// informativo, para poder afinar el formato y la logica antes de activarlo
// de verdad. Cuando el admin lo confirme, cambiar DESTINATARIO_PRUEBA por
// "almacen@avitrans.com" y descomentar la creacion del pedido real.
const ENVASES_DESTINATARIO_PRUEBA = "mlorente@aldelis.com";

// Destinatarios reales del pedido de envases por stock minimo (correo
// procesado y automatico diario): el propio Avitrans mas mlorente/hmanero en
// copia. DE MOMENTO restringido solo a mlorente mientras se verifica que
// todo funciona bien (mlorente lo reenvia a mano a Avitrans tras revisarlo).
// Cuando se confirme, descomentar la lista completa de abajo.
const ENVASES_STOCK_MINIMO_DESTINATARIOS = ["mlorente@aldelis.com"];
// const ENVASES_STOCK_MINIMO_DESTINATARIOS = ["almacen@avitrans.com", "mlorente@aldelis.com", "hmanero@aldelis.com"];

// false: los dos flujos de stock minimo crean el pedido real (sube a
// pendientes) y mandan el correo a ENVASES_STOCK_MINIMO_DESTINATARIOS de
// arriba (hoy restringido a mlorente, ver comentario de arriba). true: no
// crean ningun pedido, solo calculan y avisan a ENVASES_DESTINATARIO_PRUEBA
// con aviso de que es prueba.
const ENVASES_STOCK_MINIMO_MODO_PRUEBA = false;

// forzar=true (boton "probar ahora" del panel) se salta la comprobacion de
// "ya enviado hoy", para poder ver el correo de prueba sin esperar a la
// hora de corte ni a que no haya pedido de hoy todavia.
async function revisarEnvasesTurno(turno, forzar) {
  const hoy = fechaHoyMadrid();

  if (!forzar) {
    let yaEnviado;
    try {
      yaEnviado = await db.collection("envases_avitrans_turnos")
        .where("fechaEnvio", "==", hoy).where("turno", "==", turno).limit(1).get();
    } catch (e) { console.error("revisarEnvasesTurno: consulta:", e.message); return { ok: false, motivo: "error_consulta" }; }
    if (!yaEnviado.empty) {
      console.log("revisarEnvasesTurno: turno", turno, "ya tiene envio manual hoy, no se hace nada.");
      return { ok: false, motivo: "ya_enviado_hoy" };
    }
  }

  const estimado = await estimarPedidoEnvasesTurno(turno, hoy);
  if (!estimado) {
    console.log("revisarEnvasesTurno: turno", turno, "sin historico todavia para estimar, no se manda nada.");
    return { ok: false, motivo: "sin_historico" };
  }

  const fechaRecogida = fechaRecogidaTurno(turno, hoy);
  const pt = "ENV-EST-" + Date.now().toString(36).toUpperCase();
  try {
    await db.collection("envases_avitrans_turnos").add({
      fecha: fechaRecogida, turno, sinPedido: false, lineas: estimado.filas, total: estimado.total,
      origen: "estimado_prueba", pt, fechaEnvio: hoy, creado: admin.firestore.Timestamp.now()
    });
  } catch (e) { console.error("revisarEnvasesTurno: guardar estimado:", e.message); }

  try {
    const etiqueta = "<div style='background:#FEF3C7;color:#92400E;padding:10px 14px;border-radius:6px;margin-bottom:14px'>" +
      "⚠️ ESTIMADO AUTOMÁTICO (PRUEBA) — turno " + esc(turno) + ", basado en " + estimado.muestras +
      " semana(s) anteriores del mismo día. No se ha enviado a Avitrans, es solo para revisar el formato." +
      "</div>";
    const html = htmlPedidoEnvases(pt, estimado.filas, etiqueta);
    const cuerpo = "ESTIMADO AUTOMATICO (PRUEBA) - turno " + turno + "\n\n" +
      "Pedido nº " + pt + "\n\n" + estimado.filas.map(f => f.ref + " - " + f.desc + ": " + f.cantidad).join("\n");
    const token = await obtenerTokenMS();
    await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
      "[PRUEBA] Recogida " + formatoFechaEs(fechaRecogida) + " (turno " + turno + ", estimado)", html, cuerpo, null);
    console.log("revisarEnvasesTurno: turno", turno, "estimado de prueba enviado a", ENVASES_DESTINATARIO_PRUEBA);
  } catch (e) {
    console.error("revisarEnvasesTurno: envio de correo:", e.message);
    return { ok: false, motivo: "error_envio" };
  }

  return { ok: true, pt, total: estimado.total, muestras: estimado.muestras, enviadoA: ENVASES_DESTINATARIO_PRUEBA };
}

exports.revisarEnvasesTurnoNoche = onSchedule(
  { schedule: "45 10 * * *", timeZone: "Europe/Madrid" },
  async () => { await revisarEnvasesTurno("noche"); }
);

exports.revisarEnvasesTurnoDia = onSchedule(
  { schedule: "15 11 * * *", timeZone: "Europe/Madrid" },
  async () => { await revisarEnvasesTurno("dia"); }
);

// Boton "Probar estimacion ahora" del panel: dispara la misma logica que el
// cron, pero al momento y sin importar si ya hay un envio manual hoy (es
// solo para ver el correo de prueba, no cambia el comportamiento real).
exports.probarEstimacionEnvasesTurno = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };

  const turno = data && data.turno;
  if (!["noche", "dia"].includes(turno)) return { ok: false, error: "Falta el turno (noche o dia)" };

  const resultado = await revisarEnvasesTurno(turno, true);
  if (!resultado || !resultado.ok) {
    const motivos = {
      sin_historico: "Todavia no hay historico suficiente para estimar este turno (hace falta al menos una semana igual).",
      error_consulta: "Error consultando el historico.",
      error_envio: "Se calculo la estimacion pero fallo el envio del correo."
    };
    return { ok: false, error: (resultado && motivos[resultado.motivo]) || "No se pudo generar la estimacion." };
  }
  return { ok: true, pt: resultado.pt, total: resultado.total, muestras: resultado.muestras, enviadoA: resultado.enviadoA };
});

// ── Pedido automatico de envases por stock minimo (EN PRUEBA) ──────────────
// Distinto del flujo de turnos de arriba (que estima a partir del consumo
// historico): aqui el propio admin manda una plantilla solo con el stock
// actual por referencia, y se pide la diferencia hasta el stock minimo (mas
// el incremento de ofertas) que tenga configurado esa referencia. El stock
// minimo y el incremento SOLO se configuran a mano desde el panel (coleccion
// envases_stock_minimo_config, ver firestore.rules), nunca desde la
// plantilla de Excel, para que nadie pueda manipularlos por correo. Sigue en
// fase de prueba: el correo calculado solo va al admin, no se manda a
// Avitrans ni se crea un pedido real todavia (ver ENVASES_DESTINATARIO_PRUEBA
// mas arriba).
const ENVASES_STOCK_MINIMO_ALIAS = {
  "referencia": "Referencia",
  "stockactual": "StockActual", "stock actual": "StockActual"
};

function normalizarFilaEnvasesStockMinimo(fila) {
  const out = {};
  for (const k in fila) {
    const norm = String(k).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const canon = ENVASES_STOCK_MINIMO_ALIAS[norm];
    if (canon) out[canon] = fila[k];
  }
  return out;
}

// Cuanto hay ya pedido a Avitrans y todavia pendiente de recoger, por
// referencia (para no volver a pedirlo). Cuenta cualquier pedido activo
// (cerrado=false), sea manual, automatico o de un correo anterior: si un
// pedido esta recogido solo a medias, se cuenta la cantidad ORIGINAL
// completa de cada linea igualmente, porque el sistema no distingue que
// referencias en concreto se recogieron de un pedido parcial.
async function pendientePorReferenciaAvitrans() {
  const snap = await db.collection("pedidos_transferencia")
    .where("almacen", "==", "avitrans").where("cerrado", "==", false).get();
  const pendiente = {};
  snap.forEach(d => {
    const data = d.data();
    (data.lineas || []).forEach(l => {
      if (!l || !l.ref) return;
      pendiente[l.ref] = (pendiente[l.ref] || 0) + (Number(l.cantidad) || 0);
    });
  });
  return pendiente;
}

// Estas referencias nunca se piden por ningun flujo automatico (correo ni
// automatico diario): se piden siempre a mano. La unica excepcion: si el
// correo reporta su stock actual a 0, se manda un aviso aparte (no un
// pedido) para que no se quede sin avisar.
const ENVASES_PEDIDO_SIEMPRE_MANUAL = ["999988", "999932"]; // PALET LPR ROJO, CHEP PLASTICO

// Pedido = max(Stock_minimo + Incremento - Stock_actual - Pendiente_recogida, 0)
// por referencia, redondeado hacia arriba y doblado para Europool (va
// remontado, dos unidades reales por hueco de camion), igual que en el resto
// de pedidos de envases. El stock minimo/incremento salen de Firestore
// (config de panel), nunca del propio Excel recibido por correo. Si la
// celda de Stock actual viene vacia, no se pide nada de esa referencia (para
// no adivinar), aunque tenga stock minimo configurado.
async function calcularPedidoEnvasesStockMinimoFiltrado(buffer, incluirRef) {
  const filas = leerExcelConHeaderAuto(buffer).map(normalizarFilaEnvasesStockMinimo);
  const [configSnap, pendiente] = await Promise.all([
    db.collection("envases_stock_minimo_config").get(),
    pendientePorReferenciaAvitrans()
  ]);
  const config = {};
  configSnap.forEach(d => { config[d.id] = d.data(); });

  const lineas = [];
  const avisosStockCero = [];
  let normal = 0, europool = 0;
  filas.forEach(f => {
    const ref = String(f.Referencia || "").trim();
    const cat = CATALOGO_ENVASES_AVITRANS[ref];
    if (!cat || !incluirRef(cat)) return;
    const celdaVacia = f.StockActual === null || f.StockActual === undefined || String(f.StockActual).trim() === "";
    if (ENVASES_PEDIDO_SIEMPRE_MANUAL.includes(ref)) {
      if (!celdaVacia && Number(f.StockActual) === 0) avisosStockCero.push({ ref, desc: cat.desc });
      return; // nunca se pide por aqui, siempre a mano
    }
    const cfg = config[ref];
    if (!cfg) return; // sin stock minimo configurado, no se pide nada de esta referencia
    if (celdaVacia) return; // sin stock actual no se pide nada de esta referencia, para no adivinar
    const stockMinimo = Number(cfg.stockMinimo) || 0;
    const incremento = Number(cfg.incremento) || 0;
    const stockActual = Number(f.StockActual) || 0;
    const yaPendiente = pendiente[ref] || 0;
    const necesidad = Math.ceil(Math.max(stockMinimo + incremento - stockActual - yaPendiente, 0));
    if (necesidad <= 0) return;
    // Europool: se pide el doble de la necesidad (remontado), y el total de
    // huecos de camion se calcula dividiendo esa cantidad ya doblada entre 2.
    const cantidad = cat.tipo === "europool" ? necesidad * 2 : necesidad;
    lineas.push({ ref, desc: cat.desc, cantidad });
    if (cat.tipo === "europool") europool += cantidad; else normal += cantidad;
  });
  return { lineas, total: normal + Math.ceil(europool / 2), avisosStockCero };
}

// Correo principal "Stock envases": todas las referencias salvo Logifruit
// (las cuenta otra persona y se piden a mano; se ignoran aunque vengan en el
// excel). Logifruit tiene su propio correo separado, ver mas abajo.
function calcularPedidoEnvasesPorStockMinimo(buffer) {
  return calcularPedidoEnvasesStockMinimoFiltrado(buffer, cat => !cat.desc.includes("LOGIFRUIT"));
}

// Correo separado "Stock envases logifruit": solo las 3 referencias
// Logifruit, porque las cuenta otra persona distinta y llegan en un correo
// aparte.
function calcularPedidoEnvasesLogifruitPorStockMinimo(buffer) {
  return calcularPedidoEnvasesStockMinimoFiltrado(buffer, cat => cat.desc.includes("LOGIFRUIT"));
}

exports.revisarCorreoStockMinimoEnvases = onSchedule(
  { schedule: "0 * * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoStockMinimoEnvasesInterno("revisarCorreoStockMinimoEnvases",
    "Stock envases", "envases_stock_minimo_procesados", calcularPedidoEnvasesPorStockMinimo, false)
);

// Entre las 10:00 y las 11:30 (justo antes del automatico de las 11:30) se
// revisa cada 15 min en vez de cada hora, para dar mas margen a que el
// correo real llegue a tiempo. La idempotencia por mensaje evita cualquier
// problema si coincide con la pasada horaria de arriba.
exports.revisarCorreoStockMinimoEnvasesAgil = onSchedule(
  { schedule: "*/15 10-11 * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoStockMinimoEnvasesInterno("revisarCorreoStockMinimoEnvasesAgil",
    "Stock envases", "envases_stock_minimo_procesados", calcularPedidoEnvasesPorStockMinimo, false)
);

// Correo separado con el stock de Logifruit (lo manda otra persona distinta).
exports.revisarCorreoStockMinimoLogifruitEnvases = onSchedule(
  { schedule: "0 * * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoStockMinimoEnvasesInterno("revisarCorreoStockMinimoLogifruitEnvases",
    "Stock envases logifruit", "envases_stock_minimo_logifruit_procesados", calcularPedidoEnvasesLogifruitPorStockMinimo, true)
);

exports.revisarCorreoStockMinimoLogifruitEnvasesAgil = onSchedule(
  { schedule: "*/15 10-11 * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoStockMinimoEnvasesInterno("revisarCorreoStockMinimoLogifruitEnvasesAgil",
    "Stock envases logifruit", "envases_stock_minimo_logifruit_procesados", calcularPedidoEnvasesLogifruitPorStockMinimo, true)
);

// Logica compartida entre el cron por horas y el boton "Probar ahora" del
// panel (misma idea que revisarCorreoComprasBandejasTipos).
// asunto: subject exacto del correo a buscar. coleccionProcesados: coleccion
// de idempotencia propia (para no compartirla entre el correo principal y el
// de Logifruit). calcularFn: cual de las dos funciones de calculo usar.
// esLogifruit: si es el correo de Logifruit, para que el pedido/correo
// resultante quede marcado como tal (origen, pt y asunto) y se distinga a
// simple vista del correo principal.
async function revisarCorreoStockMinimoEnvasesInterno(origen, asunto, coleccionProcesados, calcularFn, esLogifruit) {
  const token = await obtenerTokenMS();

  // Filtro simple en el servidor (solo no leidos, unica condicion - Graph
  // rechaza combinar un filtro compuesto con $orderby por "demasiado
  // complejo") y el resto (adjunto, asunto sin distinguir mayusculas) se
  // comprueba en el propio codigo. Se ordena por fecha de recepcion
  // descendente y se pide un buen numero de resultados para que el correo de
  // hoy no se quede fuera de la pagina si el buzon compartido tiene mucho
  // trafico sin leer (albaranes, ACOPAL...).
  const data = await graphGet(token,
    "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
    "/mailFolders/inbox/messages?$filter=" + encodeURIComponent("isRead eq false") +
    "&$orderby=receivedDateTime desc&$top=100&$select=id,subject,hasAttachments,receivedDateTime");

  const asuntoNorm = asunto.trim().toLowerCase();
  const todos = (data.value || []).filter(m => m.hasAttachments);
  const mensajes = todos.filter(m => (m.subject || "").trim().toLowerCase() === asuntoNorm);

  const candidatos = mensajes.length;
  console.log(origen + ": " + candidatos + " correo(s) candidato(s) de " + todos.length +
    " no leido(s) con adjunto. Asuntos vistos: " + todos.slice(0, 20).map(m => "'" + m.subject + "'").join(", "));

  let procesados = 0;
  for (const msg of mensajes) {
    if (!msg.hasAttachments) { await graphMarcarLeido(token, msg.id); continue; }

    // Idempotencia por mensaje (mismo mecanismo que compras/extraccion de
    // albaran): el "leido" de Graph no siempre persiste.
    const procesadoRef = db.collection(coleccionProcesados).doc(msg.id);
    try {
      await procesadoRef.create({ ts: admin.firestore.Timestamp.now() });
    } catch (e) {
      if (e.code === 6) continue; // ya atendido
      console.error(origen + ": guarda de idempotencia:", e.message);
      continue;
    }

    try {
      const adjuntos = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "/attachments");
      const excel = (adjuntos.value || []).find(a => a.contentBytes && /\.xlsx?$/i.test(a.name || ""));
      if (!excel) { await graphMarcarLeido(token, msg.id); continue; }

      const buffer = Buffer.from(excel.contentBytes, "base64");
      const resultado = await calcularFn(buffer);
      const fechaRecogida = fechaHoyMadrid(); // recogida hoy mismo (el automatico de las 11:30 es el de manana)
      const marca = esLogifruit ? " (Logifruit)" : "";
      const ptPrefijo = esLogifruit ? "ENV-LOGIFRUIT-" : "ENV-";
      const origenPedido = esLogifruit ? "stock-minimo-logifruit-correo" : "stock-minimo-correo";

      if (!resultado.lineas.length) {
        await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
          (ENVASES_STOCK_MINIMO_MODO_PRUEBA ? "[PRUEBA] " : "") + "Pedido envases por stock mínimo" + marca + " — sin necesidad", null,
          "No hace falta pedir nada: todas las referencias estan por encima de su stock minimo.", null);
      } else if (ENVASES_STOCK_MINIMO_MODO_PRUEBA) {
        const pt = "ENV-EST-" + Date.now().toString(36).toUpperCase();
        const etiqueta = "<div style='background:#FEF3C7;padding:10px;border-radius:6px;margin-bottom:12px'>" +
          "⚠️ PRUEBA: pedido calculado por stock minimo" + marca + ", solo informativo (no se ha mandado a Avitrans ni sumado a pendientes).</div>";
        const html = htmlPedidoEnvases(pt, resultado.lineas, etiqueta, fechaRecogida);
        const cuerpo = textoPedidoEnvases(pt, resultado.lineas, fechaRecogida, "PRUEBA" + marca + "\n\n");
        await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
          "[PRUEBA] Pedido envases por stock mínimo" + marca + " (" + resultado.total + " huecos)", html, cuerpo, null);
      } else {
        const pt = ptPrefijo + Date.now().toString(36).toUpperCase();
        await crearPedidoTransferencia(pt, "avitrans", { palets: resultado.total, lineas: resultado.lineas },
          origenPedido, fechaRecogida);
        const html = htmlPedidoEnvases(pt, resultado.lineas, null, fechaRecogida);
        const cuerpo = textoPedidoEnvases(pt, resultado.lineas, fechaRecogida, marca ? marca.trim() + "\n\n" : "");
        await enviarConGraph(token, ENVASES_STOCK_MINIMO_DESTINATARIOS,
          "Recogida " + formatoFechaEs(fechaRecogida) + marca, html, cuerpo, null);
      }
      // Referencias que siempre se piden a mano (ENVASES_PEDIDO_SIEMPRE_MANUAL):
      // si hoy se reporta su stock a 0, se avisa aparte (no es un pedido).
      if (resultado.avisosStockCero && resultado.avisosStockCero.length) {
        try {
          await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
            "Aviso: stock a 0 (pedido manual)" + marca,
            null,
            "Segun el correo de hoy, estas referencias estan a 0 de stock. Se piden siempre a mano, " +
            "asi que no se ha generado ningun pedido automatico para ellas:\n\n" +
            resultado.avisosStockCero.map(a => a.ref + " - " + a.desc).join("\n"),
            null);
        } catch (e) { console.error(origen + ": aviso stock cero:", e.message); }
      }

      await graphMarcarLeido(token, msg.id);
      procesados++;
      console.log(origen + ":", resultado.lineas.length, "referencia(s) con pedido.");
    } catch (e) {
      console.error(origen + ": mensaje", msg.id, e.message);
    }
  }
  return { candidatos, procesados, asuntosVistos: todos.slice(0, 20).map(m => m.subject || "(sin asunto)") };
}

// Boton "Probar ahora" del panel: dispara la revision al momento (no espera
// a la hora programada) y devuelve el resultado a la pantalla.
exports.probarRevisarCorreoStockMinimoEnvases = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };

  try {
    const resultado = await revisarCorreoStockMinimoEnvasesInterno("probarRevisarCorreoStockMinimoEnvases",
      "Stock envases", "envases_stock_minimo_procesados", calcularPedidoEnvasesPorStockMinimo, false);
    return { ok: true, candidatos: resultado.candidatos, procesados: resultado.procesados, asuntosVistos: resultado.asuntosVistos };
  } catch (e) {
    console.error("probarRevisarCorreoStockMinimoEnvases:", e.message);
    return { ok: false, error: e.message };
  }
});

// Boton "Probar ahora" del panel para el correo separado de Logifruit.
exports.probarRevisarCorreoStockMinimoLogifruitEnvases = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };

  try {
    const resultado = await revisarCorreoStockMinimoEnvasesInterno("probarRevisarCorreoStockMinimoLogifruitEnvases",
      "Stock envases logifruit", "envases_stock_minimo_logifruit_procesados", calcularPedidoEnvasesLogifruitPorStockMinimo, true);
    return { ok: true, candidatos: resultado.candidatos, procesados: resultado.procesados, asuntosVistos: resultado.asuntosVistos };
  } catch (e) {
    console.error("probarRevisarCorreoStockMinimoLogifruitEnvases:", e.message);
    return { ok: false, error: e.message };
  }
});

// Pedido automatico diario (EN PRUEBA): sustituye al correo manual de "Stock
// envases". Cada dia a las 11:30 se pide, de cada referencia con stock
// minimo configurado, directamente el 40% de ese stock minimo (sin mirar
// stock actual ni incremento). Si un dia hace falta pedir algo mas, se hace
// a mano desde el resto de apartados de envases.
function calcularPedidoAutomaticoStockMinimo(config) {
  const lineas = [];
  let normal = 0, europool = 0;
  for (const ref in config) {
    const cat = CATALOGO_ENVASES_AVITRANS[ref];
    if (!cat) continue;
    if (ENVASES_PEDIDO_SIEMPRE_MANUAL.includes(ref)) continue; // siempre a mano, nunca automatico
    const stockMinimo = Number(config[ref].stockMinimo) || 0;
    if (stockMinimo <= 0) continue;
    const necesidad = Math.ceil(stockMinimo * 0.4);
    if (necesidad <= 0) continue;
    // Europool: se pide el doble de la necesidad (remontado), y el total de
    // huecos de camion se calcula dividiendo esa cantidad ya doblada entre 2.
    const cantidad = cat.tipo === "europool" ? necesidad * 2 : necesidad;
    lineas.push({ ref, desc: cat.desc, cantidad });
    if (cat.tipo === "europool") europool += cantidad; else normal += cantidad;
  }
  return { lineas, total: normal + Math.ceil(europool / 2) };
}

// soloVista=true (boton "Ver pedido de hoy" del panel): calcula el pedido de
// hoy pero NO manda ningun correo, no crea el pedido real ni marca el dia
// como enviado - es solo para consultar el importe sin efectos, ahora que
// esto ya crea pedidos y correos reales de verdad.
async function ejecutarPedidoAutomaticoStockMinimoEnvases(origen, soloVista) {
  const hoy = fechaHoyMadrid();

  if (!soloVista) {
    let diaDoc;
    try { diaDoc = await db.collection("envases_stock_minimo_auto_dia").doc(hoy).get(); }
    catch (e) { console.error(origen + ": consulta dia:", e.message); return { ok: false, motivo: "error_consulta" }; }
    if (diaDoc.exists && diaDoc.data().enviado) return { ok: false, motivo: "ya_enviado_hoy" };
  }

  const configSnap = await db.collection("envases_stock_minimo_config").get();
  const config = {};
  configSnap.forEach(d => { config[d.id] = d.data(); });
  const resultado = calcularPedidoAutomaticoStockMinimo(config);
  const fechaRecogida = fechaRecogidaTurno("dia", hoy);

  if (soloVista) return { ok: true, total: resultado.total, lineas: resultado.lineas.length };

  try {
    const token = await obtenerTokenMS();
    if (!resultado.lineas.length) {
      await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
        (ENVASES_STOCK_MINIMO_MODO_PRUEBA ? "[PRUEBA] " : "") + "Pedido automático diario de envases — sin referencias configuradas", null,
        "No hay ninguna referencia con stock mínimo configurado, asi que no se ha pedido nada hoy.", null);
    } else if (ENVASES_STOCK_MINIMO_MODO_PRUEBA) {
      const pt = "ENV-EST-" + Date.now().toString(36).toUpperCase();
      const etiqueta = "<div style='background:#FEF3C7;color:#92400E;padding:10px 14px;border-radius:6px;margin-bottom:14px'>" +
        "⚠️ PRUEBA: pedido automático diario (40% del stock mínimo de cada referencia configurada). " +
        "No se ha enviado a Avitrans, es solo para revisar el formato.</div>";
      const html = htmlPedidoEnvases(pt, resultado.lineas, etiqueta, fechaRecogida);
      const cuerpo = textoPedidoEnvases(pt, resultado.lineas, fechaRecogida, "PRUEBA (automático diario)\n\n");
      await enviarConGraph(token, ENVASES_DESTINATARIO_PRUEBA,
        "[PRUEBA] Pedido automático diario de envases (" + resultado.total + " huecos)", html, cuerpo, null);
    } else {
      const pt = "ENV-" + Date.now().toString(36).toUpperCase();
      await crearPedidoTransferencia(pt, "avitrans", { palets: resultado.total, lineas: resultado.lineas },
        "stock-minimo-auto", fechaRecogida);
      const html = htmlPedidoEnvases(pt, resultado.lineas, null, fechaRecogida);
      const cuerpo = textoPedidoEnvases(pt, resultado.lineas, fechaRecogida);
      await enviarConGraph(token, ENVASES_STOCK_MINIMO_DESTINATARIOS,
        "Recogida " + formatoFechaEs(fechaRecogida), html, cuerpo, null);
    }
  } catch (e) {
    console.error(origen + ": envio de correo:", e.message);
    return { ok: false, motivo: "error_envio" };
  }

  try {
    await db.collection("envases_stock_minimo_auto_dia").doc(hoy).set(
      { enviado: true, ts: admin.firestore.Timestamp.now() }, { merge: true });
  } catch (e) { console.error(origen + ": marcar dia:", e.message); }

  return { ok: true, total: resultado.total, lineas: resultado.lineas.length };
}

exports.pedidoAutomaticoStockMinimoEnvases = onSchedule(
  { schedule: "30 11 * * *", timeZone: "Europe/Madrid" },
  () => ejecutarPedidoAutomaticoStockMinimoEnvases("pedidoAutomaticoStockMinimoEnvases", false)
);

// Boton "Ver pedido de hoy" del panel: solo calcula y muestra, no manda nada
// ni crea ningun pedido (para no duplicar el envio real de las 11:30).
exports.probarPedidoAutomaticoStockMinimoEnvases = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };

  const resultado = await ejecutarPedidoAutomaticoStockMinimoEnvases("probarPedidoAutomaticoStockMinimoEnvases", true);
  if (!resultado.ok) return { ok: false, error: "No se pudo calcular el pedido." };
  return { ok: true, total: resultado.total, lineas: resultado.lineas };
});

// A veces el chofer se olvida de marcarlo al salir: se registra a mano desde
// el panel, exactamente igual que si lo hubiera marcado el (misma coleccion
// recogidas_palets), para que el pedido y el saldo del almacen queden
// consistentes sin logica aparte.
exports.cerrarPedidoManual = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccion(email, "lanzaderas"))) return { ok: false, error: "Sin permiso" };

  if (!data || typeof data !== "object") return { ok: false, error: "Faltan datos" };
  const pt = String(data.pt || "");
  const palets = Number(data.palets);
  if (!pt) return { ok: false, error: "Falta el pedido" };
  if (!(palets > 0)) return { ok: false, error: "Cantidad no valida" };

  const ref = db.collection("pedidos_transferencia").doc(pt);
  const doc = await ref.get();
  if (!doc.exists) return { ok: false, error: "Pedido no encontrado" };
  const d = doc.data();
  if (!ALMACENES_PT.includes(d.almacen)) return { ok: false, error: "Almacen no valido" };
  const pendiente = Math.max((d.palets || 0) - (d.recogido || 0), 0);
  if (palets > pendiente) return { ok: false, error: "No puede ser mayor que lo pendiente (" + pendiente + ")" };

  try {
    await db.collection("recogidas_palets").add({
      numero: 0, almacen: d.almacen, palets, pts: [{ pt, palets }],
      manual: true, marcadoPor: email,
      ts: admin.firestore.Timestamp.now()
    });
  } catch (e) {
    console.error("cerrarPedidoManual: guardar:", e.message);
    return { ok: false, error: "No se pudo registrar" };
  }

  return { ok: true };
});

// Deshacer una recogida marcada por error (el chofer se equivoca de PT o de
// cantidad con cierta frecuencia). Revierte exactamente lo que sumo
// restarRecogidaPalets al crearse ese documento: resta lo recogido de cada
// PT afectado (reabriendo el pedido si hacia falta) y del contador del
// almacen. Solo se puede deshacer una recogida del mismo dia, para no tocar
// datos de un informe de costes ya cerrado/enviado de dias anteriores.
exports.deshacerRecogida = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccion(email, "lanzaderas"))) return { ok: false, error: "Sin permiso" };

  const id = data && String(data.id || "");
  if (!id) return { ok: false, error: "Falta el id de la recogida" };

  const ref = db.collection("recogidas_palets").doc(id);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("Esa recogida ya no existe");
      const d = snap.data();
      if (d.deshecha) throw new Error("Esa recogida ya estaba deshecha");

      const tsMs = d.ts && d.ts.toMillis ? d.ts.toMillis() : 0;
      const fechaRecogida = new Date(tsMs).toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
      if (fechaRecogida !== fechaHoyMadrid()) throw new Error("Solo se puede deshacer una recogida del mismo dia");

      const pts = (Array.isArray(d.pts) ? d.pts : []).filter(item => item && item.pt && item.palets > 0);
      const totalPts = pts.reduce((s, item) => s + item.palets, 0);

      // Todas las lecturas antes de cualquier escritura, como exige una
      // transaccion de Firestore.
      const refsPt = pts.map(item => db.collection("pedidos_transferencia").doc(item.pt));
      const docsPt = await Promise.all(refsPt.map(r => tx.get(r)));

      docsPt.forEach((docPt, i) => {
        if (!docPt.exists) return;
        const actual = docPt.data();
        const recogidoNuevo = Math.max((actual.recogido || 0) - pts[i].palets, 0);
        tx.update(docPt.ref, {
          recogido: recogidoNuevo,
          cerrado: recogidoNuevo >= (actual.palets || 0)
        });
      });

      if (totalPts > 0 && ALMACENES_PT.includes(d.almacen)) {
        tx.set(db.collection("almacenes_pendientes").doc(d.almacen), {
          recogido: admin.firestore.FieldValue.increment(-totalPts)
        }, { merge: true });
      }

      tx.update(ref, { deshecha: true, deshechaPor: email, deshechaTs: admin.firestore.Timestamp.now() });
    });
    return { ok: true };
  } catch (e) {
    console.error("deshacerRecogida:", e.message);
    return { ok: false, error: e.message };
  }
});

// Mover la fecha de un pedido ya creado (p.ej. llego antes de las 15:00 pero
// en realidad es para mañana). Si ya estaba activado (sumado al pendiente de
// hoy), se descuenta del contador al posponerlo; si la nueva fecha ya es hoy
// o pasada, se vuelve a sumar. Solo si no se ha recogido nada todavia: mover
// la fecha de un pedido a medio recoger complicaria mas que ayudaria.
exports.posponerPedido = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccion(email, "lanzaderas"))) return { ok: false, error: "Sin permiso" };

  if (!data || typeof data !== "object") return { ok: false, error: "Faltan datos" };
  const pt = String(data.pt || "");
  const nuevaFecha = String(data.fecha || "");
  if (!pt || !/^\d{4}-\d{2}-\d{2}$/.test(nuevaFecha)) return { ok: false, error: "Datos no validos" };

  const ref = db.collection("pedidos_transferencia").doc(pt);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error("Pedido no encontrado");
      const d = doc.data();
      if (!ALMACENES_PT.includes(d.almacen)) throw new Error("Almacen no valido");
      if ((d.recogido || 0) > 0) throw new Error("Ya se ha recogido algo de este pedido, no se puede posponer");

      const hoy = fechaHoyMadrid();
      const activadoAntes = !!d.activado;
      const activadoAhora = nuevaFecha <= hoy;

      tx.update(ref, { fecha: nuevaFecha, activado: activadoAhora });

      if (activadoAntes !== activadoAhora) {
        const delta = activadoAhora ? (d.palets || 0) : -(d.palets || 0);
        tx.set(db.collection("almacenes_pendientes").doc(d.almacen), {
          pedido: admin.firestore.FieldValue.increment(delta)
        }, { merge: true });
      }
    });
  } catch (e) {
    console.error("posponerPedido:", e.message);
    return { ok: false, error: e.message || "No se pudo cambiar la fecha" };
  }

  return { ok: true };
});

// TEMPORAL, para las pruebas: borra todos los pedidos y recogidas, y deja
// los saldos de los 3 almacenes a cero. Solo el admin puede llamarlo.
// Quitar esta funcion y su boton en el panel cuando se termine de probar.
exports.resetPedidosPendientes = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx  = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!ADMINS_APP.includes(email)) return { ok: false, error: "Solo el admin puede resetear" };

  for (const nombre of ["pedidos_transferencia", "recogidas_palets"]) {
    const snap = await db.collection(nombre).get();
    let batch = db.batch();
    let n = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      n++;
      if (n === 450) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n) await batch.commit();
  }

  const batchSaldos = db.batch();
  ALMACENES_PT.forEach(a => batchSaldos.set(db.collection("almacenes_pendientes").doc(a), { pedido: 0, recogido: 0 }));
  await batchSaldos.commit();

  return { ok: true };
});

// almacenes_pendientes es un contador que se va sumando/restando con cada
// pedido y cada recogida: si alguna vez queda descuadrado (p.ej. por una
// correccion a mano en la consola, como paso con el 47->25 de un almacen
// equivocado) esto lo recalcula desde cero sumando los pedidos_transferencia
// activados de verdad, sin borrar ni tocar ningun pedido. Solo el admin.
exports.recalcularAlmacenesPendientes = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx  = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!ADMINS_APP.includes(email)) return { ok: false, error: "Solo el admin puede recalcular" };

  const sumas = {};
  ALMACENES_PT.forEach(a => { sumas[a] = { pedido: 0, recogido: 0 }; });

  const snap = await db.collection("pedidos_transferencia").where("activado", "==", true).get();
  snap.forEach(doc => {
    const d = doc.data();
    if (!ALMACENES_PT.includes(d.almacen)) return;
    sumas[d.almacen].pedido   += d.palets   || 0;
    sumas[d.almacen].recogido += d.recogido || 0;
  });

  const batch = db.batch();
  ALMACENES_PT.forEach(a => batch.set(db.collection("almacenes_pendientes").doc(a), sumas[a]));
  await batch.commit();

  return { ok: true, sumas };
});

// Un correo que llega a partir de las 15:00 ya no da tiempo a organizarlo
// para hoy, asi que cuenta como pedido de mañana. Se mira la hora real de
// llegada del correo (no la hora en que se procesa, que puede ir 10 min
// por detras), en la zona horaria de la empresa.
function fechaPedidoParaCorreo(receivedDateTime) {
  const recibido = receivedDateTime ? new Date(receivedDateTime) : new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false
  });
  const partes = fmt.formatToParts(recibido).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  let fecha = partes.year + "-" + partes.month + "-" + partes.day;
  if (Number(partes.hour) >= 15) {
    const d = new Date(fecha + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 1);
    fecha = d.toISOString().slice(0, 10);
  }
  return fecha;
}

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
        "&$select=id,subject,from,toRecipients,ccRecipients,hasAttachments,receivedDateTime");
    } catch (e) { console.error("revisarCorreoPedidos: listar mensajes:", e.message); return; }

    console.log("revisarCorreoPedidos: " + (data.value || []).length + " correo(s) no leido(s) encontrado(s).");

    for (const msg of (data.value || [])) {
      try {
        // Los correos de incidencias de transporte (Usieto) los procesa
        // revisarCorreoIncidencias: si tambien se tocan aqui, cualquiera de
        // las dos funciones podria marcarlos como leidos antes de que la
        // otra llegue a verlos.
        if (remitenteDeUsieto(msg)) {
          console.log("revisarCorreoPedidos: es de Usieto, se deja para revisarCorreoIncidencias:", msg.subject);
          continue;
        }
        if (!msg.hasAttachments) {
          console.log("revisarCorreoPedidos: sin adjuntos, descartado:", msg.subject);
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const adjuntos = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "/attachments");
        const conContenido = (adjuntos.value || []).filter(a => a.contentBytes);
        const excel = conContenido.find(a => /\.xlsx?$/i.test(a.name || ""));
        const pdfAdj = conContenido.find(a => /\.pdf$/i.test(a.name || ""));
        const elegido = excel || pdfAdj;
        if (!elegido) {
          // hasAttachments=true no siempre trae un fichero descargable: por
          // ejemplo, un correo reenviado "como datos adjuntos" trae el
          // correo original incrustado (itemAttachment), sin contentBytes.
          console.log("revisarCorreoPedidos: tiene adjuntos pero ninguno es xlsx/pdf descargable:",
            msg.subject, "-", (adjuntos.value || []).map(a => (a.name || "?") + " (" + a["@odata.type"] + ")").join(", "));
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const buffer = Buffer.from(elegido.contentBytes, "base64");
        const resultado = elegido === excel ? contarPaletsExcel(buffer) : await contarPaletsPdf(buffer);

        // El "Origen" del propio documento manda; el dominio del correo
        // (Para/CC) queda solo como reserva si el documento no lo trae.
        const almacen = resultado.almacenDetectado || detectarAlmacenPorDestinatarios(msg);
        if (!almacen) {
          console.log("revisarCorreoPedidos: sin almacen reconocido en", msg.subject);
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const pt = (resultado.pt)
          || (elegido.name.match(/PT\d{6}/) || [])[0]
          || ((msg.subject || "").match(/PT\d{6}/) || [])[0]
          || ("SINPT-" + msg.id.slice(-8));

        console.log("revisarCorreoPedidos: procesando", pt, almacen, resultado.palets, "palets -", msg.subject);
        await crearPedidoTransferencia(pt, almacen, resultado, "email", fechaPedidoParaCorreo(msg.receivedDateTime));
        await graphMarcarLeido(token, msg.id);
      } catch (e) {
        console.error("revisarCorreoPedidos: mensaje", msg.id, e.message);
      }
    }
  }
);

// ── Incidencias de transporte (D.I.R.E. USIETO) ─────────────────────────────
//
// Cada correo de @grupousieto.com en el buzon de pedidos puede traer un PDF
// "Comunicado de Incidencia". Si el adjunto no encaja con esa plantilla se
// descarta sin mas (tarde o temprano lo reenvian bien formateado): no hay
// forma fiable de leer un albaran escaneado con anotaciones a mano.
//
// Las incidencias reconocidas se guardan segun llegan, y una vez al dia se
// manda un correo resumen con las de las ultimas 24h.

const DOMINIO_INCIDENCIAS = "grupousieto.com";
const DESTINATARIOS_INCIDENCIAS = [
  { email: "mlorente@aldelis.com", nombre: "Manuel" },
  { email: "jreyes@aldelis.com", nombre: "Jessica" },
  { email: "dgamarra@aldelis.com", nombre: "Daniel" }
];

function remitenteDeUsieto(msg) {
  const dir = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address || "").toLowerCase();
  return dir.endsWith("@" + DOMINIO_INCIDENCIAS) ? dir : null;
}

// La plantilla es una tabla: al extraer el texto, todas las etiquetas salen
// juntas y luego todos los valores juntos (no en el mismo orden visual), asi
// que en vez de intentar reconstruir la tabla se buscan anclas fijas del
// propio texto (el "0US..." de la posicion, las fechas, y el bloque fijo
// "Aldelis (Aves Nobles y Derivados)" que precede siempre a Destinatario/
// Localidad/Provincia).
function parseIncidenciaUsieto(texto) {
  if (!/COMUNICADO DE INCIDENCIA/i.test(texto)) return null;

  const posicionMatch = texto.match(/\b0US\d{9}\b/);
  const fechas = texto.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  const fechaExp = fechas[0] || null;
  const fechaIncidencia = fechas[1] || null;

  const expedidorIdx = texto.indexOf("Aldelis (Aves Nobles y Derivados)");
  let destinatario = null, localidad = null, provincia = null;
  if (expedidorIdx !== -1) {
    const resto = texto.slice(expedidorIdx).split("\n").map(l => l.trim()).filter(Boolean);
    destinatario = resto[1] || null;
    localidad = resto[2] || null;
    provincia = resto[3] || null;
  }

  let descripcion = null;
  if (fechaIncidencia) {
    const idxIncidenciaSec = texto.indexOf("INCIDENCIA A LA ENTREGA");
    const idxFechaInc = texto.indexOf(fechaIncidencia, idxIncidenciaSec !== -1 ? idxIncidenciaSec : 0);
    const finIdx = texto.indexOf("RESPUESTA A LA INCIDENCIA");
    const bloque = texto.slice(idxFechaInc + fechaIncidencia.length, finIdx !== -1 ? finIdx : undefined);
    const lineas = bloque.split("\n").map(l => l.trim()).filter(Boolean);
    descripcion = lineas.filter(l => !/^\d+$/.test(l)).join(" ") || null;
  }

  if (!posicionMatch && !descripcion) return null;

  return {
    posicion: posicionMatch ? posicionMatch[0] : null,
    fechaExp, fechaIncidencia, destinatario, localidad, provincia, descripcion
  };
}

exports.revisarCorreoIncidencias = onSchedule(
  { schedule: "every 4 hours", timeZone: "Europe/Madrid" },
  async () => {
    if (!MS_SECRET) { console.warn("revisarCorreoIncidencias: falta MS_SECRET"); return; }

    let token;
    try { token = await obtenerTokenMS(); }
    catch (e) { console.error("revisarCorreoIncidencias: token:", e.message); return; }

    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25" +
        "&$select=id,subject,from,hasAttachments,receivedDateTime");
    } catch (e) { console.error("revisarCorreoIncidencias: listar mensajes:", e.message); return; }

    for (const msg of (data.value || [])) {
      try {
        const remitente = remitenteDeUsieto(msg);
        if (!remitente || !msg.hasAttachments) continue; // no marca leido: lo puede querer procesar revisarCorreoPedidos

        const adjuntos = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "/attachments");
        const pdfs = (adjuntos.value || []).filter(a => a.contentBytes && /\.pdf$/i.test(a.name || ""));
        if (!pdfs.length) { await graphMarcarLeido(token, msg.id); continue; }

        let algunaReconocida = false;
        for (const pdf of pdfs) {
          const buffer = Buffer.from(pdf.contentBytes, "base64");
          const { PDFParse } = require("pdf-parse");
          const parser = new PDFParse({ data: buffer });
          let texto = "";
          try { texto = (await parser.getText()).text || ""; }
          finally { await parser.destroy(); }

          const incidencia = parseIncidenciaUsieto(texto);
          if (!incidencia) continue;
          algunaReconocida = true;

          const datos = {
            ...incidencia,
            remitente, asunto: msg.subject || "",
            creado: admin.firestore.Timestamp.now()
          };

          // Usieto reenvia a veces el mismo aviso (o esta funcion reprocesa el
          // correo si no se llego a marcar como leido la vez anterior): con
          // posicion se usa como ID del documento para no duplicar la misma
          // incidencia en el informe. Sin posicion reconocida no hay clave
          // fiable, se guarda igual que antes (puede repetirse en ese caso).
          if (incidencia.posicion) {
            try {
              await db.collection("incidencias_transporte").doc(incidencia.posicion).create(datos);
            } catch (e) {
              if (e.code !== 6 /* ALREADY_EXISTS */) throw e;
              console.log("revisarCorreoIncidencias: incidencia", incidencia.posicion, "ya registrada, no se repite.");
            }
          } else {
            await db.collection("incidencias_transporte").add(datos);
          }
        }

        if (!algunaReconocida) {
          console.log("revisarCorreoIncidencias: PDF sin formato reconocido, descartado:", msg.subject);
        }
        await graphMarcarLeido(token, msg.id);
      } catch (e) {
        console.error("revisarCorreoIncidencias: mensaje", msg.id, e.message);
      }
    }
  }
);

// Convierte una fecha/hora "de reloj" en Madrid al instante UTC real que le
// corresponde, sin depender de si ese dia cae en horario de invierno o de
// verano (CET/CEST) - hace falta para calcular con precision los limites de
// un mes en el resumen mensual, igual que el diario ya calcula "hoy" con
// toLocaleDateString.
function madridADate(y, m, d, hh, mm, ss) {
  const asUTC = Date.UTC(y, m - 1, d, hh, mm, ss);
  const inv = new Date(new Date(asUTC).toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  const diff = asUTC - inv.getTime();
  return new Date(asUTC + diff);
}

function filasIncidenciasHtml(filas, mensajeVacio) {
  return filas.length
    ? filas.map(f =>
        "<tr>" +
        "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + (f.posicion || "-") + "</td>" +
        "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + (f.fechaExp || "-") + "</td>" +
        "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + (f.destinatario || "-") + (f.localidad ? " (" + f.localidad + (f.provincia ? ", " + f.provincia : "") + ")" : "") + "</td>" +
        "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + (f.descripcion || "-") + "</td>" +
        "</tr>"
      ).join("")
    : "<tr><td colspan='4' style='padding:10px'>" + mensajeVacio + "</td></tr>";
}

// Envia el mismo informe (tabla de incidencias) a todos los destinatarios,
// cada uno con su propio saludo. Usado tanto por el resumen diario como por
// el mensual.
async function enviarInformeIncidenciasATodos(asunto, titulo, subtitulo, filasHtml) {
  try {
    const token = await obtenerTokenMS();
    for (const dest of DESTINATARIOS_INCIDENCIAS) {
      const html = "<html><body style='font-family:Arial,sans-serif;font-size:13px;color:#1A1A1A'>" +
        "<p>Hola " + esc(dest.nombre) + ",</p>" +
        "<h2 style='margin-bottom:4px'>" + titulo + "</h2>" +
        "<p style='color:#6B7280;margin-top:0'>" + subtitulo + "</p>" +
        "<table style='border-collapse:collapse;width:100%'>" +
        "<thead><tr style='text-align:left;background:#F5F5F5'>" +
        "<th style='padding:6px 10px'>Posicion</th><th style='padding:6px 10px'>Fecha exp.</th>" +
        "<th style='padding:6px 10px'>Destinatario</th><th style='padding:6px 10px'>Incidencia</th>" +
        "</tr></thead><tbody>" + filasHtml + "</tbody></table>" +
        "</body></html>";
      const cuerpo = "Hola " + dest.nombre + ",\n\n" + titulo + ".";
      await enviarConGraph(token, dest.email, asunto, html, cuerpo, null);
    }
  } catch (e) {
    console.error("enviarInformeIncidenciasATodos:", e.message);
  }
}

// Cada dia a las 16:00 (Europe/Madrid), recopilatorio de lo recibido desde
// las 16:00 del dia anterior.
exports.enviarResumenIncidencias = onSchedule(
  { schedule: "0 16 * * *", timeZone: "Europe/Madrid" },
  async () => {
    const ahora = admin.firestore.Timestamp.now();
    const desde = admin.firestore.Timestamp.fromMillis(ahora.toMillis() - 24 * 3600 * 1000);

    let snap;
    try {
      snap = await db.collection("incidencias_transporte")
        .where("creado", ">=", desde).where("creado", "<", ahora)
        .orderBy("creado", "asc").get();
    } catch (e) { console.error("enviarResumenIncidencias: consulta:", e.message); return; }

    const filas = [];
    snap.forEach(d => filas.push(d.data()));

    const fechaFmt = new Date(ahora.toMillis()).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" });
    const asunto = "Incidencias de transporte — " + fechaFmt + " (" + filas.length + ")";
    const filasHtml = filasIncidenciasHtml(filas, "Sin incidencias en las ultimas 24 horas.");

    await enviarInformeIncidenciasATodos(
      asunto,
      "Incidencias de transporte — " + fechaFmt,
      "Recibidas entre las 16:00 del dia anterior y las 16:00 de hoy.",
      filasHtml
    );
    console.log("Resumen de incidencias enviado:", filas.length, "incidencias.");
  }
);

// El dia 1 de cada mes a las 8:00 (Europe/Madrid), recopilatorio de todo lo
// recibido durante el mes anterior completo.
exports.enviarResumenIncidenciasMensual = onSchedule(
  { schedule: "0 8 1 * *", timeZone: "Europe/Madrid" },
  async () => {
    const [y, m] = fechaHoyMadrid().split("-").map(Number);
    const mesAntY = (m === 1) ? y - 1 : y;
    const mesAntM = (m === 1) ? 12 : m - 1;

    const desde = admin.firestore.Timestamp.fromDate(madridADate(mesAntY, mesAntM, 1, 0, 0, 0));
    const hasta = admin.firestore.Timestamp.fromDate(madridADate(y, m, 1, 0, 0, 0));

    let snap;
    try {
      snap = await db.collection("incidencias_transporte")
        .where("creado", ">=", desde).where("creado", "<", hasta)
        .orderBy("creado", "asc").get();
    } catch (e) { console.error("enviarResumenIncidenciasMensual: consulta:", e.message); return; }

    const filas = [];
    snap.forEach(d => filas.push(d.data()));

    const nombreMes = new Date(Date.UTC(mesAntY, mesAntM - 1, 1))
      .toLocaleDateString("es-ES", { month: "long", year: "numeric", timeZone: "UTC" });
    const asunto = "Incidencias de transporte — " + nombreMes + " (" + filas.length + ")";
    const filasHtml = filasIncidenciasHtml(filas, "Sin incidencias en " + nombreMes + ".");

    await enviarInformeIncidenciasATodos(
      asunto,
      "Incidencias de transporte — " + nombreMes,
      "Resumen mensual: todas las incidencias recibidas durante " + nombreMes + ".",
      filasHtml
    );
    console.log("Resumen mensual de incidencias enviado:", filas.length, "incidencias,", nombreMes);
  }
);

// ── Cambios de material (etiquetas/bandejas) ────────────────────────────────
//
// I+D da de alta un cambio de referencia (por agotar stock o con fecha fija).
// Al crearse, se avisa por correo a los destinatarios configurados
// (config/cambios.emails) con los datos del cambio, para que almacen lo
// ejecute. Cuando alguien marca el cambio como ejecutado (actualizando el
// documento desde el panel, con permiso), se manda un segundo correo
// avisando a todos de que ya esta hecho.
//
// El chat de cada cambio (cambios_mensajes) no necesita Cloud Function: se
// lee y se escribe directo desde el panel, protegido por las reglas de
// Firestore igual que el resto del modulo.

const MOTIVO_LABEL_CAMBIO = {
  alergenos: "Alergenos", diseno: "Cambio de diseño", proveedor: "Cambio de proveedor",
  normativa: "Normativa / legal", coste: "Optimizacion de coste", otro: "Otro"
};

async function emailsCambiosMaterial() {
  return emailsDeConfig("cambios", []);
}

// Ancho fijo (no %) en la columna de la etiqueta: sin eso, cada cliente de
// correo reparte las dos columnas como quiere y el hueco entre "Motivo" y
// "Alergenos" puede acabar ocupando media pantalla (nos paso justo esto).
function filaCambio(label, valor) {
  return "<tr>" +
    "<td width='150' valign='top' style='padding:7px 10px 7px 0;color:#8A8F98;font-size:12.5px;white-space:nowrap'>" + label + "</td>" +
    "<td valign='top' style='padding:7px 0;font-size:12.5px;color:#333;font-weight:500'>" + valor + "</td>" +
    "</tr>";
}

function htmlCambioMaterial(d, titulo, colorCabecera) {
  const motivoTxt = MOTIVO_LABEL_CAMBIO[d.motivo] || d.motivo || "-";
  return HEAD_EMAIL + "<body bgcolor='#f6f6f7' style='margin:0;padding:16px;background-color:#f6f6f7;" + FONT + "'>" +
    "<div style='max-width:480px;margin:0 auto'>" +
    "<table width='100%' cellpadding='0' cellspacing='0' style='margin-bottom:18px'><tr>" +
    "<td width='38' style='padding-right:12px'><img src='https://aldelis-muelles.web.app/icon-512.png' width='30' height='30' style='display:block;border-radius:7px'></td>" +
    "<td style='border-bottom:2px solid " + colorCabecera + ";padding-bottom:9px'>" +
    "<div style='font-size:14px;font-weight:700;color:#1A1A1A'>Aldelis</div>" +
    "<div style='font-size:11.5px;color:#8A8F98;margin-top:2px'>" + titulo + "</div>" +
    "</td></tr></table>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" +
    filaCambio("Tipo de material", d.tipo === "bandeja" ? "Bandeja" : "Etiqueta") +
    filaCambio("Referencia actual", esc(d.referenciaActual || "-")) +
    filaCambio("Referencia nueva", esc(d.referenciaNueva || "-")) +
    filaCambio("Motivo", esc(motivoTxt)) +
    filaCambio("Agotar stock primero", d.agotarStock ? "Si" : "No") +
    filaCambio("Fecha de arranque", d.fechaArranque ? esc(d.fechaArranque) : "Sin fecha fijada todavia") +
    (d.descripcion ? filaCambio("Descripcion", esc(d.descripcion)) : "") +
    (d.observaciones ? filaCambio("Observaciones", esc(d.observaciones)) : "") +
    (d.fechaEjecutada ? filaCambio("Ejecutado el", esc(d.fechaEjecutada)) : "") +
    "</table>" +
    "<div style='height:1px;background:#e5e5e7;margin:18px 0 12px'></div>" +
    "<div style='font-size:10.5px;color:#B0B4BB'>Cambios de material &middot; Aldelis</div>" +
    "</div></body></html>";
}

// Correo aparte, solo para el aviso con documento PDF de un cambio de fecha
// fija: misma cabecera que htmlCambioMaterial, con la vista previa (primera
// pagina del PDF, ya renderizada a imagen en el navegador) incrustada con
// cid: ademas de mencionar que el PDF va adjunto para verlo completo.
function htmlCambioMaterialPdf(d) {
  const motivoTxt = MOTIVO_LABEL_CAMBIO[d.motivo] || d.motivo || "-";
  return HEAD_EMAIL + "<body bgcolor='#f6f6f7' style='margin:0;padding:16px;background-color:#f6f6f7;" + FONT + "'>" +
    "<div style='max-width:480px;margin:0 auto'>" +
    "<table width='100%' cellpadding='0' cellspacing='0' style='margin-bottom:18px'><tr>" +
    "<td width='38' style='padding-right:12px'><img src='https://aldelis-muelles.web.app/icon-512.png' width='30' height='30' style='display:block;border-radius:7px'></td>" +
    "<td style='border-bottom:2px solid #D41F3A;padding-bottom:9px'>" +
    "<div style='font-size:14px;font-weight:700;color:#1A1A1A'>Aldelis</div>" +
    "<div style='font-size:11.5px;color:#8A8F98;margin-top:2px'>Documento de cambio de material</div>" +
    "</td></tr></table>" +
    "<table width='100%' cellpadding='0' cellspacing='0'>" +
    filaCambio("Referencia actual", esc(d.referenciaActual || "-")) +
    filaCambio("Referencia nueva", esc(d.referenciaNueva || "-")) +
    filaCambio("Motivo", esc(motivoTxt)) +
    filaCambio("Fecha de arranque", d.fechaArranque ? esc(d.fechaArranque) : "Sin fecha fijada todavia") +
    "</table>" +
    (d.pdfPreviewBase64
      ? "<div style='margin:16px 0'><img src='cid:cambio-pdf-preview' style='max-width:100%;border:1px solid #e5e5e7;border-radius:6px'></div>"
      : "") +
    "<div style='font-size:12.5px;color:#6B7280'>El documento completo va adjunto en PDF.</div>" +
    "<div style='height:1px;background:#e5e5e7;margin:18px 0 12px'></div>" +
    "<div style='font-size:10.5px;color:#B0B4BB'>Cambios de material &middot; Aldelis</div>" +
    "</div></body></html>";
}

exports.notifCambioMaterial = onDocumentWritten("cambios_material/{id}", async (event) => {
  const antes = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const despues = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!despues) return; // documento borrado

  const emails = await emailsCambiosMaterial();
  if (!emails.length) { console.log("notifCambioMaterial: sin destinatarios configurados"); return; }

  let asunto, html, cuerpo;
  if (!antes) {
    // Alta nueva
    asunto = "Nuevo cambio de material: " + (despues.referenciaActual || "?") + " -> " + (despues.referenciaNueva || "?");
    html = htmlCambioMaterial(despues, "Nuevo cambio de material registrado", "#D41F3A");
    cuerpo = "Nuevo cambio de material: " + despues.referenciaActual + " -> " + despues.referenciaNueva;
  } else if (antes.estado !== "ejecutado" && despues.estado === "ejecutado") {
    // Paso a ejecutado
    asunto = "Cambio ejecutado: " + (despues.referenciaActual || "?") + " -> " + (despues.referenciaNueva || "?");
    html = htmlCambioMaterial(despues, "Cambio de material ejecutado", "#1D9E75");
    cuerpo = "Cambio ejecutado: " + despues.referenciaActual + " -> " + despues.referenciaNueva;
  } else {
    return; // otro tipo de edicion, no se avisa
  }

  try {
    const token = await obtenerTokenMS();
    for (const email of emails) {
      await enviarConGraph(token, email, asunto, html, cuerpo, null);
    }

    // Aviso aparte, con el documento adjunto, solo al darse de alta un
    // cambio de fecha fija (no "agotar stock") que traiga un PDF. Lista de
    // destinatarios independiente (config/cambios_pdf).
    if (!antes && !despues.agotarStock && despues.pdfBase64) {
      const destinatariosPdf = await emailsDeConfig("cambios_pdf", []);
      if (!destinatariosPdf.length) {
        console.log("notifCambioMaterial: PDF sin destinatarios configurados (config/cambios_pdf)");
      } else {
        const asuntoPdf = "Comunicación cambio de etiquetado: " + (despues.referenciaActual || "?") + " -> " + (despues.referenciaNueva || "?");
        const htmlPdf = htmlCambioMaterialPdf(despues);
        const adjuntos = [{
          name: despues.pdfNombre || "documento.pdf", contentType: "application/pdf",
          contentBytes: despues.pdfBase64, isInline: false
        }];
        if (despues.pdfPreviewBase64) {
          adjuntos.push({
            name: "vista-previa.jpg", contentType: "image/jpeg",
            contentBytes: despues.pdfPreviewBase64, contentId: "cambio-pdf-preview", isInline: true
          });
        }
        for (const email of destinatariosPdf) {
          await enviarConGraph(token, email, asuntoPdf, htmlPdf, "Documento adjunto del cambio de material.", null, adjuntos);
        }
      }
    }
  } catch (e) {
    console.error("notifCambioMaterial: envio:", e.message);
  }
});

// ── Estimacion de hora de fin de las recogidas externas ─────────────────────
//
// Cada noche se calcula, con el historico de los ultimos 14 dias, a que hora
// suelen terminar las recogidas en cada almacen externo (Avitrans/Caserfri/
// Txt), cuanto se tarda de media por visita, y tambien cuanto se tarda en
// llegar hasta alli (transito) y cuanto se tarda cargando en Plaza antes de
// salir. Solo se usan las lanzaderas 2 y 3 para la media: la 4 solo entra
// quando hay exceso de trabajo (segun el usuario) y metida en la media
// historica la desvirtuaria.
//
// El resultado se guarda en config/estimacion_recogidas y lo lee el panel
// para pintar "Fin estimado: HH:MM" en cada tarjeta, ajustando en el propio
// cliente segun donde este cada lanzadera ahora mismo: si va con retraso (en
// la nave, en el transito, o en cualquier otro punto) el fin estimado se
// retrasa, y si ha llegado antes de lo habitual, se adelanta (ver
// estimacionFinMinutos en admin.js).
//
// Solo la ULTIMA visita de cada dia a cada almacen cuenta para la hora media
// de inicio/fin: si un almacen recibe mas de una visita al dia, promediar
// todas mezclaria la hora de la visita de la mañana con la de la tarde y
// saldria una hora que no corresponde a ninguna visita real.

const LANZ_RECOGIDAS_EXTERNAS = [2, 3];
const DIAS_HISTORICO_RECOGIDAS = 14;
const DURACION_MAX_MIN = 240; // descarta segmentos absurdamente largos (registro sin cerrar, etc.)

function minutoDelDiaMadrid(ms) {
  const local = new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" });
  const [h, m] = local.split(" ")[1].split(":").map(Number);
  return h * 60 + m;
}

function diaMadrid(ms) {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }).split(" ")[0];
}

function media(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// De una lista de segmentos {diaKey, inicioMs, finMs, duracionMin}, se queda
// solo con el ultimo de cada dia (el de inicioMs mas alto), para no mezclar
// varias visitas del mismo dia en una sola media.
function ultimoPorDia(segmentos) {
  const porDia = {};
  segmentos.forEach(s => {
    const actual = porDia[s.diaKey];
    if (!actual || s.inicioMs > actual.inicioMs) porDia[s.diaKey] = s;
  });
  return Object.values(porDia);
}

exports.calcularEstimacionRecogidas = onSchedule(
  { schedule: "0 3 * * *", timeZone: "Europe/Madrid" },
  async () => {
    const hasta = Date.now();
    const desde = hasta - DIAS_HISTORICO_RECOGIDAS * 24 * 3600 * 1000;

    let snap;
    try {
      snap = await db.collection("lanzaderas_log")
        .where("desde", ">=", admin.firestore.Timestamp.fromMillis(desde))
        .orderBy("desde", "asc").get();
    } catch (e) { console.error("calcularEstimacionRecogidas: consulta:", e.message); return; }

    // Agrupar por lanzadera para poder calcular la duracion de cada segmento
    // (hasta el siguiente evento de esa misma lanzadera), igual que hace el
    // informe de costes.
    const porLanz = {};
    snap.forEach(doc => {
      const d = doc.data();
      if (!LANZ_RECOGIDAS_EXTERNAS.includes(d.numero)) return;
      (porLanz[d.numero] = porLanz[d.numero] || []).push(d);
    });

    const segmentosNave = { avitrans: [], caserfri: [], txt: [] }; // ultima visita del dia
    const segmentosTransito = { avitrans: [], caserfri: [], txt: [] }; // todos, sin distinguir dia
    const segmentosPlaza = []; // todos
    const segmentosTransitoGenerico = []; // transitos sin destino reconocido (o hacia plaza/merca/arento)

    Object.values(porLanz).forEach(eventos => {
      for (let i = 0; i < eventos.length; i++) {
        const ev = eventos[i];
        const siguiente = (i + 1 < eventos.length) ? eventos[i + 1] : null;
        if (!siguiente) continue; // ultimo evento del historico, sin cierre fiable: se descarta

        const inicioMs = ev.desde.toMillis();
        const finMs = siguiente.desde.toMillis();
        const duracionMin = (finMs - inicioMs) / 60000;
        if (duracionMin <= 0 || duracionMin > DURACION_MAX_MIN) continue; // descarta valores absurdos

        if (ev.estado === "en_nave" && ALMACENES_PT.includes(ev.nave)) {
          segmentosNave[ev.nave].push({ diaKey: diaMadrid(inicioMs), inicioMs, finMs, duracionMin });
        } else if (ev.estado === "en_nave" && ev.nave === "plaza") {
          segmentosPlaza.push({ duracionMin });
        } else if (ev.estado === "transito") {
          if (ev.destino && ALMACENES_PT.includes(ev.destino)) {
            segmentosTransito[ev.destino].push({ duracionMin });
          } else {
            segmentosTransitoGenerico.push({ duracionMin });
          }
        }
      }
    });

    const resultado = {};
    ALMACENES_PT.forEach(a => {
      const ultimas = ultimoPorDia(segmentosNave[a]);
      resultado[a] = {
        inicioMedioMin: media(ultimas.map(s => minutoDelDiaMadrid(s.inicioMs))),
        finMedioMin: media(ultimas.map(s => minutoDelDiaMadrid(s.finMs))),
        duracionMediaMin: media(ultimas.map(s => s.duracionMin)),
        muestras: ultimas.length,
        transitoMedioMin: media(segmentosTransito[a].map(s => s.duracionMin)),
        muestrasTransito: segmentosTransito[a].length
      };
    });
    resultado.plaza = { duracionMediaMin: media(segmentosPlaza.map(s => s.duracionMin)) };
    resultado.transitoGenericoMedioMin = media(segmentosTransitoGenerico.map(s => s.duracionMin));
    resultado.calculadoEn = admin.firestore.Timestamp.now();

    try {
      await db.collection("config").doc("estimacion_recogidas").set(resultado);
      console.log("calcularEstimacionRecogidas: hecho.", JSON.stringify(resultado));
    } catch (e) { console.error("calcularEstimacionRecogidas: guardar:", e.message); }
  }
);

// Ajuste en vivo (adelanto o retraso) que hay que sumarle a finMedioMin para
// un almacen, segun donde este cada lanzadera 2/3 AHORA MISMO. Compartido
// entre el panel (admin.js, misma logica) y la alerta de cierre (mas abajo).
// - Si una lanzadera esta en ese almacen: se compara la hora real de llegada
//   con la hora media historica de llegada (adelanto/retraso de horario), y
//   si ya lleva mas tiempo del habitual, se suma ese exceso.
// - Si una lanzadera va en transito hacia ese almacen: solo se suma exceso si
//   el trayecto ya dura mas de lo habitual (no hay forma fiable de saber si
//   "iba a salir antes" sin fecha de salida de referencia clara).
// - Si ninguna de las dos esta trabajando ese almacen ahora mismo, se usa el
//   peor exceso que este acumulando cualquiera de las dos en lo que este
//   haciendo (Plaza, otro almacen, u otro transito): si van tarde en general,
//   es de esperar que tambien lleguen tarde aqui.
function ajusteFinMinutos(almacenId, est, lanzaderasLive, ahoraMs) {
  const e = est[almacenId];
  if (!e || e.finMedioMin == null) return null;

  const activas = LANZ_RECOGIDAS_EXTERNAS
    .map(n => lanzaderasLive[n])
    .filter(l => l && l.activa && l.desde);

  const enEsteAlmacen = activas.find(l => l.estado === "en_nave" && l.nave === almacenId);
  if (enEsteAlmacen) {
    const inicioReal = enEsteAlmacen.desde.toMillis();
    const elapsedMin = (ahoraMs - inicioReal) / 60000;
    let ajuste = 0;
    if (e.inicioMedioMin != null) ajuste += minutoDelDiaMadrid(inicioReal) - e.inicioMedioMin;
    if (e.duracionMediaMin != null) ajuste += Math.max(0, elapsedMin - e.duracionMediaMin);
    return ajuste;
  }

  const enTransitoAqui = activas.find(l => l.estado === "transito" && l.destino === almacenId);
  if (enTransitoAqui && e.transitoMedioMin != null) {
    const elapsedMin = (ahoraMs - enTransitoAqui.desde.toMillis()) / 60000;
    return Math.max(0, elapsedMin - e.transitoMedioMin);
  }

  // Ninguna de las dos va hacia aqui ahora mismo: usar el peor retraso que
  // ya se este acumulando en lo que esten haciendo, como aviso preventivo.
  let peor = 0;
  activas.forEach(l => {
    const elapsedMin = (ahoraMs - l.desde.toMillis()) / 60000;
    let media = null;
    if (l.estado === "en_nave" && l.nave === "plaza") media = est.plaza && est.plaza.duracionMediaMin;
    else if (l.estado === "en_nave" && ALMACENES_PT.includes(l.nave)) media = est[l.nave] && est[l.nave].duracionMediaMin;
    else if (l.estado === "transito") {
      media = (l.destino && est[l.destino] && est[l.destino].transitoMedioMin != null)
        ? est[l.destino].transitoMedioMin : est.transitoGenericoMedioMin;
    }
    if (media != null) peor = Math.max(peor, elapsedMin - media);
  });
  return Math.max(0, peor);
}

// ── Alerta de cierre de almacen en riesgo ───────────────────────────────────
//
// Cada almacen externo cierra a una hora (configurable en config/cierres_
// almacenes, editable desde el panel): si con el ritmo de hoy no vamos a
// llegar a recoger todo antes de esa hora, se avisa para reaccionar a tiempo
// (p.ej. contratando una cuarta lanzadera). Mismo calculo de "fin estimado"
// que pinta el panel (estimacionFinTexto en admin.js), repetido aqui en el
// servidor porque el aviso tiene que salir aunque nadie tenga el panel
// abierto.
const CIERRES_DEFECTO = { avitrans: "17:00", caserfri: "18:00", txt: "15:00" };

function minutosDeHHMM(s) {
  const m = typeof s === "string" && s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

exports.revisarCierresAlmacenes = onSchedule(
  { schedule: "*/15 7-20 * * *", timeZone: "Europe/Madrid" },
  async () => {
    // DESACTIVADO A PETICION: la estimacion de "llegada a tiempo" no
    // calcula bien todavia. Se reactiva quitando este return en cuanto se
    // cuadren los tiempos (el resto de la funcion se deja intacto).
    return;

    const hoy = fechaHoyMadrid();

    const [cierresSnap, estSnap, lanzSnap, ptsSnap] = await Promise.all([
      db.collection("config").doc("cierres_almacenes").get(),
      db.collection("config").doc("estimacion_recogidas").get(),
      db.collection("lanzaderas").where("numero", "in", LANZ_RECOGIDAS_EXTERNAS).get(),
      db.collection("pedidos_transferencia").where("cerrado", "==", false).get()
    ]);

    const cierres = Object.assign({}, CIERRES_DEFECTO, cierresSnap.exists ? cierresSnap.data() : {});
    const est = estSnap.exists ? estSnap.data() : {};

    const pendientePorAlmacen = {};
    ALMACENES_PT.forEach(a => { pendientePorAlmacen[a] = 0; });
    ptsSnap.forEach(doc => {
      const d = doc.data();
      if (d.activado === false) return;
      if (!ALMACENES_PT.includes(d.almacen)) return;
      pendientePorAlmacen[d.almacen] += Math.max((d.palets || 0) - (d.recogido || 0), 0);
    });

    const lanzaderasLive = {};
    lanzSnap.forEach(doc => { lanzaderasLive[doc.data().numero] = doc.data(); });
    const ahoraMs = Date.now();

    const enRiesgo = [];
    for (const almacen of ALMACENES_PT) {
      const pendiente = pendientePorAlmacen[almacen] || 0;
      if (pendiente <= 0) continue;

      const e = est[almacen];
      if (!e || e.finMedioMin == null) continue;

      const ajuste = ajusteFinMinutos(almacen, est, lanzaderasLive, ahoraMs);
      const finEstimadoMin = e.finMedioMin + (ajuste || 0);

      const cierreMin = minutosDeHHMM(cierres[almacen]);
      if (cierreMin == null || finEstimadoMin <= cierreMin) continue;

      enRiesgo.push({ almacen, pendiente, finEstimadoMin, cierreMin });
    }

    if (!enRiesgo.length) return;

    const destinatarios = await emailsDeConfig("alertas", []);
    if (!destinatarios.length) { console.log("revisarCierresAlmacenes: en riesgo pero sin destinatarios."); return; }

    for (const r of enRiesgo) {
      const dedupRef = db.collection("alertas_cierre").doc(r.almacen + "_" + hoy);
      const dedup = await dedupRef.get();
      if (dedup.exists) continue; // ya avisado hoy para este almacen

      await dedupRef.set({ ts: admin.firestore.Timestamp.now(), finEstimadoMin: r.finEstimadoMin, pendiente: r.pendiente });

      const nombre = r.almacen.charAt(0).toUpperCase() + r.almacen.slice(1);
      const horaFin = minToHHMMServidor(r.finEstimadoMin);
      const horaCierre = minToHHMMServidor(r.cierreMin);

      await enviarALista(destinatarios,
        "ALERTA Aldelis — Riesgo de no llegar a recoger en " + nombre + " antes del cierre",
        "ALERTA de Aldelis Muelles\n\n" +
        "Con el ritmo de hoy, la recogida en " + nombre + " no terminaria hasta las " +
        horaFin + " aproximadamente, y " + nombre + " cierra a las " + horaCierre + ".\n\n" +
        "Quedan " + r.pendiente + " palets pendientes.\n\n" +
        "Revisa el panel y valora reforzar la recogida (p.ej. una cuarta lanzadera):\n" +
        "https://aldelis-muelles.web.app/admin.html" + FIRMA,
        null, null);

      console.log("revisarCierresAlmacenes: alerta enviada,", r.almacen, "fin estimado", horaFin, "cierre", horaCierre);
    }
  }
);

function minToHHMMServidor(minutos) {
  let m = Math.round(minutos) % 1440;
  if (m < 0) m += 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

// ── ACOPAL: balance recibido vs facturado en albaranes de Aves Nobles ──────
//
// ACOPAL avisa por correo ("Errores albaranes AVES NOBLES mercancia entrega")
// cuando lo recibido y lo facturado de un albaran no coinciden. Un desajuste
// aislado no dice nada (puede arreglarse al dia siguiente si el palet que
// faltaba llega tarde), asi que interesa ver la evolucion dia a dia y un
// balance al cierre de la semana, no solo el aviso suelto.
//
// Funcion de lectura de correo COMPLETAMENTE APARTE de revisarCorreoPedidos:
// si algo falla leyendo estos correos, no debe poder afectar a ningun otro
// flujo. No escribe en pedidos_transferencia ni en ninguna coleccion que
// otras funciones lean: coleccion propia, "albaranes_acopal".

function esErrorAlbaranAcopal(msg) {
  return /errores\s+albaranes/i.test(msg.subject || "");
}

// Convierte el cuerpo del correo (parrafos simples, no una tabla) en lineas
// de texto: cada </p>/</div>/<br> es un salto de linea razonable para este
// formato.
function htmlATextoLineas(html) {
  return String(html || "")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
}

// El correo puede traer varios albaranes, cada uno con varias lineas de
// producto: "Albaran NNNN" abre un bloque, y cada linea siguiente con el
// patron "referencia, recibido N, facturado N" se cuelga del ultimo albaran
// visto, hasta el siguiente "Albaran" o el fin del correo.
function parseAlbaranesAcopal(html) {
  const lineas = htmlATextoLineas(html);
  const albaranes = {};
  let actual = null;
  for (const linea of lineas) {
    const mAlb = linea.match(/^Albaran\s+(\d+)/i);
    if (mAlb) {
      actual = mAlb[1];
      if (!albaranes[actual]) albaranes[actual] = [];
      continue;
    }
    const mLinea = linea.match(/^(.*?),\s*recibido\s*(\d+)\s*,\s*facturado\s*(\d+)/i);
    if (mLinea && actual) {
      albaranes[actual].push({
        referencia: mLinea[1].trim(),
        recibido: Number(mLinea[2]),
        facturado: Number(mLinea[3])
      });
    }
  }
  return albaranes;
}

function fechaDeCorreoMadrid(receivedDateTime) {
  const recibido = receivedDateTime ? new Date(receivedDateTime) : new Date();
  return recibido.toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

function sumarDiasFecha(fechaStr, dias) {
  const d = new Date(fechaStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

exports.revisarCorreoAlbaranesAcopal = onSchedule(
  { schedule: "0 10 * * *", timeZone: "Europe/Madrid" },
  async () => {
    if (!MS_SECRET) { console.warn("revisarCorreoAlbaranesAcopal: falta MS_SECRET"); return; }

    let token;
    try { token = await obtenerTokenMS(); }
    catch (e) { console.error("revisarCorreoAlbaranesAcopal: token:", e.message); return; }

    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25" +
        "&$select=id,subject,receivedDateTime");
    } catch (e) { console.error("revisarCorreoAlbaranesAcopal: listar mensajes:", e.message); return; }

    const candidatos = (data.value || []).filter(esErrorAlbaranAcopal);
    console.log("revisarCorreoAlbaranesAcopal: " + candidatos.length + " correo(s) candidato(s) de "
      + (data.value || []).length + " no leido(s).");

    for (const msg of candidatos) {
      try {
        const detalle = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "?$select=body");
        const albaranes = parseAlbaranesAcopal(detalle.body && detalle.body.content);
        const nums = Object.keys(albaranes);
        if (!nums.length) {
          console.log("revisarCorreoAlbaranesAcopal: sin albaranes reconocidos en", msg.subject);
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const fecha = fechaDeCorreoMadrid(msg.receivedDateTime);
        for (const num of nums) {
          const lineasAlb = albaranes[num];
          const recibidoTotal = lineasAlb.reduce((s, l) => s + l.recibido, 0);
          const facturadoTotal = lineasAlb.reduce((s, l) => s + l.facturado, 0);
          await db.collection("albaranes_acopal").doc(num).set({
            albaran: num, lineas: lineasAlb,
            recibidoTotal, facturadoTotal, diferencia: facturadoTotal - recibidoTotal,
            fecha, actualizado: admin.firestore.Timestamp.now()
          });
          console.log("revisarCorreoAlbaranesAcopal: albaran", num, "recibido", recibidoTotal, "facturado", facturadoTotal);
        }
        await graphMarcarLeido(token, msg.id);
      } catch (e) {
        console.error("revisarCorreoAlbaranesAcopal: mensaje", msg.id, e.message);
      }
    }
  }
);

// Fila del albaran (totales) seguida de una fila por referencia (el
// desglose que ya trae el correo del ERP, guardado en "lineas"), mas
// pequeña y en gris para distinguirla de la fila de totales.
function filaAlbaranAcopalHtml(d) {
  const color = d.diferencia === 0 ? "#1D9E75" : "#D41F3A";
  let html = "<tr>" +
    "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + esc(d.albaran) + "</td>" +
    "<td style='padding:6px 10px;border-bottom:1px solid #eee;text-align:right'>" + d.recibidoTotal + "</td>" +
    "<td style='padding:6px 10px;border-bottom:1px solid #eee;text-align:right'>" + d.facturadoTotal + "</td>" +
    "<td style='padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:" + color + ";font-weight:600'>" +
    (d.diferencia > 0 ? "+" : "") + d.diferencia + "</td>" +
    "</tr>";
  (d.lineas || []).forEach(l => {
    const dif = l.facturado - l.recibido;
    const colorL = dif === 0 ? "#1D9E75" : "#D41F3A";
    html += "<tr>" +
      "<td style='padding:3px 10px 3px 22px;border-bottom:1px solid #f5f5f5;color:#6B7280;font-size:12px'>" + esc(l.referencia) + "</td>" +
      "<td style='padding:3px 10px;border-bottom:1px solid #f5f5f5;color:#6B7280;font-size:12px;text-align:right'>" + l.recibido + "</td>" +
      "<td style='padding:3px 10px;border-bottom:1px solid #f5f5f5;color:#6B7280;font-size:12px;text-align:right'>" + l.facturado + "</td>" +
      "<td style='padding:3px 10px;border-bottom:1px solid #f5f5f5;font-size:12px;text-align:right;color:" + colorL + "'>" +
      (dif > 0 ? "+" : "") + dif + "</td>" +
      "</tr>";
  });
  return html;
}

function tablaAlbaranesAcopalHtml(docs, mensajeVacio) {
  if (!docs.length) return "<tr><td colspan='4' style='padding:10px'>" + mensajeVacio + "</td></tr>";
  const filas = docs.map(filaAlbaranAcopalHtml).join("");
  const recibidoTotal = docs.reduce((s, d) => s + d.recibidoTotal, 0);
  const facturadoTotal = docs.reduce((s, d) => s + d.facturadoTotal, 0);
  const diferenciaTotal = facturadoTotal - recibidoTotal;
  const colorTotal = diferenciaTotal === 0 ? "#1D9E75" : "#D41F3A";
  const filaTotal = "<tr style='font-weight:700;background:#F5F5F5'>" +
    "<td style='padding:6px 10px'>Total</td>" +
    "<td style='padding:6px 10px;text-align:right'>" + recibidoTotal + "</td>" +
    "<td style='padding:6px 10px;text-align:right'>" + facturadoTotal + "</td>" +
    "<td style='padding:6px 10px;text-align:right;color:" + colorTotal + "'>" + (diferenciaTotal > 0 ? "+" : "") + diferenciaTotal + "</td>" +
    "</tr>";
  return filas + filaTotal;
}

// Tabla con ancho fijo (no al 100% del correo) y columnas con ancho propio,
// para que no se estire con huecos enormes en clientes de correo anchos.
async function enviarBalanceAcopalATodos(asunto, titulo, subtitulo, tablaHtml) {
  try {
    const token = await obtenerTokenMS();
    for (const dest of DESTINATARIOS_INCIDENCIAS) {
      const html = "<html><body style='font-family:Arial,sans-serif;font-size:13px;color:#1A1A1A'>" +
        "<p>Hola " + esc(dest.nombre) + ",</p>" +
        "<h2 style='margin-bottom:4px'>" + titulo + "</h2>" +
        "<p style='color:#6B7280;margin-top:0'>" + subtitulo + "</p>" +
        "<table style='border-collapse:collapse;width:560px;max-width:100%'>" +
        "<thead><tr style='text-align:left;background:#F5F5F5'>" +
        "<th style='padding:6px 10px;width:200px'>Albaran</th>" +
        "<th style='padding:6px 10px;width:120px;text-align:right'>Recibido</th>" +
        "<th style='padding:6px 10px;width:120px;text-align:right'>Facturado</th>" +
        "<th style='padding:6px 10px;width:120px;text-align:right'>Diferencia</th>" +
        "</tr></thead><tbody>" + tablaHtml + "</tbody></table>" +
        "<p style='color:#6B7280;font-size:12px;margin-top:14px'>Diferencia = facturado - recibido. " +
        "Positivo: se ha facturado mas de lo recibido (posible palet pendiente de recibir). " +
        "Negativo: se ha recibido mas de lo facturado.</p>" +
        "</body></html>";
      const cuerpo = "Hola " + dest.nombre + ",\n\n" + titulo + ".";
      await enviarALista([dest.email], asunto, cuerpo, html, null);
    }
  } catch (e) {
    console.error("enviarBalanceAcopalATodos:", e.message);
  }
}

// Cada dia a las 20:00 (Europe/Madrid), balance del dia comparado con el
// anterior: no sustituye al semanal, es para ver de un vistazo si un
// desajuste de ayer se ha corregido hoy o va a mas.
exports.enviarBalanceDiarioAcopal = onSchedule(
  { schedule: "0 20 * * *", timeZone: "Europe/Madrid" },
  async () => {
    const hoy = fechaHoyMadrid();
    const ayer = sumarDiasFecha(hoy, -1);

    let snapHoy, snapAyer;
    try {
      [snapHoy, snapAyer] = await Promise.all([
        db.collection("albaranes_acopal").where("fecha", "==", hoy).get(),
        db.collection("albaranes_acopal").where("fecha", "==", ayer).get()
      ]);
    } catch (e) { console.error("enviarBalanceDiarioAcopal: consulta:", e.message); return; }

    const docsHoy = []; snapHoy.forEach(d => docsHoy.push(d.data()));
    const docsAyer = []; snapAyer.forEach(d => docsAyer.push(d.data()));
    if (!docsHoy.length && !docsAyer.length) { console.log("enviarBalanceDiarioAcopal: sin albaranes en 2 dias, no se envia."); return; }

    const difHoy = docsHoy.reduce((s, d) => s + d.diferencia, 0);
    const difAyer = docsAyer.reduce((s, d) => s + d.diferencia, 0);
    const fechaFmt = new Date(hoy + "T00:00:00Z").toLocaleDateString("es-ES", { timeZone: "UTC" });

    const asunto = "Balance albaranes ACOPAL — " + fechaFmt + " (" + docsHoy.length + " albaran(es))";
    const tabla = tablaAlbaranesAcopalHtml(docsHoy, "Sin albaranes con diferencia hoy.");

    await enviarBalanceAcopalATodos(
      asunto,
      "Balance albaranes ACOPAL — " + fechaFmt,
      "Hoy: diferencia total " + (difHoy > 0 ? "+" : "") + difHoy +
      ". Ayer: diferencia total " + (difAyer > 0 ? "+" : "") + difAyer + ".",
      tabla
    );
    console.log("enviarBalanceDiarioAcopal: enviado,", docsHoy.length, "albaranes hoy, diferencia", difHoy);
  }
);

// Cada lunes a las 10:00 (Europe/Madrid) - despues de que llegue el correo
// del lunes, que suele ser todavia de la semana anterior -, balance de la
// semana que acaba de terminar (el lunes a las 10:00 de hoy hacia atras, 7
// dias).
exports.enviarBalanceSemanalAcopal = onSchedule(
  { schedule: "0 10 * * 1", timeZone: "Europe/Madrid" },
  async () => {
    const hoy = fechaHoyMadrid();
    const desde = sumarDiasFecha(hoy, -7);
    const hasta = sumarDiasFecha(hoy, -1);

    let snap;
    try {
      snap = await db.collection("albaranes_acopal")
        .where("fecha", ">=", desde).where("fecha", "<=", hasta).get();
    } catch (e) { console.error("enviarBalanceSemanalAcopal: consulta:", e.message); return; }

    const docs = []; snap.forEach(d => docs.push(d.data()));
    if (!docs.length) { console.log("enviarBalanceSemanalAcopal: sin albaranes esta semana, no se envia."); return; }

    const fechaDesdeFmt = new Date(desde + "T00:00:00Z").toLocaleDateString("es-ES", { timeZone: "UTC" });
    const fechaHastaFmt = new Date(hasta + "T00:00:00Z").toLocaleDateString("es-ES", { timeZone: "UTC" });
    const asunto = "Balance semanal albaranes ACOPAL — " + fechaDesdeFmt + " a " + fechaHastaFmt;
    const tabla = tablaAlbaranesAcopalHtml(docs, "Sin albaranes esta semana.");

    await enviarBalanceAcopalATodos(
      asunto,
      "Balance semanal albaranes ACOPAL",
      "Semana del " + fechaDesdeFmt + " al " + fechaHastaFmt + " — " + docs.length + " albaran(es) con aviso.",
      tabla
    );
    console.log("enviarBalanceSemanalAcopal: enviado,", docs.length, "albaranes de la semana.");
  }
);

// ── Asistente IA de almacen ──────────────────────────────────────────────
//
// Asistente personal de admin: acceso de LECTURA a cualquier coleccion de
// Firestore y al buzon de correo, y de ESCRITURA solo para mandar un mensaje
// de chat a una lanzadera o un correo - nunca puede tocar pedidos, permisos
// ni ninguna otra cosa directamente. Restringido a ADMINS_APP (un unico
// email). Necesita ANTHROPIC_API_KEY en functions/.env (igual que MS_SECRET).
//
// El propio buzon: nunca lee el cuerpo de varios correos de golpe (misma
// leccion del incidente de Caserfri) - leer_correos_recientes solo trae
// metadatos, leer_cuerpo_correo pide el cuerpo de uno solo, bajo demanda.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const COLECCIONES_IA_PERMITIDAS = [
  "pedidos_transferencia", "incidencias_transporte", "cambios_material", "cambios_mensajes",
  "reservas", "lanzaderas", "lanzaderas_log", "lanzaderas_nota", "mensajes",
  "descargas_merca", "descargas_arento", "furgoneta", "furgoneta_log",
  "recogidas_palets", "almacenes_pendientes", "albaranes_acopal", "alertas_cierre",
  "config", "permisos", "incidencias", "ubicaciones_naves", "robin_acciones_programadas"
];

// Los Timestamp de Firestore no se pueden mandar tal cual a la IA (no son
// JSON serializable de forma legible): se convierten a texto ISO.
function iaSerializar(obj) {
  const out = {};
  for (const k in obj) {
    const v = obj[k];
    out[k] = (v && typeof v.toDate === "function") ? v.toDate().toISOString() : v;
  }
  return out;
}

async function iaListarDocumentos(input) {
  const coleccion = String((input && input.coleccion) || "");
  if (!COLECCIONES_IA_PERMITIDAS.includes(coleccion)) return { error: "Coleccion no permitida: " + coleccion };
  let q = db.collection(coleccion);
  if (input && input.ordenCampo) q = q.orderBy(String(input.ordenCampo), input.ordenDireccion === "desc" ? "desc" : "asc");
  q = q.limit(Math.min(Number(input && input.limite) || 20, 50));
  const snap = await q.get();
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, ...iaSerializar(d.data()) }));
  return { docs, total: docs.length };
}

async function iaBuscarDocumentos(input) {
  const coleccion = String((input && input.coleccion) || "");
  if (!COLECCIONES_IA_PERMITIDAS.includes(coleccion)) return { error: "Coleccion no permitida: " + coleccion };
  const opsValidos = ["==", "!=", ">", "<", ">=", "<=", "array-contains", "in"];
  const operador = String((input && input.operador) || "");
  if (!opsValidos.includes(operador)) return { error: "Operador no valido: " + operador };
  if (!input || !input.campo) return { error: "Falta el campo" };
  try {
    const snap = await db.collection(coleccion)
      .where(String(input.campo), operador, input.valor)
      .limit(Math.min(Number(input.limite) || 20, 50)).get();
    const docs = [];
    snap.forEach(d => docs.push({ id: d.id, ...iaSerializar(d.data()) }));
    return { docs, total: docs.length };
  } catch (e) { return { error: e.message }; }
}

// Conversion basica de HTML a texto plano, solo para que la IA pueda leer el
// cuerpo de un correo con sentido (no hace falta preservar tablas como en el
// parser de Caserfri).
function iaHtmlATexto(html) {
  return String(html || "")
    .replace(/<(br|\/p|\/div|\/tr|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function iaLeerCorreosRecientes(input) {
  const cantidad = Math.min(Number(input && input.cantidad) || 10, 25);
  const filtro = (input && input.soloNoLeidos) ? "&$filter=isRead eq false" : "";
  const token = await obtenerTokenMS();
  const data = await graphGet(token,
    "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
    "/mailFolders/inbox/messages?$top=" + cantidad + filtro +
    "&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,hasAttachments");
  return {
    correos: (data.value || []).map(m => ({
      id: m.id,
      asunto: m.subject,
      de: m.from && m.from.emailAddress && m.from.emailAddress.address,
      recibido: m.receivedDateTime,
      leido: m.isRead,
      tieneAdjuntos: m.hasAttachments
    }))
  };
}

async function iaLeerCuerpoCorreo(input) {
  const messageId = input && input.messageId;
  if (!messageId) return { error: "Falta el messageId" };
  const token = await obtenerTokenMS();
  const detalle = await graphGet(token,
    "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + messageId + "?$select=subject,body");
  return { asunto: detalle.subject, cuerpo: iaHtmlATexto(detalle.body && detalle.body.content).slice(0, 6000) };
}

async function iaEnviarMensajeChat(input) {
  const numero = Number(input && input.lanzadera);
  if (!(numero >= 1 && numero <= 4)) return { error: "Lanzadera no valida (debe ser 1, 2, 3 o 4)" };
  const texto = String((input && input.texto) || "").trim().slice(0, 500);
  if (!texto) return { error: "Falta el texto del mensaje" };
  await db.collection("mensajes").add({
    lanzadera: numero, de: "almacen", emisor: "Robin (IA Muelles)", texto,
    ts: admin.firestore.Timestamp.now()
  });
  return { ok: true };
}

async function iaEnviarCorreo(input) {
  const destinatario = String((input && input.destinatario) || "").trim().toLowerCase();
  if (!destinatarioValido(destinatario)) return { error: "Destinatario no valido" };
  const asunto = String((input && input.asunto) || "(sin asunto)").slice(0, 200);
  const cuerpo = String((input && input.cuerpo) || "").slice(0, 5000);
  const token = await obtenerTokenMS();
  const status = await enviarConGraph(token, destinatario, asunto, null, cuerpo, null);
  return { ok: status === 200 || status === 202, status };
}

// Da estilo a una hoja recien creada con json_to_sheet: cabecera en negrita
// sobre el verde corporativo, ancho de columna segun el contenido y filtro
// automatico. Se usa tanto aqui (Robin) como en el resto de exports de
// Excel del panel (misma logica, version cliente en admin.js).
function estilizarHojaExcel(XLSX, ws, filas) {
  if (!filas.length) return;
  const columnas = Object.keys(filas[0]);
  ws["!cols"] = columnas.map(col => {
    const maxLen = filas.reduce((m, f) => Math.max(m, String(f[col] == null ? "" : f[col]).length), col.length);
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  columnas.forEach((col, i) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws[addr]) {
      ws[addr].s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { fgColor: { rgb: "D41F3A" } },
        alignment: { vertical: "center" }
      };
    }
  });
  const ultimaCol = XLSX.utils.encode_col(columnas.length - 1);
  ws["!autofilter"] = { ref: "A1:" + ultimaCol + (filas.length + 1) };
}

// Genera un Excel de verdad (con estilo, misma logica que el resto del
// panel) a partir de filas que la propia IA construye (normalmente con
// datos que ya ha sacado con listar_documentos/buscar_documentos), y lo
// manda como adjunto real.
async function iaEnviarCorreoConExcel(input) {
  const destinatario = String((input && input.destinatario) || "").trim().toLowerCase();
  if (!destinatarioValido(destinatario)) return { error: "Destinatario no valido" };

  const filas = Array.isArray(input && input.filas) ? input.filas : [];
  if (!filas.length) return { error: "Faltan filas de datos para el Excel" };
  if (filas.length > 5000) return { error: "Demasiadas filas (maximo 5000)" };

  const asunto = String((input && input.asunto) || "Informe").slice(0, 200);
  const cuerpo = String((input && input.cuerpo) || "Informe adjunto en Excel.").slice(0, 5000);
  const nombreHoja = (String((input && input.nombreHoja) || "").slice(0, 30)) || "Datos";

  let base64;
  try {
    const XLSX = require("xlsx-js-style");
    const ws = XLSX.utils.json_to_sheet(filas);
    estilizarHojaExcel(XLSX, ws, filas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nombreHoja);
    base64 = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }).toString("base64");
  } catch (e) { return { error: "No se pudo generar el Excel: " + e.message }; }
  if (base64.length > 8000000) return { error: "El Excel generado es demasiado grande para mandarlo por correo" };

  const token = await obtenerTokenMS();
  const status = await enviarConGraph(token, destinatario, asunto, null, cuerpo, null, [{
    name: "informe.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBytes: base64,
    isInline: false
  }]);
  return { ok: status === 200 || status === 202, status, filas: filas.length };
}

// En vez de ejecutar enviar_correo/enviar_mensaje_chat al momento, los deja
// en cola para dentro de un rato. ejecutarAccionesProgramadasRobin (funcion
// aparte, revisa la cola cada 5 min) es quien de verdad los ejecuta - la
// precision es de unos minutos, no exacta al segundo. Maximo una semana
// vista para no dejar cosas "programadas" para siempre sin que nadie se
// entere si algo va mal.
const IA_ACCIONES_PROGRAMABLES = ["enviar_correo", "enviar_mensaje_chat"];

async function iaProgramarAccion(input) {
  const tipo = String((input && input.tipo) || "");
  if (!IA_ACCIONES_PROGRAMABLES.includes(tipo)) {
    return { error: "Tipo de accion no valido, debe ser: " + IA_ACCIONES_PROGRAMABLES.join(" o ") };
  }
  const minutos = Number(input && input.minutosDesdeAhora);
  if (!(minutos > 0)) return { error: "Falta minutosDesdeAhora (numero de minutos desde ahora, mayor que 0)" };
  if (minutos > 7 * 24 * 60) return { error: "No se puede programar con mas de 7 dias de antelacion" };

  const parametros = (input && input.parametros) || {};
  // Misma validacion que la version inmediata, para no aceptar una accion
  // que sabemos de antemano que va a fallar dentro de un rato.
  if (tipo === "enviar_correo") {
    if (!destinatarioValido(String(parametros.destinatario || "").trim().toLowerCase())) {
      return { error: "Destinatario no valido" };
    }
  } else {
    const numero = Number(parametros.lanzadera);
    if (!(numero >= 1 && numero <= 4)) return { error: "Lanzadera no valida (debe ser 1, 2, 3 o 4)" };
  }

  const momento = admin.firestore.Timestamp.fromMillis(Date.now() + minutos * 60000);
  const ref = await db.collection("robin_acciones_programadas").add({
    tipo, parametros, momento, estado: "pendiente",
    creado: admin.firestore.Timestamp.now()
  });
  return { ok: true, id: ref.id, momento: momento.toDate().toISOString() };
}

// Ampliacion pedida explicitamente por el admin: Robin puede marcar palets
// como recogidos de un PT, pero SOLO si el usuario se lo pide en esa misma
// conversacion (nunca por iniciativa propia, igual que el resto de
// herramientas que escriben algo). Reutiliza el mismo mecanismo que el boton
// "Marcar recogido" del panel (cerrarPedidoManual): un documento en
// recogidas_palets, que el trigger restarRecogidaPalets ya sabe procesar -
// no se toca pedidos_transferencia directamente aqui.
// Consulta de solo lectura: cuanto queda pendiente de un PT concreto. Hace
// falta como herramienta aparte porque buscar_documentos no puede filtrar
// por el id del documento (el PT es el id en pedidos_transferencia), asi
// que sin esto Robin no podia responder "¿esta recogido el PT X?".
async function iaConsultarPedido(input) {
  const pt = String((input && input.pt) || "").trim();
  if (!pt) return { error: "Falta el codigo del pedido (pt)" };
  const doc = await db.collection("pedidos_transferencia").doc(pt).get();
  if (!doc.exists) return { error: "No existe ningun pedido con el codigo " + pt };
  const d = doc.data();
  const pendiente = Math.max((d.palets || 0) - (d.recogido || 0), 0);

  // Quien y cuando lo ha recogido (no solo el total): cada recogida real
  // lleva su numero de lanzadera (0 = marcado a mano desde el panel/Robin,
  // no un chofer) y su hora, dentro de "pts".
  const recogidas = [];
  try {
    const recogSnap = await db.collection("recogidas_palets")
      .where("almacen", "==", d.almacen).orderBy("ts", "desc").limit(200).get();
    recogSnap.forEach(rd => {
      const r = rd.data();
      (r.pts || []).forEach(item => {
        if (item.pt !== pt) return;
        const local = r.ts ? r.ts.toDate().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" }) : null;
        recogidas.push({
          lanzadera: r.numero > 0 ? r.numero : null,
          marcadoAMano: !r.numero || r.numero === 0,
          palets: item.palets,
          fecha: local ? local.split(" ")[0] : null,
          hora: local ? local.split(" ")[1].slice(0, 5) : null
        });
      });
    });
  } catch (e) { console.error("iaConsultarPedido: recogidas:", e.message); }

  return {
    pt, almacen: d.almacen,
    palets: d.palets || 0, recogido: d.recogido || 0, pendiente,
    estado: pendiente <= 0 ? "recogido" : "pendiente",
    cerrado: !!d.cerrado,
    recogidas
  };
}

// Busca el pedido mas reciente (ultimos 30 dias) que incluya una referencia
// de envase concreta (ej: "999979", IFCO 6420) en su desglose de lineas, y
// da el estado de ESE PEDIDO completo. No se puede saber con precision si
// esa referencia en concreto ya se recogio cuando el pedido se ha recogido
// solo a medias, porque el chofer solo registra un total de palets al
// recoger, no un desglose por referencia - se avisa de esa limitacion en la
// respuesta para que Robin se lo explique asi al usuario si hace falta.
async function iaConsultarReferenciaEnvase(input) {
  const ref = String((input && input.ref) || "").trim();
  if (!ref) return { error: "Falta la referencia del envase" };

  // Solo los pedidos de HOY (por su fecha de recogida, no de cuando se
  // creo): asi no aparecen pedidos de otros dias que solo confunden.
  const hoy = fechaHoyMadrid();
  const snap = await db.collection("pedidos_transferencia")
    .where("fecha", "==", hoy)
    .get();

  // Todos los pedidos de hoy que incluyen la referencia, no solo uno: puede
  // haber mas de un pedido el mismo dia (distintos almacenes, turnos...).
  const pedidos = [];
  snap.forEach(d => {
    const data = d.data();
    if (!Array.isArray(data.lineas)) return;
    const linea = data.lineas.find(l => String(l.ref) === ref);
    if (!linea) return;
    const pendiente = Math.max((data.palets || 0) - (data.recogido || 0), 0);
    pedidos.push({
      pt: d.id, almacen: data.almacen, fecha: data.fecha || null,
      descripcion: linea.desc, cantidadPedida: linea.cantidad,
      palets: data.palets || 0, recogido: data.recogido || 0, pendiente,
      estadoPedido: pendiente <= 0 ? "recogido" : (data.recogido > 0 ? "recogido_parcial" : "pendiente")
    });
  });
  if (!pedidos.length) return { error: "No hay ningun pedido de hoy que incluya la referencia " + ref };

  return {
    referencia: ref, pedidos,
    aviso: "Cada estado es del PEDIDO completo (no de la referencia en concreto): el sistema no distingue que " +
      "referencias se han recogido si el pedido se recogio a medias."
  };
}

async function iaMarcarRecogida(input) {
  const pt = String((input && input.pt) || "").trim();
  const palets = Number(input && input.palets);
  if (!pt) return { error: "Falta el codigo del pedido (pt)" };
  if (!(palets > 0)) return { error: "Cantidad de palets no valida" };

  const ref = db.collection("pedidos_transferencia").doc(pt);
  const doc = await ref.get();
  if (!doc.exists) return { error: "No existe ningun pedido con el codigo " + pt };
  const d = doc.data();
  if (!ALMACENES_PT.includes(d.almacen)) return { error: "Almacen no valido en ese pedido" };
  const pendiente = Math.max((d.palets || 0) - (d.recogido || 0), 0);
  if (palets > pendiente) return { error: "No puede ser mayor que lo pendiente (" + pendiente + " palets)" };

  try {
    await db.collection("recogidas_palets").add({
      numero: 0, almacen: d.almacen, palets, pts: [{ pt, palets }],
      manual: true, marcadoPor: "Robin (IA)",
      ts: admin.firestore.Timestamp.now()
    });
  } catch (e) { return { error: "No se pudo registrar: " + e.message }; }
  return { ok: true };
}

const HERRAMIENTAS_IA = [
  {
    name: "listar_documentos",
    description: "Lista documentos de una coleccion de Firestore, opcionalmente ordenados. Util para ver lo mas reciente de algo.",
    input_schema: {
      type: "object",
      properties: {
        coleccion: { type: "string", description: "Nombre exacto de la coleccion" },
        limite: { type: "number", description: "Maximo de documentos a devolver (por defecto 20, maximo 50)" },
        ordenCampo: { type: "string", description: "Campo por el que ordenar, opcional" },
        ordenDireccion: { type: "string", enum: ["asc", "desc"] }
      },
      required: ["coleccion"]
    }
  },
  {
    name: "buscar_documentos",
    description: "Busca documentos de una coleccion de Firestore que cumplan una condicion sencilla (campo, operador, valor).",
    input_schema: {
      type: "object",
      properties: {
        coleccion: { type: "string" },
        campo: { type: "string" },
        operador: { type: "string", enum: ["==", "!=", ">", "<", ">=", "<=", "array-contains", "in"] },
        valor: {},
        limite: { type: "number" }
      },
      required: ["coleccion", "campo", "operador", "valor"]
    }
  },
  {
    name: "leer_correos_recientes",
    description: "Lista los correos mas recientes del buzon de pedidos (solo metadatos: asunto, remitente, fecha - no el cuerpo).",
    input_schema: {
      type: "object",
      properties: {
        cantidad: { type: "number", description: "Cuantos correos traer (por defecto 10, maximo 25)" },
        soloNoLeidos: { type: "boolean" }
      }
    }
  },
  {
    name: "leer_cuerpo_correo",
    description: "Lee el asunto y el cuerpo completo de un correo concreto, dado su id (sacado de leer_correos_recientes).",
    input_schema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"]
    }
  },
  {
    name: "enviar_mensaje_chat",
    description: "Envia un mensaje de chat a una lanzadera (numero 1 a 4) de parte del almacen. Solo usar si el usuario lo ha pedido explicitamente.",
    input_schema: {
      type: "object",
      properties: {
        lanzadera: { type: "number", description: "Numero de lanzadera, de 1 a 4" },
        texto: { type: "string" }
      },
      required: ["lanzadera", "texto"]
    }
  },
  {
    name: "enviar_correo",
    description: "Envia un correo electronico a un destinatario. Solo usar si el usuario lo ha pedido explicitamente.",
    input_schema: {
      type: "object",
      properties: {
        destinatario: { type: "string" },
        asunto: { type: "string" },
        cuerpo: { type: "string" }
      },
      required: ["destinatario", "asunto", "cuerpo"]
    }
  },
  {
    name: "programar_accion",
    description: "Programa el envio de un correo o un mensaje de chat para dentro de un rato (en vez de mandarlo ya). Usar cuando el usuario pida algo tipo \"manda esto dentro de X minutos\" o \"mañana a tal hora\". La precision es de unos minutos, no exacta. Maximo 7 dias vista.",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["enviar_correo", "enviar_mensaje_chat"] },
        minutosDesdeAhora: { type: "number", description: "Dentro de cuantos minutos a partir de ahora hay que ejecutarlo" },
        parametros: {
          type: "object",
          description: "Para enviar_correo: {destinatario, asunto, cuerpo}. Para enviar_mensaje_chat: {lanzadera, texto}."
        }
      },
      required: ["tipo", "minutosDesdeAhora", "parametros"]
    }
  },
  {
    name: "consultar_pedido",
    description: "Consulta el estado de un pedido de transferencia (PT) por su codigo: cuantos palets tiene en total, cuantos se han recogido ya, cuantos quedan pendientes, y el detalle de cada recogida registrada (que lanzadera, fecha y hora; lanzadera null si se marco a mano desde el panel/Robin en vez de un chofer).",
    input_schema: {
      type: "object",
      properties: { pt: { type: "string", description: "Codigo del pedido, ej: PT028980" } },
      required: ["pt"]
    }
  },
  {
    name: "consultar_referencia_envase",
    description: "Busca TODOS los pedidos de HOY que incluyan una referencia de envase concreta (ej: \"999979\" = IFCO 6420) y da el estado de cada uno (recogido, pendiente o recogido a medias). Ojo: cada estado es del PEDIDO completo, no de esa referencia por separado, porque el chofer no registra el desglose por referencia al recoger.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "Codigo de referencia del envase, ej: 999979" } },
      required: ["ref"]
    }
  },
  {
    name: "marcar_recogida",
    description: "Marca palets como recogidos de un pedido (PT) concreto, si el chofer no lo ha registrado. Solo usar si el usuario lo pide explicitamente en esta conversacion, nunca por iniciativa propia.",
    input_schema: {
      type: "object",
      properties: {
        pt: { type: "string", description: "Codigo del pedido, ej: PT028980" },
        palets: { type: "number", description: "Cuantos palets marcar como recogidos" }
      },
      required: ["pt", "palets"]
    }
  },
  {
    name: "enviar_correo_con_excel",
    description: "Envia un correo con una tabla de datos adjunta como archivo Excel (.xlsx). Usar cuando el usuario pida generar/mandar un informe o listado en Excel. Construye las filas con datos reales (por ejemplo, sacados antes con listar_documentos/buscar_documentos), nunca inventados. Solo usar si el usuario lo pide explicitamente.",
    input_schema: {
      type: "object",
      properties: {
        destinatario: { type: "string" },
        asunto: { type: "string" },
        cuerpo: { type: "string", description: "Texto del cuerpo del correo (la tabla va aparte, en el adjunto)" },
        nombreHoja: { type: "string", description: "Nombre de la pestaña del Excel, opcional" },
        filas: {
          type: "array",
          description: "Cada elemento es un objeto {NombreColumna: valor}, con las mismas claves en todas las filas.",
          items: { type: "object" }
        }
      },
      required: ["destinatario", "asunto", "filas"]
    }
  },
  // Herramienta de busqueda web nativa de Anthropic: la ejecuta el propio
  // servidor de Claude, no hace falta implementar nada aqui.
  { type: "web_search_20250305", name: "web_search", max_uses: 5 }
];

async function iaEjecutarHerramienta(nombre, input) {
  switch (nombre) {
    case "listar_documentos": return iaListarDocumentos(input);
    case "buscar_documentos": return iaBuscarDocumentos(input);
    case "leer_correos_recientes": return iaLeerCorreosRecientes(input);
    case "leer_cuerpo_correo": return iaLeerCuerpoCorreo(input);
    case "enviar_mensaje_chat": return iaEnviarMensajeChat(input);
    case "enviar_correo": return iaEnviarCorreo(input);
    case "programar_accion": return iaProgramarAccion(input);
    case "consultar_pedido": return iaConsultarPedido(input);
    case "consultar_referencia_envase": return iaConsultarReferenciaEnvase(input);
    case "marcar_recogida": return iaMarcarRecogida(input);
    case "enviar_correo_con_excel": return iaEnviarCorreoConExcel(input);
    default: return { error: "Herramienta desconocida: " + nombre };
  }
}

const IA_SYSTEM_PROMPT =
  "Te llamas Robin y eres el asistente personal de almacen (y personal) de Aldelis Muelles, una empresa de " +
  "logistica de aves/alimentacion. Tienes acceso de LECTURA a cualquier coleccion de la base de datos " +
  "(listar_documentos, buscar_documentos), al buzon de correo de pedidos (leer_correos_recientes, " +
  "leer_cuerpo_correo), y a internet (web_search) para consultar cosas externas (por ejemplo, buscar empresas, " +
  "fabricantes o precios de un producto). Si te preguntan si un pedido concreto (PT) esta recogido o cuanto le " +
  "queda pendiente, usa consultar_pedido con su codigo (no busques el codigo con buscar_documentos, ese codigo " +
  "es el id del documento y esa herramienta no puede filtrar por id). Si te preguntan por una referencia de " +
  "envase concreta (ej: \"999979\", IFCO 6420) en vez de un PT, usa consultar_referencia_envase: te dira el " +
  "estado del pedido que la contiene, pero aclara siempre al usuario que es el estado del pedido completo, no " +
  "de esa referencia en particular (no se registra el desglose por referencia al recoger). Solo puedes ESCRIBIR mediante " +
  "enviar_mensaje_chat (a una lanzadera, " +
  "numero 1 a 4), enviar_correo, programar_accion (para dejar programado un envio de correo o chat para dentro " +
  "de un rato en vez de al momento), y marcar_recogida (para marcar palets recogidos de un pedido, si el " +
  "usuario lo pide), si las tienes disponibles: no puedes modificar pedidos de ninguna otra forma (no puedes " +
  "cambiar fechas, cerrar pedidos sin que se haya recogido de verdad, etc.), ni tocar permisos, configuracion " +
  "ni ninguna otra cosa directamente. Nunca debes usar enviar_mensaje_chat, enviar_correo, programar_accion o " +
  "marcar_recogida por iniciativa propia, solo cuando el usuario lo pida explicitamente en esa misma " +
  "conversacion. Si el usuario pide mandar algo \"dentro de X minutos\", \"mañana\" o en un momento futuro, usa " +
  "programar_accion en vez de enviarlo ya. Si el usuario te pide mandar algo a una persona por su nombre (no " +
  "por su email), consulta primero el documento \"contactos\" de la coleccion config (con listar_documentos) " +
  "para sacar su direccion real; si no aparece ahi, pregunta el email en vez de inventartelo. Responde en " +
  "español, de forma breve y concreta, como un asistente de confianza que conoce bien el almacen. Si necesitas " +
  "datos para responder, usa las herramientas de lectura (o de busqueda web, si es algo externo) antes de " +
  "contestar en vez de inventarte numeros.";

// Bucle de uso de herramientas compartido entre el asistente del panel
// (preguntarAsistente) y el que responde por correo (revisarCorreoAsistenteIA):
// misma "cabeza" en los dos sitios, cambia solo que herramientas se le dejan
// usar y el texto de sistema.
async function ejecutarConversacionIA(mensajeUsuario, herramientas, systemPrompt) {
  let messages = [{ role: "user", content: mensajeUsuario }];
  let respuestaFinal = "";

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: systemPrompt,
        tools: herramientas,
        messages
      })
    });
    const json = await res.json();
    if (!res.ok) {
      console.error("ejecutarConversacionIA: Anthropic error:", JSON.stringify(json));
      throw new Error((json.error && json.error.message) || "Error llamando a la IA");
    }

    messages.push({ role: "assistant", content: json.content });

    const usosHerramienta = (json.content || []).filter(b => b.type === "tool_use");
    if (!usosHerramienta.length) {
      respuestaFinal = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      break;
    }

    const resultados = [];
    for (const uso of usosHerramienta) {
      let resultado;
      try { resultado = await iaEjecutarHerramienta(uso.name, uso.input || {}); }
      catch (e) { resultado = { error: e.message }; }
      resultados.push({ type: "tool_result", tool_use_id: uso.id, content: JSON.stringify(resultado).slice(0, 8000) });
    }
    messages.push({ role: "user", content: resultados });
  }

  return respuestaFinal || "No he podido completar la respuesta (demasiados pasos, prueba con una pregunta mas concreta).";
}

exports.preguntarAsistente = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const data = esV2 ? request.data : request;
  const ctx  = esV2 ? request : (context || {});

  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!ADMINS_APP.includes(email)) return { ok: false, error: "Sin permiso" };
  if (!ANTHROPIC_API_KEY) return { ok: false, error: "Falta configurar ANTHROPIC_API_KEY en el servidor" };

  const mensaje = data && String(data.mensaje || "").trim();
  if (!mensaje) return { ok: false, error: "Falta el mensaje" };
  if (mensaje.length > 4000) return { ok: false, error: "Mensaje demasiado largo" };

  // El usuario que habla con Robin aqui SIEMPRE es este email (es el unico
  // que puede llegar a esta funcion), asi no tiene que preguntar "¿a que
  // correo?" cuando le piden mandarle algo "a mi" sin mas.
  const systemPromptConUsuario = IA_SYSTEM_PROMPT +
    " El usuario con el que hablas ahora mismo, en esta conversacion, es " + email + ". Si te pide mandarle " +
    "algo \"a mi\", \"a mi correo\" o simplemente no dice a quien, usa ese email como destinatario sin " +
    "preguntar mas.";

  try {
    const respuesta = await ejecutarConversacionIA(mensaje, HERRAMIENTAS_IA, systemPromptConUsuario);
    console.log("preguntarAsistente:", email, "->", mensaje.slice(0, 100));
    return { ok: true, respuesta };
  } catch (e) {
    console.error("preguntarAsistente:", e.message);
    return { ok: false, error: e.message };
  }
});

// ── Robin por correo: asunto "info" ─────────────────────────────────────
//
// Los mismos compañeros autorizados pueden preguntarle a Robin por correo en
// vez de entrar al panel: mandan un correo con asunto "info" (el cuerpo es
// la pregunta) al buzon de pedidos, y Robin responde al mismo correo.
//
// Funcion de lectura de correo COMPLETAMENTE APARTE de revisarCorreoPedidos,
// por la misma razon de siempre: un fallo aqui no puede bloquear la
// creacion de pedidos. Solo lee el cuerpo del correo candidato, uno a uno,
// nunca de varios de golpe. Aqui Robin NO tiene las herramientas de
// escribir chat/correo sueltas: la unica salida posible es la respuesta al
// propio correo que la disparo, para no abrir la puerta a que responda o
// escriba a cualquier otro sitio por su cuenta.
const IA_CORREO_PERMITIDOS = [
  "mlorente@aldelis.com", "dgamarra@aldelis.com", "jbotaya@aldelis.com",
  "dbotaya@aldelis.com", "jpina@aldelis.com"
];
const HERRAMIENTAS_IA_SOLO_LECTURA = HERRAMIENTAS_IA.filter(h =>
  h.name !== "enviar_mensaje_chat" && h.name !== "enviar_correo" && h.name !== "programar_accion"
  && h.name !== "marcar_recogida" && h.name !== "enviar_correo_con_excel");
const IA_CORREO_SYSTEM_PROMPT = IA_SYSTEM_PROMPT +
  " En esta conversacion en concreto no tienes herramientas para enviar nada: tu respuesta de texto ES el " +
  "correo que se va a mandar, redactala ya como el cuerpo final de un email (sin encabezados tipo \"Asunto:\").";

// Chat de lanzaderas (entre chofer y almacen): Robin solo responde si le
// mencionan por su nombre en el mensaje, para no meterse en cada mensaje
// normal ni gastar peticiones de IA sin que se lo pidan. Igual que el canal
// de correo, aqui tampoco puede escribir nada (ni correo ni chat): solo
// lectura, y su respuesta de texto es directamente el mensaje de chat.
const IA_CHAT_SYSTEM_PROMPT = IA_SYSTEM_PROMPT +
  " Te estan hablando desde el chat de una lanzadera (entre el chofer y el almacen), no desde el panel ni por " +
  "correo. Responde muy breve, como un mensaje de chat normal (pocas lineas), nada de firmas ni encabezados. " +
  "No tienes herramientas para enviar nada: tu respuesta de texto ES el mensaje que se va a mandar al chat.";

const IA_CHAT_MENCION_REGEX = /\brobin\b/i;

// Limite diario de preguntas a Robin en el chat de lanzaderas (unico canal
// abierto a cualquier chofer/almacen sin restriccion de quien puede usarlo;
// el panel es solo el admin y el correo solo 5 personas de confianza, esos
// dos no tienen limite). Configurable desde el panel (config/robin,
// limiteChatDiario). Al superarlo, Robin se queda callado en el chat (no
// gasta ni una peticion mas) y avisa por correo una sola vez al dia.
const ROBIN_CHAT_LIMITE_DEFECTO = 5;

exports.robinRespondeChat = onDocumentCreated("mensajes/{msgId}", async (event) => {
  const msg = event.data ? event.data.data() : null;
  if (!msg || !msg.texto) return;
  if (msg.emisor === "Robin (IA Muelles)") return; // evita que se responda a si mismo
  const numero = Number(msg.lanzadera);
  if (!(numero >= 1 && numero <= 4)) return;
  if (!IA_CHAT_MENCION_REGEX.test(msg.texto)) return;

  try {
    const hoy = fechaHoyMadrid();
    const usoRef = db.collection("robin_chat_uso").doc(hoy);
    const [configDoc, usoDoc] = await Promise.all([
      db.collection("config").doc("robin").get(),
      usoRef.get()
    ]);
    const limite = (configDoc.exists && Number(configDoc.data().limiteChatDiario)) || ROBIN_CHAT_LIMITE_DEFECTO;
    const contadorActual = usoDoc.exists ? (usoDoc.data().contador || 0) : 0;

    if (contadorActual >= limite) {
      if (!(usoDoc.exists && usoDoc.data().avisoEnviado)) {
        await usoRef.set({ contador: contadorActual, avisoEnviado: true, fecha: hoy }, { merge: true });
        try {
          const token = await obtenerTokenMS();
          await enviarConGraph(token, "mlorente@aldelis.com",
            "Robin: limite diario del chat alcanzado",
            null,
            "Robin ha llegado al limite de " + limite + " preguntas de hoy en el chat de lanzaderas y ha " +
            "dejado de responder ahi hasta mañana. Puedes subir el limite en Config si hace falta.",
            null);
        } catch (e) { console.error("robinRespondeChat: aviso limite:", e.message); }
      }
      return; // se queda callado, sin gastar ninguna peticion mas hoy
    }

    await usoRef.set({ contador: admin.firestore.FieldValue.increment(1), fecha: hoy }, { merge: true });

    const respuesta = await ejecutarConversacionIA(msg.texto, HERRAMIENTAS_IA_SOLO_LECTURA, IA_CHAT_SYSTEM_PROMPT);
    await db.collection("mensajes").add({
      lanzadera: numero, de: "almacen", emisor: "Robin (IA Muelles)", texto: respuesta.slice(0, 500),
      ts: admin.firestore.Timestamp.now()
    });
  } catch (e) { console.error("robinRespondeChat:", e.message); }
});

async function graphResponderCorreo(token, msgId, textoRespuesta) {
  await fetch("https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msgId + "/reply", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ comment: textoRespuesta })
  });
}

exports.revisarCorreoAsistenteIA = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Europe/Madrid" },
  async () => {
    if (!MS_SECRET) { console.warn("revisarCorreoAsistenteIA: falta MS_SECRET"); return; }
    if (!ANTHROPIC_API_KEY) { console.warn("revisarCorreoAsistenteIA: falta ANTHROPIC_API_KEY"); return; }

    let token;
    try { token = await obtenerTokenMS(); }
    catch (e) { console.error("revisarCorreoAsistenteIA: token:", e.message); return; }

    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25" +
        "&$select=id,subject,from,receivedDateTime");
    } catch (e) { console.error("revisarCorreoAsistenteIA: listar mensajes:", e.message); return; }

    const candidatos = (data.value || []).filter(msg => {
      const asunto = (msg.subject || "").trim().toLowerCase();
      const remitente = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address || "").toLowerCase();
      return asunto === "info" && IA_CORREO_PERMITIDOS.includes(remitente);
    });
    console.log("revisarCorreoAsistenteIA: " + candidatos.length + " correo(s) para Robin de "
      + (data.value || []).length + " no leido(s).");

    for (const msg of candidatos) {
      try {
        const detalle = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "?$select=body");
        const pregunta = iaHtmlATexto(detalle.body && detalle.body.content).slice(0, 4000);
        if (!pregunta) {
          console.log("revisarCorreoAsistenteIA: correo de", msg.from.emailAddress.address, "sin texto util, se ignora.");
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        const respuesta = await ejecutarConversacionIA(pregunta, HERRAMIENTAS_IA_SOLO_LECTURA, IA_CORREO_SYSTEM_PROMPT);
        await graphResponderCorreo(token, msg.id, respuesta);
        await graphMarcarLeido(token, msg.id);
        console.log("revisarCorreoAsistenteIA: respondido a", msg.from.emailAddress.address);
      } catch (e) {
        console.error("revisarCorreoAsistenteIA: mensaje", msg.id, e.message);
      }
    }
  }
);

// Extraccion de albaranes (ruta Usieto): el ERP manda cada albaran por
// correo a este mismo buzon con asunto "Albaran: <codigo>" (ej: "Albaran:
// AV26/052595"). Cuando alguien de un dominio de confianza pide
// "extraer <codigo>", se busca ese correo y se reenvia tal cual (con sus
// adjuntos originales) a quien lo pidio.
// Funcion COMPLETAMENTE APARTE de revisarCorreoPedidos y de
// revisarCorreoAsistenteIA (aprendido a base de sustos: un bug aqui nunca
// debe poder bloquear el procesado de pedidos ni las respuestas de Robin).
const DOMINIOS_EXTRAER_ALBARAN = ["aldelis.com", "grupousieto.com", "padesa.es", "kovo.es", "innovalogic.es"];

function remitenteAutorizadoExtraerAlbaran(email) {
  const e = String(email || "").toLowerCase();
  return DOMINIOS_EXTRAER_ALBARAN.some(dom => e.endsWith("@" + dom));
}

// Saca el codigo de un asunto tipo "extraer AV26/052595" o "Extraer: AV26/052595".
function extraerCodigoAlbaran(asunto) {
  return String(asunto || "")
    .replace(/^\s*extraer\s*:?\s*/i, "")
    .trim();
}

// Saca el codigo de un asunto "Albaran: AV26/052595" (o "Albaran AV26/052595").
function codigoDeAsuntoAlbaran(asunto) {
  return String(asunto || "")
    .replace(/^\s*albaran\s*:?\s*/i, "")
    .trim();
}

// Compara codigos de albaran ignorando ceros a la izquierda en cada tramo
// numerico (AV26/52646 y AV26/052646 son el mismo albaran, es habitual que
// quien pide la extraccion se salte un cero). El resto (letras) se compara
// sin distinguir mayusculas.
function normalizarCodigoAlbaran(codigo) {
  return String(codigo || "")
    .trim()
    .split("/")
    .map(seg => /^\d+$/.test(seg) ? String(Number(seg)) : seg.toUpperCase())
    .join("/");
}

async function graphReenviarCorreo(token, msgId, destinatario, comentario) {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msgId + "/forward",
    {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        comment: comentario || "",
        toRecipients: [{ emailAddress: { address: destinatario } }]
      })
    }
  );
  return res.status;
}

exports.revisarCorreoExtraerAlbaran = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Europe/Madrid" },
  async () => {
    let token;
    try { token = await obtenerTokenMS(); }
    catch (e) { console.error("revisarCorreoExtraerAlbaran: token:", e.message); return; }

    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=isRead eq false&$top=25" +
        "&$select=id,subject,from,receivedDateTime");
    } catch (e) { console.error("revisarCorreoExtraerAlbaran: listar mensajes:", e.message); return; }

    const candidatos = (data.value || []).filter(msg => {
      const asunto = (msg.subject || "").trim().toLowerCase();
      const remitente = (msg.from && msg.from.emailAddress && msg.from.emailAddress.address || "");
      return asunto.startsWith("extraer") && remitenteAutorizadoExtraerAlbaran(remitente);
    });
    if (!candidatos.length) return;
    console.log("revisarCorreoExtraerAlbaran: " + candidatos.length + " peticion(es) de extraccion.");

    for (const msg of candidatos) {
      const remitente = msg.from.emailAddress.address;

      // Guarda de idempotencia: marcar como "leido" en Graph no siempre es
      // fiable del todo (puede no llegar a persistir, o el correo puede
      // volver a marcarse como no leido por el propio cliente de correo),
      // asi que sin esto la misma peticion se procesaba de nuevo cada 10
      // minutos mientras siguiera apareciendo como no leida. El "create"
      // falla si ya existe, asi que cada mensaje se atiende una sola vez.
      const procesadoRef = db.collection("extracciones_albaran_procesadas").doc(msg.id);
      try {
        await procesadoRef.create({ ts: admin.firestore.Timestamp.now() });
      } catch (e) {
        if (e.code === 6 /* ALREADY_EXISTS */) {
          console.log("revisarCorreoExtraerAlbaran: mensaje", msg.id, "ya atendido antes, se ignora.");
          continue;
        }
        console.error("revisarCorreoExtraerAlbaran: guarda de idempotencia:", e.message);
        continue;
      }

      try {
        const codigo = extraerCodigoAlbaran(msg.subject);
        if (!codigo) {
          await graphResponderCorreo(token, msg.id, "No he encontrado ningun codigo de albaran en el asunto. Usa el formato \"extraer <codigo>\", ej: extraer AV26/052595.");
          await graphMarcarLeido(token, msg.id);
          continue;
        }

        // Se busca por prefijo (la parte no numerica del primer tramo, ej
        // "AV" de "AV26/52646") y se compara el codigo completo ignorando
        // ceros a la izquierda, en vez de una igualdad exacta de texto: es
        // habitual pedir el codigo sin algun cero que si lleva el asunto
        // real (AV26/52646 vs AV26/052646 es el mismo albaran).
        const codigoNorm = normalizarCodigoAlbaran(codigo);
        const prefijoAlfa = codigo.split("/")[0].replace(/[0-9]+$/, "");
        const filtro = "startswith(subject,'" + ("Albaran: " + prefijoAlfa).replace(/'/g, "''") + "')";
        const busqueda = await graphGet(token,
          "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
          "/mailFolders/inbox/messages?$filter=" + encodeURIComponent(filtro) +
          "&$top=25&$select=id,subject,receivedDateTime");

        const encontrados = (busqueda.value || [])
          .filter(m => normalizarCodigoAlbaran(codigoDeAsuntoAlbaran(m.subject)) === codigoNorm)
          .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
        const encontrado = encontrados.length > 0;

        if (!encontrado) {
          await graphResponderCorreo(token, msg.id, "No encuentro ningun albaran con el codigo \"" + codigo + "\" en este buzon.");
        } else {
          await graphReenviarCorreo(token, encontrados[0].id, remitente,
            "Reenviado a peticion de " + remitente + ".");
        }
        await graphMarcarLeido(token, msg.id);

        try {
          await db.collection("extracciones_albaran").add({
            fecha: fechaHoyMadrid(), codigo, solicitante: remitente, encontrado,
            ts: admin.firestore.Timestamp.now()
          });
        } catch (e) { console.error("revisarCorreoExtraerAlbaran: guardar registro:", e.message); }

        console.log("revisarCorreoExtraerAlbaran: peticion de", remitente, "codigo", codigo, encontrado ? "reenviado" : "no encontrado");
      } catch (e) {
        console.error("revisarCorreoExtraerAlbaran: mensaje", msg.id, e.message);
      }
    }
  }
);

// Informe diario de extracciones de albaran, solo si ha habido alguna en el
// dia (si no, no se manda correo vacio). Va a mlorente y a Daniel, los dos
// como destinatarios.
const EXTRACCIONES_INFORME_DESTINATARIOS = ["mlorente@aldelis.com", "dgamarra@aldelis.com"];

function htmlInformeExtraccionesAlbaran(fecha, extracciones) {
  const filas = extracciones.map(e => {
    const hora = e.ts && e.ts.toDate ? e.ts.toDate().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }) : "";
    return "<tr>" +
      "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + hora + "</td>" +
      "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + esc(e.solicitante) + "</td>" +
      "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + esc(e.codigo) + "</td>" +
      "<td style='padding:6px 10px;border-bottom:1px solid #eee'>" + (e.encontrado ? "Reenviado" : "No encontrado") + "</td>" +
      "</tr>";
  }).join("");
  return "<html><body style='font-family:Arial,sans-serif;font-size:13px;color:#1A1A1A'>" +
    "<p>Extracciones de albaran del " + formatoFechaEs(fecha) + " (" + extracciones.length + " en total)</p>" +
    "<table style='border-collapse:collapse;width:100%;max-width:600px'>" +
    "<thead><tr style='background:#F5F5F5;text-align:left'>" +
    "<th style='padding:6px 10px'>Hora</th><th style='padding:6px 10px'>Solicitante</th>" +
    "<th style='padding:6px 10px'>Codigo</th><th style='padding:6px 10px'>Resultado</th></tr></thead>" +
    "<tbody>" + filas + "</tbody></table>" +
    "</body></html>";
}

exports.enviarInformeExtraccionesAlbaran = onSchedule(
  { schedule: "0 23 * * *", timeZone: "Europe/Madrid" },
  async () => {
    const hoy = fechaHoyMadrid();
    let snap;
    try {
      snap = await db.collection("extracciones_albaran").where("fecha", "==", hoy).get();
    } catch (e) { console.error("enviarInformeExtraccionesAlbaran: consulta:", e.message); return; }
    if (snap.empty) return; // sin extracciones hoy, no se manda nada

    const extracciones = [];
    snap.forEach(d => extracciones.push(d.data()));
    extracciones.sort((a, b) => (a.ts ? a.ts.toMillis() : 0) - (b.ts ? b.ts.toMillis() : 0));

    const html = htmlInformeExtraccionesAlbaran(hoy, extracciones);
    const token = await obtenerTokenMS();
    for (const destino of EXTRACCIONES_INFORME_DESTINATARIOS) {
      try {
        await enviarConGraph(token, destino, "Extracciones de albaran " + formatoFechaEs(hoy), html, null, null);
      } catch (e) { console.error("enviarInformeExtraccionesAlbaran: envio a", destino, e.message); }
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// MODULO DE COMPRAS — BANDEJAS
// ═══════════════════════════════════════════════════════════════════════
// Modulo totalmente independiente (no comparte nada con revisarCorreoPedidos
// ni con ningun otro flujo de correo): calcula, para cada referencia de
// bandeja, cuantos palets pedir al proveedor a partir del consumo diario
// medio (CDM) real, el stock disponible y el plazo de entrega, comparado
// contra el pedido estandar de esa referencia. Portado de un app.py
// (Streamlit) ya existente, con la misma logica de calculo.
//
// El maestro (referencias, lead time, stock de seguridad, unidades por
// palet, incremento por ofertas, situacion) se gestiona a mano desde el
// panel (ver firestore.rules: compras_bandejas_maestro, escritura directa
// del cliente). El resto de ficheros llegan por correo a este mismo buzon
// (reservas@aldelis.com) con un asunto fijo, y se procesan cada hora:
//   "Stock bandejas"             -> compras_bandejas_stock
//   "Consumos bandejas"          -> compras_bandejas_consumos (1 vez/dia)
//   "Transito bandejas 1"        -> compras_bandejas_transito (campo porTipo.1)
//   "Transito bandejas 2"        -> compras_bandejas_transito (campo porTipo.2)
//   "Pedido base bandejas"       -> compras_bandejas_pedido_base
//   "Planificacion bandejas"     -> compras_bandejas_planificacion (opcional)
// El numero de transito no esta limitado a 1 y 2: cualquier asunto
// "Transito bandejas N" se acepta y se guarda en porTipo.N, para poder
// añadir un tercero el dia que haga falta sin tocar codigo.

const COMPRAS_ALMACENES_INT      = ["AL6", "AL6SGA", "AL6 SGA"];
const COMPRAS_ALMACENES_MERCA    = ["ARENTO", "ARENTO CAM1", "ARENTO CAM2", "CAMARA BANDEJAS F19"];
const COMPRAS_ALMACENES_TXT      = ["TXT"];
const COMPRAS_ALMACENES_AVITRANS = ["AVITRANS"];

// Header en la primera fila que tenga algun texto (igual que el app.py
// original: los ficheros del ERP a veces traen 1-3 filas de cabecera antes
// de la tabla real).
function leerExcelConHeaderAuto(buffer) {
  const XLSX = require("xlsx-js-style");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const idxHeader = filas.findIndex(f => Array.isArray(f) && f.some(c => typeof c === "string" && c.trim()));
  if (idxHeader === -1) return [];
  const headers = filas[idxHeader].map(h => String(h == null ? "" : h).trim());
  const datos = [];
  for (let i = idxHeader + 1; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.every(c => c == null || c === "")) continue;
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = fila[j]; });
    datos.push(obj);
  }
  return datos;
}

// Normaliza una fila a claves canonicas segun un mapa de alias (clave del
// alias en minusculas, sin acentos ni espacios de mas -> nombre canonico).
// Tolera variantes de nombre de columna entre exportaciones del ERP.
function normalizarFilaCompras(fila, alias) {
  const out = {};
  for (const k in fila) {
    const norm = String(k).trim().toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
    const canon = alias[norm];
    if (canon) out[canon] = fila[k];
  }
  return out;
}

const COMPRAS_ALIAS_STOCK = {
  "referencia": "Referencia", "almacen": "Almacen", "ubicacion": "Almacen", "cantidad": "Cantidad"
};
const COMPRAS_ALIAS_CONSUMOS = {
  "referencia": "Referencia", "fecha": "Fecha", "cantidad": "Cantidad",
  "origen": "Origen", "destino": "Destino"
};

// Todas las ubicaciones que son "almacen" de verdad (Plaza/Merca/Txt/
// Avitrans, cualquier camara): un movimiento hacia una de estas no es
// consumo, es solo un traslado entre almacenes (ej. AL6 -> ARENTO CAM1).
// Solo cuenta como consumo real si el Destino NO esta en este conjunto
// (una sala de produccion, un cliente, etc).
const COMPRAS_TODAS_UBICACIONES_ALMACEN = new Set([
  ...COMPRAS_ALMACENES_INT, ...COMPRAS_ALMACENES_MERCA,
  ...COMPRAS_ALMACENES_TXT, ...COMPRAS_ALMACENES_AVITRANS,
  "TRANSITO" // movimiento a transito antes de recepcionar, tampoco es consumo
]);
const COMPRAS_ALIAS_TRANSITO = {
  "cod": "Referencia", "codigo": "Referencia", "articulo": "Referencia", "art": "Referencia",
  "ref": "Referencia", "referencia": "Referencia",
  "cantidad": "Cantidad", "unidades": "Cantidad", "pedido": "Cantidad"
};
const COMPRAS_ALIAS_PEDIDO_BASE = {
  "ref.": "Referencia", "ref": "Referencia", "referencia": "Referencia",
  "box base": "Box_base", "box_base": "Box_base",
  "ud/palet": "Ud_palet", "ud_palet": "Ud_palet",
  "descripcion": "Descripcion"
};

function normalizarFilaPlanificacion(fila) {
  const out = {};
  for (const k in fila) {
    const norm = String(k).trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (norm.includes("cod")) out.Codigo = fila[k];
    else if (norm.includes("apro") || norm.includes("unidad") || norm.includes("cant")) out.Apro = fila[k];
  }
  return out;
}

// Aplica una lista de operaciones {type:'set'|'delete', ref, data?} en
// lotes de 400 (limite real de Firestore: 500 por batch).
async function commitEnLotesCompras(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => {
      if (op.type === "set") batch.set(op.ref, op.data);
      else batch.delete(op.ref);
    });
    await batch.commit();
  }
}

// Reemplaza por completo una coleccion (cada fichero que llega es una foto
// actual, no un incremento): borra los documentos que ya no aparecen en el
// fichero nuevo y escribe/actualiza el resto.
async function reemplazarColeccionCompras(coleccion, filas, idFn, dataFn) {
  const existentes = await db.collection(coleccion).get();
  const idsNuevos = new Set(filas.map(idFn));
  const ops = [];
  existentes.forEach(doc => { if (!idsNuevos.has(doc.id)) ops.push({ type: "delete", ref: doc.ref }); });
  filas.forEach(f => ops.push({ type: "set", ref: db.collection(coleccion).doc(idFn(f)), data: dataFn(f) }));
  await commitEnLotesCompras(ops);
  return filas.length;
}

async function procesarComprasStock(buffer) {
  const filas = leerExcelConHeaderAuto(buffer).map(f => normalizarFilaCompras(f, COMPRAS_ALIAS_STOCK));
  const porReferencia = {};
  filas.forEach(f => {
    const ref = String(f.Referencia || "").trim().toUpperCase();
    const almacen = String(f.Almacen || "").replace(/\s+/g, " ").trim().toUpperCase();
    const cantidad = Number(f.Cantidad) || 0;
    if (!ref || !almacen) return;
    if (!porReferencia[ref]) porReferencia[ref] = { interno: 0, merca: 0, txt: 0, avitrans: 0 };
    if (COMPRAS_ALMACENES_INT.includes(almacen)) porReferencia[ref].interno += cantidad;
    else if (COMPRAS_ALMACENES_MERCA.includes(almacen)) porReferencia[ref].merca += cantidad;
    else if (COMPRAS_ALMACENES_TXT.includes(almacen)) porReferencia[ref].txt += cantidad;
    else if (COMPRAS_ALMACENES_AVITRANS.includes(almacen)) porReferencia[ref].avitrans += cantidad;
    // almacenes fuera de estos 4 grupos se descartan, igual que el app.py original
  });
  const lista = Object.entries(porReferencia).map(([ref, v]) => ({ ref, ...v }));
  return reemplazarColeccionCompras("compras_bandejas_stock", lista,
    f => f.ref,
    f => ({ stockInterno: f.interno, stockMerca: f.merca, stockTxt: f.txt, stockAvitrans: f.avitrans, actualizado: admin.firestore.Timestamp.now() }));
}

async function procesarComprasTransito(buffer, tipo) {
  const filas = leerExcelConHeaderAuto(buffer).map(f => normalizarFilaCompras(f, COMPRAS_ALIAS_TRANSITO));
  const porReferencia = {};
  filas.forEach(f => {
    const ref = String(f.Referencia || "").trim().toUpperCase();
    const cantidad = Number(f.Cantidad) || 0;
    if (!ref) return;
    porReferencia[ref] = (porReferencia[ref] || 0) + cantidad;
  });

  // Solo se toca el campo de ESTE tipo de transito (porTipo.<tipo>): a las
  // referencias que ya no aparecen en el fichero nuevo se les pone a 0 (no
  // se borra el documento entero, puede tener otros tipos de transito).
  const existentes = await db.collection("compras_bandejas_transito").get();
  const idsConDatos = new Set(Object.keys(porReferencia));
  const ops = [];
  existentes.forEach(doc => {
    const d = doc.data();
    if (!idsConDatos.has(doc.id) && d.porTipo && d.porTipo[tipo]) {
      ops.push({ type: "set", ref: doc.ref, data: { ["porTipo." + tipo]: admin.firestore.FieldValue.delete(), actualizado: admin.firestore.Timestamp.now() } });
    }
  });
  Object.entries(porReferencia).forEach(([ref, cantidad]) => {
    ops.push({
      type: "set",
      ref: db.collection("compras_bandejas_transito").doc(ref),
      data: { ["porTipo." + tipo]: cantidad, actualizado: admin.firestore.Timestamp.now() }
    });
  });
  // FieldValue.delete()/dotted-path solo funciona con merge (update-like);
  // aqui se usa set con la clave "porTipo.N" literal + merge para que
  // Firestore lo interprete como un campo anidado, no una clave con puntos.
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach(op => batch.set(op.ref, op.data, { merge: true }));
    await batch.commit();
  }
  return Object.keys(porReferencia).length;
}

async function procesarComprasPedidoBase(buffer) {
  const filas = leerExcelConHeaderAuto(buffer).map(f => normalizarFilaCompras(f, COMPRAS_ALIAS_PEDIDO_BASE));
  const lista = filas
    .map(f => ({ ref: String(f.Referencia || "").trim().toUpperCase(), boxBase: Number(f.Box_base) || 0, descripcion: f.Descripcion || "" }))
    .filter(f => f.ref);
  return reemplazarColeccionCompras("compras_bandejas_pedido_base", lista,
    f => f.ref,
    f => ({ boxBase: f.boxBase, descripcion: f.descripcion, actualizado: admin.firestore.Timestamp.now() }));
}

async function procesarComprasPlanificacion(buffer) {
  const filas = leerExcelConHeaderAuto(buffer).map(normalizarFilaPlanificacion);
  const porReferencia = {};
  filas.forEach(f => {
    const ref = String(f.Codigo || "").trim().toUpperCase();
    const apro = Number(f.Apro) || 0;
    if (!ref) return;
    porReferencia[ref] = (porReferencia[ref] || 0) + apro;
  });
  const lista = Object.entries(porReferencia).map(([ref, apro]) => ({ ref, apro }));
  return reemplazarColeccionCompras("compras_bandejas_planificacion", lista,
    f => f.ref,
    f => ({ apro: f.apro, actualizado: admin.firestore.Timestamp.now() }));
}

async function procesarComprasConsumos(buffer) {
  const filas = leerExcelConHeaderAuto(buffer).map(f => normalizarFilaCompras(f, COMPRAS_ALIAS_CONSUMOS));
  const porClave = {};
  filas.forEach(f => {
    const ref = String(f.Referencia || "").trim().toUpperCase();
    if (!ref || !f.Fecha) return;

    // Solo cuenta como consumo real si el destino NO es otro almacen (Plaza/
    // Merca/Txt/Avitrans): un movimiento entre almacenes (ej. AL6 -> ARENTO
    // CAM1) es un traslado, no consumo, aunque tambien tenga Cantidad.
    if (f.Destino) {
      const destino = String(f.Destino).replace(/\s+/g, " ").trim().toUpperCase();
      if (COMPRAS_TODAS_UBICACIONES_ALMACEN.has(destino)) return;
    }

    let fecha;
    if (f.Fecha instanceof Date) fecha = f.Fecha.toISOString().slice(0, 10);
    else if (typeof f.Fecha === "number") fecha = new Date(Date.UTC(1899, 11, 30) + f.Fecha * 86400000).toISOString().slice(0, 10);
    else fecha = String(f.Fecha).slice(0, 10);
    const cantidad = Math.abs(Number(f.Cantidad) || 0);
    const clave = ref + "_" + fecha;
    if (!porClave[clave]) porClave[clave] = { ref, fecha, cantidad: 0 };
    porClave[clave].cantidad += cantidad;
  });
  const ops = Object.values(porClave).map(f => ({
    type: "set",
    ref: db.collection("compras_bandejas_consumos").doc(f.ref + "_" + f.fecha),
    data: { referencia: f.ref, fecha: f.fecha, cantidad: f.cantidad, actualizado: admin.firestore.Timestamp.now() }
  }));
  await commitEnLotesCompras(ops);
  return Object.keys(porClave).length;
}

const COMPRAS_TIPOS_CORREO = [
  { regex: /^stock bandejas$/i, tipo: "stock", procesar: procesarComprasStock },
  // El ERP lo manda como "Informe Movimientos Bandejas <fecha>" (la fecha
  // cambia cada dia), no con un asunto fijo como el resto.
  { regex: /^informe movimientos bandejas\b/i, tipo: "consumos", procesar: procesarComprasConsumos },
  { regex: /^transito bandejas (\d+)$/i, tipo: "transito", procesar: null }, // usa el grupo capturado como numero
  { regex: /^pedido base bandejas$/i, tipo: "pedido_base", procesar: procesarComprasPedidoBase },
  { regex: /^planificacion bandejas$/i, tipo: "planificacion", procesar: procesarComprasPlanificacion }
];

// Logica compartida por las dos revisiones (consumos aparte del resto, ver
// mas abajo): cada una solo mira los tipos de fichero de "tiposPermitidos".
// Filtro OData de asunto para cada tipo de fichero (subject exacto para los
// fijos, startswith para los que llevan fecha/numero variable detras).
function comprasFiltroAsunto(tipo) {
  if (tipo === "transito") return "startswith(subject,'Transito bandejas')";
  if (tipo === "consumos") return "startswith(subject,'Informe Movimientos Bandejas')";
  const asuntoExacto = { stock: "Stock bandejas", pedido_base: "Pedido base bandejas", planificacion: "Planificacion bandejas" }[tipo];
  return "subject eq '" + asuntoExacto + "'";
}

async function revisarCorreoComprasBandejasTipos(nombreFuncion, tiposPermitidos) {
  let token;
  try { token = await obtenerTokenMS(); }
  catch (e) { console.error(nombreFuncion + ": token:", e.message); return { error: "token: " + e.message }; }

  // Busqueda por asunto especifico (server-side), no "los 25 no leidos mas
  // recientes en general": este buzon comparte mucho trafico con pedidos,
  // incidencias y ACOPAL, asi que con solo isRead=false el correo que
  // buscamos podia quedar fuera del limite de 25 sin que hubiera fallado
  // nada - simplemente habia mas de 25 OTROS correos sin leer por delante.
  const candidatos = []; // { msg, conf, tipoTransito }
  const tiposUnicos = [...new Set(tiposPermitidos)];
  for (const tipo of tiposUnicos) {
    const conf = COMPRAS_TIPOS_CORREO.find(c => c.tipo === tipo);
    if (!conf) continue;
    const filtro = "isRead eq false and " + comprasFiltroAsunto(tipo);
    let data;
    try {
      data = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS +
        "/mailFolders/inbox/messages?$filter=" + encodeURIComponent(filtro) +
        "&$top=25&$select=id,subject,hasAttachments,from,receivedDateTime");
    } catch (e) {
      console.error(nombreFuncion + ": listar (" + tipo + "):", e.message);
      continue;
    }
    (data.value || []).forEach(msg => {
      const asunto = (msg.subject || "").trim();
      const m = asunto.match(conf.regex);
      if (!m) return; // el startswith de Graph es mas laxo que el regex exacto
      candidatos.push({ msg, conf, tipoTransito: tipo === "transito" ? m[1] : null });
    });
  }

  console.log(nombreFuncion + ": " + candidatos.length + " correo(s) candidato(s) de los tipos " + tiposUnicos.join(", ") + ".");

  const procesados = [];
  for (const { msg, conf, tipoTransito } of candidatos) {
    const asunto = (msg.subject || "").trim();
    if (!msg.hasAttachments) {
      await graphMarcarLeido(token, msg.id);
      procesados.push({ asunto, resultado: "sin adjunto, descartado" });
      continue;
    }

    // Idempotencia por mensaje: el "leido" de Graph no es del todo fiable
    // (visto en produccion con la extraccion de albaran), asi que se usa
    // el mismo mecanismo de guarda con create().
    const procesadoRef = db.collection("compras_bandejas_correos_procesados").doc(msg.id);
    try {
      await procesadoRef.create({ ts: admin.firestore.Timestamp.now() });
    } catch (e) {
      if (e.code === 6) { procesados.push({ asunto, resultado: "ya atendido antes" }); continue; }
      console.error(nombreFuncion + ": guarda de idempotencia:", e.message);
      procesados.push({ asunto, resultado: "error de idempotencia: " + e.message });
      continue;
    }

    try {
      const adjuntos = await graphGet(token,
        "https://graph.microsoft.com/v1.0/users/" + BUZON_PEDIDOS + "/messages/" + msg.id + "/attachments");
      const excel = (adjuntos.value || []).find(a => a.contentBytes && /\.xlsx?$/i.test(a.name || ""));
      if (!excel) {
        console.log(nombreFuncion + ": sin excel adjunto en", asunto);
        await graphMarcarLeido(token, msg.id);
        procesados.push({ asunto, resultado: "adjuntos sin excel valido" });
        continue;
      }
      const buffer = Buffer.from(excel.contentBytes, "base64");
      const n = conf.tipo === "transito"
        ? await procesarComprasTransito(buffer, tipoTransito)
        : await conf.procesar(buffer);
      console.log(nombreFuncion + ":", asunto, "->", n, "referencia(s) actualizada(s).");
      await graphMarcarLeido(token, msg.id);
      procesados.push({ asunto, resultado: n + " referencia(s) actualizada(s)" });
    } catch (e) {
      console.error(nombreFuncion + ": mensaje", msg.id, asunto, e.message);
      procesados.push({ asunto, resultado: "error: " + e.message });
    }
  }
  return { asuntosNoLeidos: candidatos.map(c => (c.msg.subject || "").trim()), procesados };
}

// Consumos llega 1 vez al dia a las 10:00 -> se revisa 1 vez al dia a las
// 11:00 (margen de sobra), aparte del resto de ficheros.
exports.revisarCorreoComprasBandejasConsumos = onSchedule(
  { schedule: "0 11 * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoComprasBandejasTipos("revisarCorreoComprasBandejasConsumos", ["consumos"])
);

// Stock, transito, pedido base y planificacion: cada hora en punto.
exports.revisarCorreoComprasBandejas = onSchedule(
  { schedule: "0 * * * *", timeZone: "Europe/Madrid" },
  () => revisarCorreoComprasBandejasTipos("revisarCorreoComprasBandejas", ["stock", "transito", "pedido_base", "planificacion"])
);

// Boton "Probar ahora" del panel: dispara la revision de los 5 tipos al
// momento (no espera a la hora programada) y devuelve el resultado a la
// pantalla, para no depender de mirar logs por consola.
exports.probarRevisarCorreoComprasBandejas = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccionEstricto(email, "compras"))) return { ok: false, error: "Sin permiso" };

  try {
    const resultado = await revisarCorreoComprasBandejasTipos("probarRevisarCorreoComprasBandejas",
      ["stock", "consumos", "transito", "pedido_base", "planificacion"]);
    if (resultado && resultado.error) return { ok: false, error: resultado.error };
    return { ok: true, asuntosNoLeidos: resultado.asuntosNoLeidos, procesados: resultado.procesados };
  } catch (e) {
    console.error("probarRevisarCorreoComprasBandejas:", e.message);
    return { ok: false, error: e.message };
  }
});

// Calculo del pedido (callable, se ejecuta al abrir el dashboard del panel,
// no en cada sincronizacion): misma formula que el app.py original.
//   - CDM: media de palets/dia sobre los ultimos 30 dias laborables CON
//     movimiento (los dias sin consumo no cuentan como 0, no entran en la
//     media). No excluye periodos de oferta (el maestro de esta primera
//     version no tiene esos campos) - se puede añadir mas adelante.
//   - Var_CDM: variacion % del ultimo dia con consumo frente al CDM.
//   - Pedido = max(formula con CDM ajustado por Var_CDM, formula con CDM
//     normal, 0); multiplicador 1.5 si CDM<5 pal/dia; bloqueado (Pedido=0)
//     si CDM<=0 o Situacion=='BAJA'.
//   - Ajuste = Pedido - Box_base (pedido estandar de esa referencia).
//   - Variante "por prevision" si hay planificacion cargada para la ref.
async function calcularTodoPedidoBandejas() {
  const hoy = new Date();
  const hace30dias = new Date(hoy.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fechaCorte = hace30dias.toISOString().slice(0, 10);

  const [maestroSnap, stockSnap, transitoSnap, pedidoBaseSnap, planifSnap, consumosSnap] = await Promise.all([
    db.collection("compras_bandejas_maestro").get(),
    db.collection("compras_bandejas_stock").get(),
    db.collection("compras_bandejas_transito").get(),
    db.collection("compras_bandejas_pedido_base").get(),
    db.collection("compras_bandejas_planificacion").get(),
    db.collection("compras_bandejas_consumos").where("fecha", ">=", fechaCorte).get()
  ]);

  const stockPorRef = {}; stockSnap.forEach(d => stockPorRef[d.id] = d.data());
  const transitoPorRef = {}; transitoSnap.forEach(d => transitoPorRef[d.id] = d.data());
  const pedidoBasePorRef = {}; pedidoBaseSnap.forEach(d => pedidoBasePorRef[d.id] = d.data());
  const planifPorRef = {}; planifSnap.forEach(d => planifPorRef[d.id] = d.data());

  // Consumos: agrupados por referencia, solo dias laborables (lun-vie) con
  // cantidad > 0 dentro de la ventana de 30 dias.
  const consumosPorRef = {};
  consumosSnap.forEach(d => {
    const c = d.data();
    if (!(c.cantidad > 0)) return;
    const diaSemana = new Date(c.fecha + "T12:00:00Z").getUTCDay(); // 0=domingo, 6=sabado
    if (diaSemana === 0 || diaSemana === 6) return;
    if (!consumosPorRef[c.referencia]) consumosPorRef[c.referencia] = [];
    consumosPorRef[c.referencia].push(c);
  });

  const resultados = [];
  maestroSnap.forEach(doc => {
    const ref = doc.id;
    const m = doc.data();
    const unidadesPalet = Math.max(Number(m.unidadesPalet) || 1, 1);
    const leadTime = Number(m.leadTime) || 0;
    const stockSeguridad = Number(m.stockSeguridad) || 0;
    const incremento = Number(m.incremento) || 0;
    const situacion = m.situacion || "ACTIVA";

    const consumos = (consumosPorRef[ref] || []).sort((a, b) => a.fecha.localeCompare(b.fecha));
    const palDia = consumos.map(c => c.cantidad / unidadesPalet);
    const cdm = palDia.length ? palDia.reduce((s, v) => s + v, 0) / palDia.length : 0;
    const consUlt = palDia.length ? palDia[palDia.length - 1] : 0;
    const cdmClip = Math.max(cdm, 0.01);
    const varCdm = Math.round(((consUlt - cdmClip) / cdmClip) * 100);

    const cdmEfectivo = Math.abs(varCdm) >= 15 ? Math.max(cdm * (1 + varCdm / 100), 0.01) : cdm;
    const mult = cdm < 5 ? 1.5 : 1.0;

    const stockDoc = stockPorRef[ref] || {};
    const stockOpUnidades = situacion === "MERCA" ? (stockDoc.stockMerca || 0) : (stockDoc.stockInterno || 0);
    const stockOpPalets = stockOpUnidades / unidadesPalet;
    // Desglose por almacen (aparte del "operativo" que ya usa la formula),
    // para que se vea en el dashboard de donde sale cada palet.
    const stockPlazaPalets    = (stockDoc.stockInterno  || 0) / unidadesPalet;
    const stockMercaPalets    = (stockDoc.stockMerca    || 0) / unidadesPalet;
    const stockTxtPalets      = (stockDoc.stockTxt      || 0) / unidadesPalet;
    const stockAvitransPalets = (stockDoc.stockAvitrans || 0) / unidadesPalet;

    const transitoDoc = transitoPorRef[ref] || {};
    const transitoUnidades = Object.values(transitoDoc.porTipo || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const transitoPalets = transitoUnidades / unidadesPalet;

    const disponible = stockOpPalets + transitoPalets;
    const pedidoEf = Math.ceil(stockSeguridad + mult * cdmEfectivo * leadTime - disponible + incremento);
    const pedidoMin = Math.ceil(stockSeguridad + mult * cdm * leadTime - disponible + incremento);
    let pedido = Math.max(pedidoEf, pedidoMin, 0);

    const bloqueado = cdm <= 0 || situacion === "BAJA";
    if (bloqueado) pedido = 0;

    const boxBase = (pedidoBasePorRef[ref] || {}).boxBase || 0;
    const ajuste = pedido - boxBase;

    const diasCobertura = cdm > 0 ? Math.round(stockOpPalets / cdm) : 999;
    let semaforo = "verde";
    if (pedido > 0) semaforo = (stockOpPalets < stockSeguridad || diasCobertura < leadTime) ? "rojo" : "amarillo";

    const resultado = {
      ref, descripcion: m.descripcion || "", situacion, leadTime, stockSeguridad, unidadesPalet, incremento,
      cdm: Math.round(cdm * 100) / 100, varCdm, stockOpPalets: Math.round(stockOpPalets * 100) / 100,
      stockPlazaPalets: Math.round(stockPlazaPalets * 100) / 100,
      stockMercaPalets: Math.round(stockMercaPalets * 100) / 100,
      stockTxtPalets: Math.round(stockTxtPalets * 100) / 100,
      stockAvitransPalets: Math.round(stockAvitransPalets * 100) / 100,
      transitoPalets: Math.round(transitoPalets * 100) / 100, diasCobertura,
      pedido, boxBase, ajuste, bloqueado, semaforo
    };

    // Variante por prevision: solo si hay planificacion cargada para esta
    // referencia. stkUd/nec en unidades (no palets); palTeo puede salir
    // negativo (falta stock para cubrir la necesidad planificada), y en
    // ese caso se usa tal cual (ya en "palets negativos", coherente con la
    // logica original) en vez del stock operativo normal.
    const planif = planifPorRef[ref];
    if (planif && planif.apro > 0) {
      const nec = Number(planif.apro) || 0;
      const palTeo = Math.floor((stockOpUnidades - nec) / unidadesPalet);
      const dispPrev = (palTeo < 0 ? palTeo : stockOpPalets) + transitoPalets;
      const pedidoPrevEf = Math.ceil(stockSeguridad + mult * cdmEfectivo * leadTime - dispPrev + incremento);
      const pedidoPrevMin = Math.ceil(stockSeguridad + mult * cdm * leadTime - dispPrev + incremento);
      let pedidoPrev = Math.max(pedidoPrevEf, pedidoPrevMin, 0);
      if (bloqueado) pedidoPrev = 0;
      resultado.pedidoPrev = pedidoPrev;
      resultado.ajustePrev = pedidoPrev - boxBase;
    }

    resultados.push(resultado);
  });

  resultados.sort((a, b) => {
    const na = Number((a.ref.match(/\d+/) || [])[0]) || 999999;
    const nb = Number((b.ref.match(/\d+/) || [])[0]) || 999999;
    return na - nb;
  });
  return resultados;
}

exports.calcularPedidoBandejas = functions.https.onCall(async (request, context) => {
  const esV2 = !!(request && typeof request === "object" && request.data !== undefined);
  const ctx = esV2 ? request : (context || {});
  if (!ctx.app) return { ok: false, error: "No autorizado" };
  const email = (ctx.auth && ctx.auth.token && ctx.auth.token.email || "").toLowerCase();
  if (!email || !(await puedeSeccionEstricto(email, "compras"))) return { ok: false, error: "Sin permiso" };

  try {
    const resultados = await calcularTodoPedidoBandejas();
    return { ok: true, resultados };
  } catch (e) {
    console.error("calcularPedidoBandejas:", e.message);
    return { ok: false, error: "No se pudo calcular: " + e.message };
  }
});

// Revisa cada 5 minutos las acciones que Robin haya dejado programadas
// (herramienta programar_accion) y ejecuta las que ya les toque. La
// precision es de estos 5 minutos, no exacta al segundo. Reutiliza las
// mismas funciones que la ejecucion inmediata (iaEnviarCorreo/
// iaEnviarMensajeChat), asi que el resultado es identico a si Robin lo
// hubiera mandado directamente.
exports.ejecutarAccionesProgramadasRobin = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Madrid" },
  async () => {
    const ahora = admin.firestore.Timestamp.now();
    let snap;
    try {
      snap = await db.collection("robin_acciones_programadas")
        .where("estado", "==", "pendiente").where("momento", "<=", ahora).get();
    } catch (e) { console.error("ejecutarAccionesProgramadasRobin: consulta:", e.message); return; }

    if (snap.empty) return;
    console.log("ejecutarAccionesProgramadasRobin: " + snap.size + " accion(es) por ejecutar.");

    for (const doc of snap.docs) {
      const d = doc.data();
      try {
        let resultado;
        if (d.tipo === "enviar_correo") resultado = await iaEnviarCorreo(d.parametros || {});
        else if (d.tipo === "enviar_mensaje_chat") resultado = await iaEnviarMensajeChat(d.parametros || {});
        else resultado = { error: "Tipo de accion desconocido: " + d.tipo };

        if (resultado && resultado.error) {
          await doc.ref.update({ estado: "error", error: resultado.error, ejecutadoTs: admin.firestore.Timestamp.now() });
          console.error("ejecutarAccionesProgramadasRobin: accion", doc.id, "fallo:", resultado.error);
        } else {
          await doc.ref.update({ estado: "ejecutada", ejecutadoTs: admin.firestore.Timestamp.now() });
          console.log("ejecutarAccionesProgramadasRobin: accion", doc.id, "(" + d.tipo + ") ejecutada.");
        }
      } catch (e) {
        console.error("ejecutarAccionesProgramadasRobin: accion", doc.id, e.message);
        await doc.ref.update({
          estado: "error", error: e.message, ejecutadoTs: admin.firestore.Timestamp.now()
        }).catch(() => {});
      }
    }
  }
);

// Tareas programadas por el propio administrador desde el panel (sin pasar
// por Robin, sin gastar tokens de IA): reutiliza exactamente las mismas
// funciones de envio que las herramientas de Robin (iaEnviarCorreo/
// iaEnviarMensajeChat), asi que esta funcion NUNCA llama a la IA. El panel
// crea/edita/borra los documentos directamente en Firestore (permitido solo
// al admin via firestore.rules); esta funcion solo se encarga de ejecutar
// y, si la tarea es recurrente, reprogramar la siguiente ejecucion.
function sumarDiasTimestamp(ts, dias) {
  return admin.firestore.Timestamp.fromMillis(ts.toMillis() + dias * 24 * 60 * 60 * 1000);
}

exports.ejecutarTareasProgramadas = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Europe/Madrid" },
  async () => {
    const ahora = admin.firestore.Timestamp.now();
    let snap;
    try {
      snap = await db.collection("tareas_programadas")
        .where("activa", "==", true).where("proximaEjecucion", "<=", ahora).get();
    } catch (e) { console.error("ejecutarTareasProgramadas: consulta:", e.message); return; }

    if (snap.empty) return;
    console.log("ejecutarTareasProgramadas: " + snap.size + " tarea(s) por ejecutar.");

    for (const doc of snap.docs) {
      const d = doc.data();
      try {
        let resultado;
        if (d.tipo === "enviar_correo") resultado = await iaEnviarCorreo(d.parametros || {});
        else if (d.tipo === "enviar_mensaje_chat") resultado = await iaEnviarMensajeChat(d.parametros || {});
        else resultado = { error: "Tipo de tarea desconocido: " + d.tipo };

        const cambios = { ultimaEjecucion: admin.firestore.Timestamp.now() };
        if (resultado && resultado.error) {
          cambios.ultimoError = resultado.error;
          console.error("ejecutarTareasProgramadas: tarea", doc.id, "fallo:", resultado.error);
        } else {
          cambios.ultimoError = null;
          console.log("ejecutarTareasProgramadas: tarea", doc.id, "(" + d.tipo + ") ejecutada.");
        }

        if (d.recurrencia === "diaria") {
          cambios.proximaEjecucion = sumarDiasTimestamp(d.proximaEjecucion, 1);
        } else if (d.recurrencia === "semanal") {
          cambios.proximaEjecucion = sumarDiasTimestamp(d.proximaEjecucion, 7);
        } else {
          cambios.activa = false;
        }

        await doc.ref.update(cambios);
      } catch (e) {
        console.error("ejecutarTareasProgramadas: tarea", doc.id, e.message);
        await doc.ref.update({
          ultimoError: e.message, ultimaEjecucion: admin.firestore.Timestamp.now()
        }).catch(() => {});
      }
    }
  }
);
