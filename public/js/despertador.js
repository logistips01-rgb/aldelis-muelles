(function () {
  "use strict";

  // Personal y solo para admin: no se gestiona desde el sistema de permisos
  // a proposito, es un acceso directo aparte, como el modulo de ubicacion.
  const ADMINS = ["mlorente@aldelis.com"];

  const el = id => document.getElementById(id);

  let audioCtx = null;
  let beepTimer = null;
  let tickTimer = null;
  let wakeLock = null;
  let sonando = false;
  let snoozeHasta = null; // timestamp ms, o null
  let ultimoDisparo = null; // "YYYY-MM-DD HH:MM" para no repetir el mismo minuto

  function showToast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  }

  function primeAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  function beepUnaVez() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = 880;
    gain.gain.value = 0.18;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  }

  function iniciarSonido() {
    primeAudio();
    if (beepTimer) return;
    beepUnaVez();
    beepTimer = setInterval(beepUnaVez, 650);
    if (navigator.vibrate) {
      navigator.vibrate([500, 300, 500, 300, 500, 300, 500]);
      beepTimer._vib = setInterval(() => navigator.vibrate([500, 300, 500, 300]), 1600);
    }
  }

  function detenerSonido() {
    if (beepTimer) { clearInterval(beepTimer); if (beepTimer._vib) clearInterval(beepTimer._vib); beepTimer = null; }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  async function pedirWakeLock() {
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) { /* si el movil lo deniega, seguimos igual, solo sin bloqueo de pantalla */ }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (estaArmado() || sonando)) pedirWakeLock();
  });

  function estaArmado() { return localStorage.getItem("despertador_armado") === "1"; }
  function setArmado(v) { localStorage.setItem("despertador_armado", v ? "1" : "0"); }
  function getHoraGuardada() { return localStorage.getItem("despertador_hora") || "07:00"; }
  function setHoraGuardada(v) { localStorage.setItem("despertador_hora", v); }
  function getRepetir() { return localStorage.getItem("despertador_repetir") !== "0"; }
  function setRepetir(v) { localStorage.setItem("despertador_repetir", v ? "1" : "0"); }

  function fmtReloj(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
  }
  function fmtHM(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function actualizarReloj() {
    const now = new Date();
    el("reloj").textContent = fmtReloj(now);
    el("fecha-hoy").textContent = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    comprobarDisparo(now);
  }

  function comprobarDisparo(now) {
    if (sonando) return;

    if (snoozeHasta && now.getTime() >= snoozeHasta) {
      snoozeHasta = null;
      dispararAlarma();
      return;
    }

    if (!estaArmado()) return;
    const claveMinuto = now.toISOString().slice(0, 10) + " " + fmtHM(now);
    if (fmtHM(now) === getHoraGuardada() && ultimoDisparo !== claveMinuto) {
      ultimoDisparo = claveMinuto;
      dispararAlarma();
    }
  }

  function dispararAlarma() {
    sonando = true;
    el("ringing").style.display = "flex";
    el("ringing-hora").textContent = fmtHM(new Date());
    pedirWakeLock();
    iniciarSonido();
  }

  function apagarAlarma() {
    sonando = false;
    snoozeHasta = null;
    detenerSonido();
    el("ringing").style.display = "none";
    if (!getRepetir()) {
      setArmado(false);
      actualizarUiArmado();
    }
    showToast(getRepetir() ? "Alarma apagada. Sonara manana a la misma hora." : "Alarma apagada y desactivada.");
  }

  function posponerAlarma() {
    sonando = false;
    detenerSonido();
    el("ringing").style.display = "none";
    snoozeHasta = Date.now() + 9 * 60 * 1000;
    showToast("Pospuesta 9 minutos.");
  }

  function actualizarUiArmado() {
    const btn = el("btn-armar");
    const armado = estaArmado();
    btn.textContent = armado ? "Desactivar" : "Activar";
    btn.classList.toggle("armado", armado);
    el("estado-alarma").textContent = armado
      ? "Alarma activada para las " + getHoraGuardada() + (getRepetir() ? " (se repite cada dia)" : " (solo hoy)")
      : "Alarma desactivada.";
  }

  function arrancarApp() {
    el("hora-alarma").value = getHoraGuardada();
    el("chk-repetir").checked = getRepetir();
    actualizarUiArmado();
    if (estaArmado()) pedirWakeLock();

    actualizarReloj();
    tickTimer = setInterval(actualizarReloj, 1000);

    el("hora-alarma").addEventListener("change", () => {
      setHoraGuardada(el("hora-alarma").value);
      ultimoDisparo = null;
      if (estaArmado()) actualizarUiArmado();
    });
    el("chk-repetir").addEventListener("change", () => {
      setRepetir(el("chk-repetir").checked);
      actualizarUiArmado();
    });
    el("btn-armar").addEventListener("click", () => {
      primeAudio();
      const nuevoEstado = !estaArmado();
      setArmado(nuevoEstado);
      ultimoDisparo = null;
      actualizarUiArmado();
      if (nuevoEstado) { pedirWakeLock(); showToast("Alarma activada."); }
      else showToast("Alarma desactivada.");
    });
    el("btn-test-sonido").addEventListener("click", () => {
      primeAudio();
      beepUnaVez();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    });
    el("btn-apagar").addEventListener("click", apagarAlarma);
    el("btn-posponer").addEventListener("click", posponerAlarma);

    actualizarGiroForzado();
    window.addEventListener("resize", actualizarGiroForzado);
    window.addEventListener("orientationchange", actualizarGiroForzado);
  }

  function actualizarGiroForzado() {
    document.body.classList.toggle("forzar-rot", window.innerHeight > window.innerWidth);
  }

  el("login-btn").addEventListener("click", async () => {
    el("login-error").textContent = "";
    try {
      await auth.signInWithEmailAndPassword(el("login-email").value.trim(), el("login-pass").value);
    } catch (e) {
      el("login-error").textContent = "Email o contrasena incorrectos.";
    }
  });
  el("cerrar-sesion").addEventListener("click", e => { e.preventDefault(); auth.signOut(); });

  auth.onAuthStateChanged(user => {
    if (!user) {
      el("login").style.display = "block";
      el("sin-acceso").style.display = "none";
      el("app").style.display = "none";
      return;
    }
    const email = (user.email || "").toLowerCase();
    el("login").style.display = "none";
    if (ADMINS.indexOf(email) === -1) {
      el("sin-acceso").style.display = "block";
      el("app").style.display = "none";
      return;
    }
    el("sin-acceso").style.display = "none";
    el("app").style.display = "flex";
    if (!tickTimer) arrancarApp();
  });
})();
