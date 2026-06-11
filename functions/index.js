const functions = require("firebase-functions");

const MS_CLIENT_ID = "5c27366e-433f-4b07-a2a3-2b40f2217863";
const MS_TENANT_ID = "31f702d7-3d33-43a6-b35f-c15ff5aa0f1c";
const MS_SENDER    = "reservas@aldelis.com";
const MS_SECRET    = process.env.MS_SECRET;

exports.enviarEmail = functions.https.onCall(async (request) => {
  const data = request.data;

  console.log("DATOS RECIBIDOS:", JSON.stringify(data));

  const to      = data.to;
  const subject = data.subject;
  const body    = data.body;

  if (!to || !subject || !body) {
    console.log("FALTAN DATOS", { to, subject, body });
    return { ok: false, error: "Faltan datos" };
  }

  try {
    console.log("Obteniendo token MS...");
    const tokenRes = await fetch(
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

    const tokenData = await tokenRes.json();
    console.log("Token OK:", tokenData.access_token ? "SI" : "NO", tokenData.error || "");

    if (!tokenData.access_token) {
      return { ok: false, error: "Token error: " + (tokenData.error_description || tokenData.error) };
    }

    console.log("Enviando email a:", to);
    const sendRes = await fetch(
      "https://graph.microsoft.com/v1.0/users/" + MS_SENDER + "/sendMail",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + tokenData.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: [{ emailAddress: { address: to } }]
          },
          saveToSentItems: false
        })
      }
    );

    console.log("Graph API status:", sendRes.status);
    const respText = await sendRes.text();
    console.log("Graph API body:", respText.substring(0, 300));

    if (sendRes.status === 202 || sendRes.status === 200) {
      return { ok: true };
    } else {
      return { ok: false, error: respText };
    }

  } catch(e) {
    console.error("ERROR:", e.message);
    return { ok: false, error: e.message };
  }
});