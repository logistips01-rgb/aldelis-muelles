// Service worker de notificaciones push (FCM).
// Se ejecuta en segundo plano, incluso con la app cerrada o la pantalla bloqueada.
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyA36_n5fU8L6dvc3qJem4o6yGQ4hsiE6ug",
  authDomain: "aldelis-muelles.firebaseapp.com",
  projectId: "aldelis-muelles",
  storageBucket: "aldelis-muelles.firebasestorage.app",
  messagingSenderId: "845448565876",
  appId: "1:845448565876:web:e347390b385218adc6ed21"
});

const messaging = firebase.messaging();

// Mensaje recibido en segundo plano: mostramos la notificacion del sistema
messaging.onBackgroundMessage(function (payload) {
  const d = payload.data || {};
  self.registration.showNotification(d.title || "Aldelis", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "chat",
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || "/" }
  });
});

// Al tocar la notificacion: abrir/enfocar la app
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if (c.url.indexOf(url) !== -1 && "focus" in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
