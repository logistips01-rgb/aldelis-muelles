// Notificaciones push (FCM): registra el dispositivo y guarda su token.
// El envio lo hace una Cloud Function al crearse un mensaje de chat.
//
// IMPORTANTE: pega aqui la clave VAPID de tu proyecto.
// Firebase Console > Configuracion del proyecto > Cloud Messaging >
// "Certificados push web" > Generar par de claves > copia la clave publica.
const VAPID_KEY = "T4bHfnb0RK7JEblvHMW5p8dp8E-3D3yzTncOuAp6GXo";

let _pushDone = false;

async function initPush(rol, lanzaderaNum) {
  try {
    if (_pushDone) return;
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
    if (!firebase.messaging || !firebase.messaging.isSupported || !firebase.messaging.isSupported()) return;
    if (!VAPID_KEY || VAPID_KEY.indexOf("PEGA_AQUI") === 0) {
      console.warn("T4bHfnb0RK7JEblvHMW5p8dp8E-3D3yzTncOuAp6GXo");
      return;
    }

    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;

    const messaging = firebase.messaging();
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return;

    await db.collection("push_tokens").doc(token).set({
      token: token,
      rol: rol,
      lanzadera: (rol === "lanzadera" ? (lanzaderaNum || null) : null),
      updated: firebase.firestore.Timestamp.now()
    }, { merge: true });

    _pushDone = true;

    // Mensaje recibido con la app en primer plano (el SW solo actua en segundo plano)
    messaging.onMessage(function (payload) {
      const d = payload.data || {};
      try {
        if (typeof beep === "function") beep();
      } catch (e) {}
      if (Notification.permission === "granted") {
        new Notification(d.title || "Aldelis", { body: d.body || "", icon: "/icon-192.png" });
      }
    });
  } catch (e) {
    console.warn("[push] no disponible:", e && e.message);
  }
}
