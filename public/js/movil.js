// Vista movil para el personal de almacen: donde esta cada lanzadera, cuanto
// lleva y chat con los conductores.
//
// Es una pagina aparte del panel a proposito. El panel carga ocho colecciones y
// dibuja rejillas, informes y costes; aqui solo hacen falta cuatro documentos de
// estado en vivo, cuatro de conductor y el chat del dia. Va mas rapida y gasta
// muchas menos lecturas, que es lo que importa con varios moviles abiertos toda
// la jornada.

(function () {
  "use strict";

  var ALMACENES_PEDIDOS = [
    { id: "avitrans", nombre: "Avitrans" },
    { id: "caserfri", nombre: "Caserfri" },
    { id: "txt",      nombre: "Txt" }
  ];

  var NAVE_NOMBRE = {
    caserfri: "Caserfri", merca: "Merca", arento: "Arento", avitrans: "Avitrans",
    txt: "Txt", upasa: "Upasa", sabeco: "Sabeco", plaza: "Plaza",
    logifruit: "Logifruit", bancodealimentos: "BancoDeAlimentos"
  };
  var ACCION = { cargando: "Cargando", descargando: "Descargando", presente: "Presente" };

  var _unsubs      = [];
  var _lanz        = {};   // estado en vivo, por numero
  var _choferes    = {};
  var _mensajes    = [];
  var _tiempoMax   = 90;   // minutos; se lee de config/app
  var _vista       = "lanz";
  var _hilo        = 1;    // lanzadera seleccionada en el chat
  var _emisor      = "";
  var _perms       = { lanzaderas: false, chat: false };
  var _reloj       = null;
  var _beepInit    = false;
  var _ultimoMsgTs = 0;

  var _ptsAbiertos = [];   // pedidos_transferencia con cerrado=false
  var _recogidoHoy = { avitrans: 0, caserfri: 0, txt: 0 };
  var _pedidoHoy   = { avitrans: 0, caserfri: 0, txt: 0 };
  var _ptExpandido = null; // codigo de PT con el detalle desplegado, o null

  var ADMINS = ["mlorente@aldelis.com"];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(id) { return document.getElementById(id); }

  function hhmm(ts) {
    if (!ts) return "—";
    var d = ts.toDate ? ts.toDate() : new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // Cronometro tipo 0:24 / 1:52. En minutos sueltos por debajo de la hora seria
  // menos legible de un vistazo.
  function crono(min) {
    if (min == null || isNaN(min) || min < 0) return "—";
    var h = Math.floor(min / 60), m = Math.floor(min % 60);
    return h + ":" + String(m).padStart(2, "0");
  }

  function minutosDesde(ts) {
    if (!ts || !ts.toMillis) return null;
    return (Date.now() - ts.toMillis()) / 60000;
  }

  // ── Sesion ────────────────────────────────────────────────────────────────

  window.entrar = function () {
    var err = el("l-err");
    err.style.display = "none";
    el("l-info").style.display = "none";
    auth.signInWithEmailAndPassword(el("l-email").value.trim(), el("l-pass").value)
      .catch(function () {
        err.textContent = "Email o contrasena incorrectos.";
        err.style.display = "block";
      });
  };

  window.olvide = function () {
    var email = el("l-email").value.trim().toLowerCase();
    var err = el("l-err"), info = el("l-info");
    err.style.display = "none"; info.style.display = "none";
    if (!email || email.indexOf("@") === -1) {
      err.textContent = "Escribe tu email arriba y vuelve a pulsar.";
      err.style.display = "block";
      return;
    }
    try {
      firebase.functions().httpsCallable("enviarEmail")({ tipo: "password_reset", email: email });
    } catch (e) { console.error(e); }
    info.textContent = "Si esa direccion tiene cuenta, te llega un correo con el enlace.";
    info.style.display = "block";
  };

  window.salir = function () {
    if (!confirm("¿Cerrar sesion?")) return;
    pararTodo();
    auth.signOut();
  };

  function pararTodo() {
    _unsubs.forEach(function (u) { try { u(); } catch (e) {} });
    _unsubs = [];
    if (_reloj) { clearInterval(_reloj); _reloj = null; }
  }

  // Mismo criterio que el panel: si el usuario no tiene ficha en /permisos
  // conserva el acceso, y si la tiene se aplica de forma estricta.
  function leerPermisos(email) {
    if (ADMINS.indexOf(email) !== -1) {
      return Promise.resolve({ lanzaderas: true, chat: true });
    }
    return db.collection("permisos").doc(email).get().then(function (d) {
      if (!d.exists) return { lanzaderas: true, chat: true };
      var s = Array.isArray(d.data().secciones) ? d.data().secciones : [];
      return { lanzaderas: s.indexOf("lanzaderas") !== -1, chat: s.indexOf("chat") !== -1 };
    }).catch(function () {
      return { lanzaderas: true, chat: true };
    });
  }

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      pararTodo();
      el("login").style.display = "";
      el("app").style.display = "none";
      return;
    }
    el("login").style.display = "none";
    el("app").style.display = "";

    var email = (user.email || "").toLowerCase();
    _emisor = email.split("@")[0];

    leerPermisos(email).then(function (p) {
      _perms = p;
      if (!p.chat) {
        el("tab-chat").style.display = "none";
        if (_vista === "chat") irA("lanz");
      }
      if (!p.lanzaderas) {
        el("vista-lanz").innerHTML =
          "<div class='vacio'>Tu usuario no tiene acceso a lanzaderas.<br>Pideselo a un administrador.</div>";
        el("tab-recog").style.display = "none";
        if (_vista === "recog") irA("lanz");
      }
      arrancar();
    });

    if (typeof initPush === "function") initPush("almacen");
  });

  // ── Datos ─────────────────────────────────────────────────────────────────

  function arrancar() {
    pararTodo();

    _unsubs.push(db.collection("config").doc("app").onSnapshot(function (d) {
      if (d.exists && d.data().tiempoMaxLanz) _tiempoMax = d.data().tiempoMaxLanz;
      pintar();
    }, function () {}));

    _unsubs.push(db.collection("config").doc("destinos").onSnapshot(function (d) {
      if (d.exists && Array.isArray(d.data().lista)) {
        d.data().lista.forEach(function (n) { NAVE_NOMBRE[n.id] = n.nombre; });
        pintar();
      }
    }, function () {}));

    if (_perms.lanzaderas) {
      // Cuatro documentos con el estado en vivo. Traen ya la ubicacion y el
      // "desde", asi que no hace falta tocar el historico.
      _unsubs.push(db.collection("lanzaderas").onSnapshot(function (s) {
        _lanz = {};
        s.forEach(function (d) { _lanz[d.id] = d.data(); });
        pintar();
      }, function (e) { console.error("lanzaderas:", e); }));

      _unsubs.push(db.collection("lanzaderas_chofer").onSnapshot(function (s) {
        _choferes = {};
        s.forEach(function (d) { _choferes[d.id] = d.data(); });
        pintar();
      }, function (e) { console.error("choferes:", e); }));

      // Pedidos pendientes de recoger en almacenes externos (misma logica que
      // el panel de admin, resumida para movil).
      _unsubs.push(db.collection("pedidos_transferencia").where("cerrado", "==", false).onSnapshot(function (s) {
        _ptsAbiertos = [];
        s.forEach(function (d) { _ptsAbiertos.push(Object.assign({ id: d.id }, d.data())); });
        pintar();
      }, function (e) { console.error("pedidos_transferencia:", e); }));

      var hoyRec0 = new Date(); hoyRec0.setHours(0, 0, 0, 0);
      _unsubs.push(db.collection("recogidas_palets").where("ts", ">=", firebase.firestore.Timestamp.fromDate(hoyRec0)).onSnapshot(function (s) {
        _recogidoHoy = { avitrans: 0, caserfri: 0, txt: 0 };
        s.forEach(function (d) {
          var v = d.data();
          if (_recogidoHoy.hasOwnProperty(v.almacen)) _recogidoHoy[v.almacen] += (v.palets || 0);
        });
        pintar();
      }, function (e) { console.error("recogidas_palets:", e); }));

      // Se cuenta por fecha de RECOGIDA, no de creacion: un pedido programado
      // ayer para hoy se creo ayer, pero es de hoy a todos los efectos.
      var hoyStr = new Date().toLocaleDateString("sv-SE");
      _unsubs.push(db.collection("pedidos_transferencia").where("fecha", "==", hoyStr).onSnapshot(function (s) {
        _pedidoHoy = { avitrans: 0, caserfri: 0, txt: 0 };
        s.forEach(function (d) {
          var v = d.data();
          if (_pedidoHoy.hasOwnProperty(v.almacen)) _pedidoHoy[v.almacen] += (v.palets || 0);
        });
        pintar();
      }, function (e) { console.error("pedidos_transferencia hoy:", e); }));
    }

    if (_perms.chat) {
      var hoy0 = new Date(); hoy0.setHours(0, 0, 0, 0);
      _unsubs.push(db.collection("mensajes")
        .where("ts", ">=", firebase.firestore.Timestamp.fromDate(hoy0))
        .orderBy("ts", "desc").limit(100)
        .onSnapshot(function (s) {
          var arr = [];
          s.forEach(function (d) { arr.push(d.data()); });
          arr.reverse();
          _mensajes = arr;
          avisarSiNuevo(arr);
          pintar();
        }, function (e) { console.error("mensajes:", e); }));
    }

    // El cronometro se mueve solo, sin leer nada de la base de datos.
    _reloj = setInterval(pintar, 30000);
  }

  function avisarSiNuevo(arr) {
    var max = 0;
    arr.forEach(function (m) {
      if (m.de === "lanzadera" && m.ts) max = Math.max(max, m.ts.toMillis());
    });
    if (_beepInit && max > _ultimoMsgTs && navigator.vibrate) navigator.vibrate(120);
    _ultimoMsgTs = Math.max(_ultimoMsgTs, max);
    _beepInit = true;
  }

  // ── Pintado ───────────────────────────────────────────────────────────────

  function noLeidos(n) {
    var visto = +(localStorage.getItem("movilVisto_" + n) || 0);
    return _mensajes.filter(function (m) {
      return m.lanzadera === n && m.de === "lanzadera" && m.ts && m.ts.toMillis() > visto;
    }).length;
  }

  function datosLanzadera(n) {
    var d = _lanz[String(n)] || null;
    var activa = d && d.activa && d.estado !== "fuera";
    var min = activa ? minutosDesde(d.desde) : null;
    var excede = activa && d.estado === "en_nave" && min != null && min >= _tiempoMax;
    return { n: n, d: d, activa: activa, min: min, excede: excede };
  }

  function pintarLanzaderas() {
    var cont = el("vista-lanz");
    if (!cont || !_perms.lanzaderas) return;

    var lista = [1, 2, 3, 4].map(datosLanzadera);

    // Orden por urgencia: primero lo que hay que resolver, no el numero. Si
    // miras el movil dos segundos, arriba esta lo que importa.
    lista.sort(function (a, b) {
      if (a.excede !== b.excede) return a.excede ? -1 : 1;
      if (a.activa !== b.activa) return a.activa ? -1 : 1;
      return (b.min || 0) - (a.min || 0);
    });

    var alertas = lista.filter(function (x) { return x.excede; });
    var html = alertas.map(function (x) {
      return "<div class='aviso'><span>&#9888;</span><span>La " + x.n + " lleva " +
        Math.round(x.min) + " min en " + esc(NAVE_NOMBRE[x.d.nave] || x.d.nave || "?") +
        "</span></div>";
    }).join("");

    html += lista.map(function (x) {
      var n = x.n, d = x.d;
      var clase = !x.activa ? "fuera" : x.excede ? "alerta" : (d.estado === "transito" ? "transito" : "");
      var ch = _choferes[String(n)];
      var sinLeer = _perms.chat ? noLeidos(n) : 0;

      var donde, sub, etiqueta;
      if (!d) {
        donde = "<div class='donde gris'>Sin registrar</div>";
        sub = "<div class='sub'>Aun no ha fichado hoy</div>";
        etiqueta = "";
      } else if (!x.activa) {
        donde = "<div class='donde gris'>Fuera de servicio</div>";
        sub = "<div class='sub'>Ultimo registro " + hhmm(d.desde) + "</div>";
        etiqueta = "";
      } else if (d.estado === "transito") {
        donde = "<div class='donde'>&rarr; " + esc(NAVE_NOMBRE[d.destino] || d.destino || "?") + "</div>";
        sub = "<div class='sub'>En transito &middot; salio " + hhmm(d.desde) + "</div>";
        etiqueta = "TRANSITO";
      } else {
        donde = "<div class='donde'>" + esc(NAVE_NOMBRE[d.nave] || d.nave || "?") +
          (d.muelle ? " &middot; " + esc(d.muelle) : "") + "</div>";
        sub = "<div class='sub'>" + esc(ACCION[d.accion] || "En nave") +
          " &middot; desde " + hhmm(d.desde) + "</div>";
        etiqueta = x.excede ? "PARADA" : "EN NAVE";
      }

      var cronoHtml = x.activa
        ? "<div class='crono" + (x.excede ? " mal" : "") + "'>" + crono(x.min) +
          "<small>" + etiqueta + "</small></div>"
        : "<div class='crono' style='color:#D1D5DB'>—</div>";

      var pie = "";
      if (ch && ch.nombre) {
        var tel = String(ch.telefono || "").trim();
        pie = "<div class='chofer'><span class='n'>" + esc(ch.nombre) + "</span>" +
          (tel ? "<a class='btn llamar' href='tel:" + esc(tel.replace(/[^0-9+]/g, "")) + "'>Llamar</a>" : "") +
          (_perms.chat
            ? "<button class='btn chat' onclick='abrirChat(" + n + ")'>Chat" +
              (sinLeer ? "<span class='punto'>" + sinLeer + "</span>" : "") + "</button>"
            : "") +
          "</div>";
      } else {
        pie = "<div class='chofer'><span class='n gris'>Sin identificar</span>" +
          (_perms.chat
            ? "<button class='btn chat' onclick='abrirChat(" + n + ")'>Chat" +
              (sinLeer ? "<span class='punto'>" + sinLeer + "</span>" : "") + "</button>"
            : "") +
          "</div>";
      }

      return "<div class='card " + clase + "'><div class='fila'><div>" +
        "<div class='lz'>LANZADERA " + n + "</div>" + donde + sub +
        "</div>" + cronoHtml + "</div>" + pie + "</div>";
    }).join("");

    cont.innerHTML = html;
  }

  function pintarChat() {
    var cont = el("vista-chat");
    if (!cont || !_perms.chat) return;

    var hilos = "<div class='hilos'>" + [1, 2, 3, 4].map(function (n) {
      var sinLeer = noLeidos(n);
      var ch = _choferes[String(n)];
      return "<div class='hilo" + (n === _hilo ? " on" : "") + "' onclick='abrirChat(" + n + ")'>" +
        "L" + n + (ch && ch.nombre ? " &middot; " + esc(ch.nombre.split(" ")[0]) : "") +
        (sinLeer ? "<span class='punto'>" + sinLeer + "</span>" : "") + "</div>";
    }).join("") + "</div>";

    var msgs = _mensajes.filter(function (m) { return m.lanzadera === _hilo; });
    var cuerpo = msgs.length
      ? "<div class='msgs'>" + msgs.map(function (m) {
          var mio = m.de === "almacen";
          var foto = (typeof Fotos !== "undefined") ? Fotos.thumbHtml(m) : "";
          return "<div class='msg " + (mio ? "mio" : "suyo") + "'>" + foto + esc(m.texto) +
            "<div class='meta'>" + (mio ? esc(m.emisor || "Almacen") : "Lanzadera " + m.lanzadera) +
            " &middot; " + hhmm(m.ts) + "</div></div>";
        }).join("") + "</div>"
      : "<div class='vacio'>Sin mensajes hoy con la lanzadera " + _hilo + ".</div>";

    cont.innerHTML = hilos + cuerpo;

    // Marcar como leidos los de este hilo
    var ult = 0;
    msgs.forEach(function (m) { if (m.de === "lanzadera" && m.ts) ult = Math.max(ult, m.ts.toMillis()); });
    if (ult) localStorage.setItem("movilVisto_" + _hilo, String(ult));
  }

  function origenPtLabel(o) {
    if (o === "email") return "por correo";
    if (o === "manual-envases") return "envases";
    return "manual";
  }

  function pintarRecogidas() {
    var cont = el("vista-recog");
    if (!cont || !_perms.lanzaderas) return;

    var porAlmacen = {};
    ALMACENES_PEDIDOS.forEach(function (a) { porAlmacen[a.id] = { pedido: 0, recogido: 0, pts: [] }; });
    _ptsAbiertos.forEach(function (p) {
      if (p.activado === false) return; // programado a futuro
      if (!porAlmacen[p.almacen]) return;
      porAlmacen[p.almacen].pedido += (p.palets || 0);
      porAlmacen[p.almacen].recogido += (p.recogido || 0);
      porAlmacen[p.almacen].pts.push(p);
    });

    cont.innerHTML = ALMACENES_PEDIDOS.map(function (a) {
      var d = porAlmacen[a.id];
      var pendiente = Math.max(d.pedido - d.recogido, 0);
      var hoyRecogido = _recogidoHoy[a.id] || 0;
      var completado = pendiente === 0;
      var color = completado ? "#1D9E75" : (pendiente > d.pedido / 2 ? "#D41F3A" : "#E08A00");
      var totalAro = hoyRecogido + pendiente;
      var pct = totalAro > 0 ? Math.min(100, Math.round((hoyRecogido / totalAro) * 100)) : (completado ? 100 : 0);
      var donutBg = (totalAro > 0 || completado)
        ? "conic-gradient(#1D9E75 0% " + pct + "%, " + color + " " + pct + "% 100%)"
        : "#E5E7EB";

      var lista = d.pts.slice().sort(function (x, y) {
        return Math.max((y.palets || 0) - (y.recogido || 0), 0) - Math.max((x.palets || 0) - (x.recogido || 0), 0);
      }).map(function (p) {
        var pend = Math.max((p.palets || 0) - (p.recogido || 0), 0);
        var abierto = _ptExpandido === p.id;
        var lineas = Array.isArray(p.lineas) ? p.lineas : [];
        var detalle = abierto
          ? "<div class='rec-detalle'>" + (lineas.length
              ? lineas.map(function (l) { return "<div>" + esc(l.descripcion || "") +
                  (l.sscc ? " <span style='color:#B0B4BB'>(" + esc(l.sscc) + ")</span>" : "") + "</div>"; }).join("")
              : "<div>Pedido de envases sin lineas SSCC (huecos de camion).</div>") + "</div>"
          : "";
        return "<div class='rec-pt' onclick=\"toggleRecogidaDetalle('" + p.id + "')\">" +
          "<div class='rec-pt-fila'><span><span class='rec-pt-codigo'>" + esc(p.id) + "</span>" +
          "<span class='rec-pt-origen'>" + esc(origenPtLabel(p.origen)) + "</span></span>" +
          "<span class='rec-pt-pend'>" + pend + " pend.</span></div>" + detalle + "</div>";
      }).join("");

      return "<div class='rec-card'>" +
        "<div class='rec-nombre'>" + esc(a.nombre) + "</div>" +
        "<div class='rec-top'>" +
        "<div class='rec-donut' style='background:" + donutBg + "'>" +
        "<div class='rec-donut-hueco' style='color:" + color + "'>" + pendiente + "</div></div>" +
        "<div class='rec-info'>palets pendientes" + (completado ? " — completado" : "") + "<br>" +
        "Recogido hoy: <b>" + hoyRecogido + "</b><br>" +
        "Pedido hoy: <b>" + (_pedidoHoy[a.id] || 0) + "</b></div>" +
        "</div>" +
        (lista || "<div class='rec-pt' style='color:#9CA3AF'>Sin pedidos pendientes.</div>") +
        "</div>";
    }).join("");
  }

  window.toggleRecogidaDetalle = function (pt) {
    _ptExpandido = (_ptExpandido === pt) ? null : pt;
    pintarRecogidas();
  };

  function pintar() {
    var r = el("reloj");
    if (r) r.textContent = "Actualizado " + hhmm(firebase.firestore.Timestamp.now());
    if (_vista === "lanz") pintarLanzaderas();
    else if (_vista === "recog") pintarRecogidas();
    else pintarChat();
  }

  // ── Navegacion ────────────────────────────────────────────────────────────

  window.irA = function (v) {
    if (v === "chat" && !_perms.chat) return;
    if (v === "recog" && !_perms.lanzaderas) return;
    _vista = v;
    el("vista-lanz").style.display = v === "lanz" ? "" : "none";
    el("vista-recog").style.display = v === "recog" ? "" : "none";
    el("vista-chat").style.display = v === "chat" ? "" : "none";
    el("barra-escribir").style.display = v === "chat" ? "flex" : "none";
    el("tab-lanz").className = "tab" + (v === "lanz" ? " on" : "");
    el("tab-recog").className = "tab" + (v === "recog" ? " on" : "");
    el("tab-chat").className = "tab" + (v === "chat" ? " on" : "");
    el("titulo").textContent = v === "lanz" ? "Lanzaderas" : v === "recog" ? "Recogidas" : "Chat";
    pintar();
    if (v === "chat") window.scrollTo(0, document.body.scrollHeight);
  };

  window.abrirChat = function (n) {
    _hilo = n;
    irA("chat");
  };

  window.enviarFoto = function () {
    if (typeof Fotos === "undefined") return;
    Fotos.enviar({
      lanzadera: _hilo,
      de:        "almacen",
      emisor:    _emisor,
      onEstado:  function (txt) {
        var i = el("msg-texto");
        if (i) i.placeholder = txt || "Escribe un mensaje...";
      }
    });
  };

  window.enviarEmoji = function (emoji) {
    db.collection("mensajes").add({
      lanzadera: _hilo,
      de:        "almacen",
      emisor:    _emisor,
      texto:     emoji,
      ts:        firebase.firestore.Timestamp.now()
    }).catch(function (e) { console.error("enviar:", e); });
  };

  window.enviarMensaje = function () {
    var inp = el("msg-texto");
    var texto = inp.value.trim();
    if (!texto) return;
    inp.value = "";
    db.collection("mensajes").add({
      lanzadera: _hilo,
      de:        "almacen",
      emisor:    _emisor,
      texto:     texto,
      ts:        firebase.firestore.Timestamp.now()
    }).catch(function (e) {
      console.error("enviar:", e);
      alert("No se pudo enviar el mensaje.");
      inp.value = texto;
    });
  };
})();
