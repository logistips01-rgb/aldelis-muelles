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

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "Aldelis", {
    body: body || "",
    icon: "/favicon.ico"
  });
});
