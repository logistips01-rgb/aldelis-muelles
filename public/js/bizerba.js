(function () {
  const params = new URLSearchParams(location.search);
  const tecnico = parseInt(params.get("l"), 10);

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
  let _activaId = null;
  let _activaTs = null;

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

  function renderTimer() {
    if (!_activaTs) return;
    const mins = (Date.now() - _activaTs.toMillis()) / 60000;
    const el = document.getElementById("timer-val");
    if (el) el.textContent = formatDur(mins);
  }

  function render(incs) {
    const ahora = Ts.now();

    // Stats del día para este técnico
    const miasInc = incs.filter(i => i.tecnico === tecnico);
    const resueltas = miasInc.filter(i => i.estado === "resuelta");
    const tresp = miasInc.filter(i => i.aceptada && i.creada).map(i => difMin(i.creada, i.aceptada));
    const treso = resueltas.filter(i => i.aceptada && i.resuelta).map(i => difMin(i.aceptada, i.resuelta));
    const mResp = tresp.length ? Math.round(tresp.reduce((a,b) => a+b, 0) / tresp.length) : null;
    const mReso = treso.length ? Math.round(treso.reduce((a,b) => a+b, 0) / treso.length) : null;

    document.getElementById("st-resueltas").textContent = resueltas.length;
    document.getElementById("st-tresp").textContent = mResp != null ? formatDur(mResp) : "—";
    document.getElementById("st-treso").textContent = mReso != null ? formatDur(mReso) : "—";

    // Incidencia activa (que este técnico tiene cogida)
    const activa = incs.find(i => i.tecnico === tecnico && (i.estado === "aceptada" || i.estado === "repuesto"));
    const activaCont = document.getElementById("activa-cont");

    if (_timer) { clearInterval(_timer); _timer = null; }

    if (activa) {
      _activaId = activa.id;
      _activaTs = activa.aceptada;
      const esRepuesto = activa.estado === "repuesto";
      activaCont.innerHTML =
        "<div class='activa-card" + (esRepuesto ? " repuesto" : "") + "'>" +
        "<div class='inc-linea'>Línea " + activa.linea + "</div>" +
        "<div class='inc-averia'>" + esc(activa.averia || "Sin detalle") + "</div>" +
        "<div class='timer' id='timer-val'>—</div>" +
        "<div class='timer-label'>" + (esRepuesto ? "Esperando repuesto desde " : "En curso desde ") + tsHora(activa.aceptada) + "</div>" +
        "<div class='btn-row'>" +
        (!esRepuesto ? "<button class='btn-repuesto' onclick=\"marcarRepuesto('" + activa.id + "')\">Falta repuesto</button>" : "") +
        "<button class='btn-resuelta' onclick=\"marcarResuelta('" + activa.id + "')\">Marcar resuelta</button>" +
        "</div></div>";
      renderTimer();
      _timer = setInterval(renderTimer, 30000);
    } else {
      _activaId = null;
      _activaTs = null;
      activaCont.innerHTML = "<div class='empty'>No tienes ninguna incidencia activa.</div>";
    }

    // Pendientes de coger (abiertas, sin técnico)
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

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Listener en tiempo real — solo incidencias de hoy
  db.collection("incidencias")
    .where("creada", ">=", Ts.fromMillis(dayStart))
    .where("creada", "<",  Ts.fromMillis(dayEnd))
    .onSnapshot(snap => {
      const incs = [];
      snap.forEach(d => incs.push({ id: d.id, ...d.data() }));
      render(incs);
    }, e => console.error("bizerba:", e));

  window.cogerIncidencia = async function(id) {
    try {
      await db.collection("incidencias").doc(id).update({
        estado:   "aceptada",
        tecnico:  tecnico,
        aceptada: Ts.now()
      });
    } catch(e) { alert("Error al coger la incidencia."); console.error(e); }
  };

  window.marcarRepuesto = async function(id) {
    try {
      await db.collection("incidencias").doc(id).update({ estado: "repuesto" });
    } catch(e) { alert("Error al actualizar."); console.error(e); }
  };

  window.marcarResuelta = async function(id) {
    try {
      await db.collection("incidencias").doc(id).update({
        estado:   "resuelta",
        resuelta: Ts.now()
      });
    } catch(e) { alert("Error al resolver la incidencia."); console.error(e); }
  };
})();
