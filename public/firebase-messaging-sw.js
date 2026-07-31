importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA36_n5fU8L6dvc3qJem4o6yGQ4hsiE6ug",
  authDomain: "aldelis-muelles.firebaseapp.com",
  projectId: "aldelis-muelles",
  storageBucket: "aldelis-muelles.firebasestorage.app",
  messagingSenderId: "845448565876",
  appId: "1:845448565876:web:e347390b385218adc6ed21"
});

const messaging = firebase.messaging();

// notifChat envia el mensaje SOLO con "data", sin bloque "notification". Si
// llevara "notification" el navegador la mostraria por su cuenta ademas de
// esta, saldrian dos avisos y no se podrian controlar la vibracion ni el icono.
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  const titulo = d.title || "Aldelis";

  self.registration.showNotification(titulo, {
    body:    d.body || "",
    icon:    "/icon-512.png",
    badge:   "/icon-512.png",
    vibrate: [200, 100, 200],
    // Mismo tag por conversacion: un mensaje nuevo sustituye al anterior en
    // lugar de acumular avisos. renotify vuelve a sonar aunque se sustituya.
    tag:      d.tag || "chat",
    renotify: true,
    silent:   false,
    data:     { url: d.url || "/" }
  });
});

// Al tocar la notificacion: si ya hay una pestana abierta se enfoca, y si no
// se abre. Sin esto la notificacion no lleva a ninguna parte.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destino = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
      for (const cliente of lista) {
        if (cliente.url.indexOf(destino) !== -1 && 'focus' in cliente) return cliente.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(destino);
    })
  );
});
