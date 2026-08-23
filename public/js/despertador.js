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

  function fmtHM(d) {
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // Reloj retro de cortinillas (split-flap): cada digito es una cajita con
  // el valor actual debajo y una "cortinilla" que cae tapando el valor viejo
  // hasta revelar el nuevo, como los despertadores/paneles de aeropuerto.
  const flipDigitos = {};

  function crearUnidadFlip(id, valorInicial) {
    const u = document.createElement("div");
    u.className = "flip-unit";
    u.id = id;
    u.innerHTML =
      "<div class='fu-half top'><div class='fu-digit'><span class='fu-top-txt'>" + valorInicial + "</span></div></div>" +
      "<div class='fu-half bottom'><div class='fu-digit'><span class='fu-bottom-txt'>" + valorInicial + "</span></div></div>" +
      "<div class='fu-flap'><div class='fu-digit'><span class='fu-flap-txt'>" + valorInicial + "</span></div></div>";
    flipDigitos[id] = { el: u, valor: valorInicial };
    return u;
  }

  function construirReloj() {
    const cont = el("reloj");
    cont.innerHTML = "";
    const ahora = new Date();
    const hm = fmtHM(ahora).replace(":", "");
    cont.appendChild(crearUnidadFlip("fu-h1", hm[0]));
    cont.appendChild(crearUnidadFlip("fu-h2", hm[1]));
    const colon = document.createElement("div");
    colon.className = "reloj-colon";
    colon.innerHTML = "<span></span><span></span>";
    cont.appendChild(colon);
    cont.appendChild(crearUnidadFlip("fu-m1", hm[2]));
    cont.appendChild(crearUnidadFlip("fu-m2", hm[3]));
  }

  function flipA(id, nuevoValor) {
    const u = flipDigitos[id];
    if (!u || u.valor === nuevoValor) return;
    const flap = u.el.querySelector(".fu-flap");
    const flapTxt = u.el.querySelector(".fu-flap-txt");
    const topTxt = u.el.querySelector(".fu-top-txt");
    const bottomTxt = u.el.querySelector(".fu-bottom-txt");
    flapTxt.textContent = u.valor; // la cortinilla enseña el valor viejo cayendo
    topTxt.textContent = nuevoValor;
    bottomTxt.textContent = nuevoValor;
    u.valor = nuevoValor;
    flap.classList.remove("falling");
    void flap.offsetWidth; // fuerza a reiniciar la animacion si ya estaba corriendo
    flap.classList.add("falling");
    flap.addEventListener("animationend", function handler() {
      flap.classList.remove("falling");
      flapTxt.textContent = nuevoValor;
      flap.removeEventListener("animationend", handler);
    });
  }

  function actualizarReloj() {
    const now = new Date();
    const hm = fmtHM(now).replace(":", "");
    flipA("fu-h1", hm[0]);
    flipA("fu-h2", hm[1]);
    flipA("fu-m1", hm[2]);
    flipA("fu-m2", hm[3]);
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

    construirReloj();
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
      pedirPantallaCompleta();
      const nuevoEstado = !estaArmado();
      setArmado(nuevoEstado);
      ultimoDisparo = null;
      actualizarUiArmado();
      if (nuevoEstado) { pedirWakeLock(); showToast("Alarma activada."); }
      else showToast("Alarma desactivada.");
    });
    el("btn-pantalla-completa").addEventListener("click", pedirPantallaCompleta);
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

    ["click", "touchstart", "mousemove", "keydown"].forEach(ev => document.addEventListener(ev, avisarActividad));
    avisarActividad();
  }

  // Al minuto sin tocar la pantalla se esconde todo menos el reloj, para
  // que de noche se parezca a un despertador real y no a una pantalla de movil.
  let inactividadTimer = null;
  function avisarActividad() {
    document.body.classList.remove("reposo");
    clearTimeout(inactividadTimer);
    inactividadTimer = setTimeout(() => document.body.classList.add("reposo"), 60000);
  }

  function actualizarGiroForzado() {
    document.body.classList.toggle("forzar-rot", window.innerHeight > window.innerWidth);
  }

  function elFullscreen() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function pedirPantallaCompleta() {
    try {
      if (elFullscreen()) {
        const salir = document.exitFullscreen || document.webkitExitFullscreen;
        if (salir) salir.call(document);
        return;
      }
      const req = document.documentElement.requestFullscreen
        || document.documentElement.webkitRequestFullscreen;
      if (!req) { showToast("Este navegador no admite pantalla completa."); return; }
      const resultado = req.call(document.documentElement);
      if (resultado && resultado.catch) {
        resultado.catch(e => showToast("No se pudo poner en pantalla completa: " + e.message));
      }
    } catch (e) { showToast("No se pudo poner en pantalla completa: " + e.message); }
  }

  document.addEventListener("fullscreenchange", actualizarBotonPantallaCompleta);
  document.addEventListener("webkitfullscreenchange", actualizarBotonPantallaCompleta);
  function actualizarBotonPantallaCompleta() {
    const btn = el("btn-pantalla-completa");
    if (btn) btn.textContent = elFullscreen() ? "⛶ Salir de pantalla completa" : "⛶ Pantalla completa";
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
