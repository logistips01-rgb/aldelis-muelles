const functions  = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
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

// La funcion corre en UTC: hay que formatear la hora en zona Madrid o el
// detalle por lanzadera saldria desfasado una o dos horas.
function horaMadrid(ms) {
  return new Date(ms).toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false
  });
}

// ── Función callable: enviar email desde el cliente ─────────────────────────

exports.enviarEmail = functions.https.onCall(async (request) => {
  const data = request.data;
  console.log("DATOS RECIBIDOS:", JSON.stringify(data).substring(0, 200));

  const to          = data.to;
  const subject     = data.subject;
  const body        = data.body;
  const html        = data.html;
  const imageBase64 = data.imageBase64 || null;

  if (!to || !subject || (!body && !html)) {
    console.log("FALTAN DATOS", { to, subject });
    return { ok: false, error: "Faltan datos" };
  }

  try {
    const token  = await obtenerTokenMS();
    const status = await enviarConGraph(token, to, subject, html, body, imageBase64);
    return (status === 202 || status === 200) ? { ok: true } : { ok: false, error: "Graph status " + status };
  } catch(e) {
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
        1: 12500 / (diasLaborables * 1440),
        2: 12500 / (diasLaborables * 1440),
        3: 12500 / (diasLaborables * 480),
        4: 150 / 60
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
      const CARD = "border-radius:8px;border:1px solid #e8e8e8;background:#fff";

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

      const html =
        "<!DOCTYPE html><html><body style='margin:0;padding:16px;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif'>" +
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
    const CARD = "border-radius:8px;border:1px solid #e8e8e8;background:#fff";

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

    const html =
      "<!DOCTYPE html><html><body style='margin:0;padding:16px;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif'>" +
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
