const functions  = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
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
          allSegs.push({ numero: n, estado: ev.estado, nave: ev.nave || null, muelle: ev.muelle || null, durMin, coste: durMin * (LANZ_COSTE_MIN[n] || 0) });
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
        mCard(formatDur(mediaNaveSeg), "T. medio visita") +
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
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Lanz.</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Nave</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Muelle</th>" +
        "<th style='padding:5px 8px;text-align:left;font-size:11px;color:#888;font-weight:600'>Dur.</th>" +
        "<th style='padding:5px 8px;text-align:right;font-size:11px;color:#888;font-weight:600'>Coste</th></tr>";
      const esperasTr = topEsperas.map(s =>
        "<tr><td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>L" + s.numero + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(NAVE_NOMBRE[s.nave] || s.nave || "?") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + esc(s.muelle || "—") + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;border-bottom:1px solid #f5f5f5'>" + formatDur(s.durMin) + "</td>" +
        "<td style='padding:5px 8px;font-size:12px;font-weight:700;color:#D41F3A;text-align:right;border-bottom:1px solid #f5f5f5'>" + formatEuro(s.coste) + "</td></tr>"
      ).join("");

      const html =
        "<!DOCTYPE html><html><body style='margin:0;padding:16px;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif'>" +
        "<div style='max-width:700px;margin:0 auto'>" +

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

        "<div style='height:10px'></div>" +
        "<div style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Costes de operacion</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" + lanzCards + "</tr></table>" +
        "</div>" +

        "<div style='height:10px'></div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'><tr>" +
        "<td width='35%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Coste por nave</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + naveCosteRows + "</table></td>" +
        "<td width='2%'></td>" +
        "<td width='63%' valign='top' style='" + CARD + ";padding:14px'>" +
        "<div style='font-size:12px;font-weight:700;color:#1A1A1A;margin-bottom:10px'>Esperas mas caras</div>" +
        "<table width='100%' cellpadding='0' cellspacing='0'>" + esperasTh + esperasTr + "</table></td>" +
        "</tr></table>" +

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
