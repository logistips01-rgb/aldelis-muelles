(function () {
  // Clave publica de Web Push (VAPID). Se obtiene en la consola de Firebase:
  // Configuracion del proyecto > Cloud Messaging > Certificados push web.
  // Si se deja vacia el SDK usa su clave por defecto, que funciona pero es
  // compartida; conviene rellenarla.
  const VAPID_PUBLIC_KEY = "";

  // rol: "almacen" o "lanzadera" (los valores que aceptan las reglas)
  // numero: solo para lanzadera, 1..4
  window.initPush = async function (rol, numero) {
    if (!("Notification" in window) || !firebase.messaging) return;
    if (Notification.permission === "denied") return;

    try {
      const permiso = await Notification.requestPermission();
      if (permiso !== "granted") return;

      const messaging = firebase.messaging();
      const token = VAPID_PUBLIC_KEY
        ? await messaging.getToken({ vapidKey: VAPID_PUBLIC_KEY })
        : await messaging.getToken();
      if (!token) return;

      await guardarToken(token, rol, numero);

      // El token puede rotar; hay que volver a guardarlo cuando pase.
      if (typeof messaging.onTokenRefresh === "function") {
        messaging.onTokenRefresh(async () => {
          try {
            const nuevo = VAPID_PUBLIC_KEY
              ? await messaging.getToken({ vapidKey: VAPID_PUBLIC_KEY })
              : await messaging.getToken();
            if (nuevo) await guardarToken(nuevo, rol, numero);
          } catch (e) { console.warn("push refresh:", e.message); }
        });
      }
    } catch (e) {
      console.warn("push init:", e.message);
    }
  };

  // Los nombres de campo tienen que coincidir con validToken() de
  // firestore.rules: token, rol y lanzadera. Si no, la escritura se deniega.
  async function guardarToken(token, rol, numero) {
    const datos = {
      token:     token,
      rol:       rol,
      lanzadera: (rol === "lanzadera" && numero != null) ? Number(numero) : null,
      ts:        firebase.firestore.Timestamp.now()
    };
    try {
      await firebase.firestore().collection("push_tokens").doc(token).set(datos);
    } catch (e) {
      console.warn("push guardar token:", e.message);
    }
  }
})();
