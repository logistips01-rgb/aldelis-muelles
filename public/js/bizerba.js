(function () {
  const params = new URLSearchParams(location.search);
  const tecnico = parseInt(params.get("t"), 10);

  if (!tecnico || tecnico < 1 || tecnico > 6) {
    document.getElementById("error-screen").style.display = "block";
    document.getElementById("main").style.display = "none";
    return;
  }

  document.getElementById("main").style.display = "flex";
  document.getElementById("error-screen").style.display = "none";
  document.getElementById("tecnico-label").textContent = "Técnico " + tecnico;

  const db = firebase.firestore();
  let _timer = null;
  let _incidenciaActivaId = null;

  // Rango del día
  const hoy = new Date();
  const dayStart = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime();
  const dayEnd   = dayStart + 86400000;
  const Ts = firebase.firestore.Timestamp;

  function difMin(a, b) {
    if (!a || !b) return null;
    return (b.toMillis() - a.toMillis()) / 60000;
  }

  function formatDur(min) {
    if (min == null || isNaN(min)) return "—";
    if (min < 1) return "< 1 min";
    if (min < 60) return Math.round(min) + " min";
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m > 0 ? h + "h " + m + "m" : h + "h";
  }

  function tsHora(ts) {
    if (!ts) return "—";
    const d = ts.toDate();
    return d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0");
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderTimer(activaTs) {
    if (!activaTs) return;
    const mins = (Date.now() - activaTs.toMillis()) / 60000;
    const el = document.getElementById("timer-val");
    if (el) el.textContent = formatDur(mins);
  }

  function render(incs) {
    const ahora = Ts.now();

    // Stats del día
    const misIncs  = incs.filter(i => i.tecnico === tecnico);
    const resueltas = misIncs.filter(i => i.estado === "resuelta");
    const tresp = misIncs.filter(i => i.aceptada && i.creada).map(i => difMin(i.creada, i.aceptada));
    const treso = resueltas.filter(i => i.aceptada && i.resuelta).map(i => difMin(i.aceptada, i.resuelta));
    const mResp = tresp.length ? Math.round(tresp.reduce((a,b) => a+b, 0) / tresp.length) : null;
    const mReso = treso.length ? Math.round(treso.reduce((a,b) => a+b, 0) / treso.length) : null;

    document.getElementById("st-resueltas").textContent = resueltas.length;
    document.getElementById("st-tresp").textContent = mResp != null ? formatDur(mResp) : "—";
    document.getElementById("st-treso").textContent = mReso != null ? formatDur(mReso) : "—";

    // Incidencia activa
    const activa = incs.find(i => i.tecnico === tecnico && (i.estado === "aceptada" || i.estado === "repuesto"));
    const activaCont = document.getElementById("activa-cont");

    if (_timer) { clearInterval(_timer); _timer = null; }

    if (activa) {
      _incidenciaActivaId = activa.id;
      const esRepuesto = activa.estado === "repuesto";
      const activaTs   = activa.aceptada;
      activaCont.innerHTML =
        "<div class='activa-card" + (esRepuesto ? " repuesto" : "") + "'>" +
        "<div class='inc-linea'>Línea " + activa.linea + "</div>" +
        "<div class='inc-averia'>" + esc(activa.averia || "Sin detalle") + "</div>" +
        "<div class='timer' id='timer-val'>—</div>" +
        "<div class='timer-label'>" + (esRepuesto ? "Esperando repuesto desde " : "En curso desde ") + tsHora(activa.aceptada) + "</div>" +
        (esRepuesto ? "<div class='inc-meta' style='margin-bottom:12px'>Repuesto: <strong>" + esc(activa.repuesto || "—") + "</strong></div>" : "") +
        "<div class='btn-row'>" +
        (!esRepuesto ? "<button class='btn-repuesto' onclick=\"abrirModalRepuesto('" + activa.id + "')\">Falta repuesto</button>" : "") +
        "<button class='btn-resuelta' onclick=\"abrirModalResuelta('" + activa.id + "')\">Marcar resuelta</button>" +
        "</div></div>";
      renderTimer(activaTs);
      _timer = setInterval(() => renderTimer(activaTs), 30000);
    } else {
      _incidenciaActivaId = null;
      activaCont.innerHTML = "<div class='empty'>No tienes ninguna incidencia activa.</div>";
    }

    // Pendientes
    const pendientes = incs
      .filter(i => i.estado === "abierta")
      .sort((a, b) => (a.creada ? a.creada.toMillis() : 0) - (b.creada ? b.creada.toMillis() : 0));

    const pendCont = document.getElementById("pendientes-cont");
    if (!pendientes.length) {
      pendCont.innerHTML = "<div class='empty'>No hay incidencias pendientes.</div>";
    } else {
      pendCont.innerHTML = pendientes.map(i => {
        const espera = i.creada ? difMin(i.creada, ahora) : null;
        return "<div class='card'>" +
          "<div class='inc-linea'>Línea " + i.linea + "</div>" +
          "<div class='inc-averia'>" + esc(i.averia || "Sin detalle") + "</div>" +
          "<div class='inc-meta'>Abierta a las " + tsHora(i.creada) +
          (espera != null ? " · <strong>Espera: " + formatDur(espera) + "</strong>" : "") + "</div>" +
          "<div class='btn-row'>" +
          "<button class='btn-coger' onclick=\"cogerIncidencia('" + i.id + "')\">Coger incidencia</button>" +
          "</div></div>";
      }).join("");
    }
  }

  // Listener en tiempo real
  db.collection("incidencias")
    .where("creada", ">=", Ts.fromMillis(dayStart))
    .where("creada", "<",  Ts.fromMillis(dayEnd))
    .onSnapshot(snap => {
      const incs = [];
      snap.forEach(d => incs.push({ id: d.id, ...d.data() }));
      render(incs);
    }, e => console.error("bizerba:", e));

  // ── Coger incidencia ────────────────────────────────────────────────────────

  window.cogerIncidencia = async function(id) {
    try {
      await db.collection("incidencias").doc(id).update({
        estado:   "aceptada",
        tecnico:  tecnico,
        aceptada: Ts.now()
      });
    } catch(e) { alert("Error al coger la incidencia."); console.error(e); }
  };

  // ── Modal repuesto ──────────────────────────────────────────────────────────

  let _modalRepuestoId = null;

  window.abrirModalRepuesto = function(id) {
    _modalRepuestoId = id;
    document.getElementById("modal-repuesto-txt").value = "";
    document.getElementById("modal-repuesto-err").style.display = "none";
    document.getElementById("modal-repuesto").classList.add("open");
    setTimeout(() => document.getElementById("modal-repuesto-txt").focus(), 100);
  };

  window.confirmarRepuesto = async function() {
    const txt = document.getElementById("modal-repuesto-txt").value.trim();
    const err = document.getElementById("modal-repuesto-err");
    if (!txt) { err.style.display = "block"; return; }
    err.style.display = "none";
    try {
      await db.collection("incidencias").doc(_modalRepuestoId).update({
        estado:   "repuesto",
        repuesto: txt
      });
      cerrarModal("modal-repuesto");
    } catch(e) { alert("Error al actualizar."); console.error(e); }
  };

  // ── Modal resuelta ──────────────────────────────────────────────────────────

  let _modalResueltaId = null;

  window.abrirModalResuelta = function(id) {
    _modalResueltaId = id;
    document.getElementById("modal-resuelta-txt").value = "";
    document.getElementById("modal-resuelta-err").style.display = "none";
    document.getElementById("modal-resuelta").classList.add("open");
    setTimeout(() => document.getElementById("modal-resuelta-txt").focus(), 100);
  };

  window.confirmarResuelta = async function() {
    const txt = document.getElementById("modal-resuelta-txt").value.trim();
    const err = document.getElementById("modal-resuelta-err");
    if (!txt) { err.style.display = "block"; return; }
    err.style.display = "none";
    try {
      await db.collection("incidencias").doc(_modalResueltaId).update({
        estado:        "resuelta",
        observaciones: txt,
        resuelta:      Ts.now()
      });
      cerrarModal("modal-resuelta");
    } catch(e) { alert("Error al resolver."); console.error(e); }
  };

  window.cerrarModal = function(id) {
    document.getElementById(id).classList.remove("open");
  };

})();
