(function () {
  window.initPush = async function (role, numero) {
    if (!("Notification" in window) || !firebase.messaging) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;

      const messaging = firebase.messaging();
      const token = await messaging.getToken();
      if (!token) return;

      const payload = { role, ts: firebase.firestore.Timestamp.now() };
      if (numero != null) payload.numero = numero;

      await firebase.firestore()
        .collection("push_tokens")
        .doc(token)
        .set(payload, { merge: true });
    } catch (e) {
      console.warn("push init:", e);
    }
  };
})();
