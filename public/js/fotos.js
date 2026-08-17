// Fotos en el chat de lanzaderas. Lo usan las tres vistas: la del conductor,
// el panel y la vista movil.
//
// Por que no se usa Firebase Storage: no esta configurado en el proyecto y ya
// dio problemas de CORS. Las fotos se guardan en Firestore, redimensionadas en
// el propio movil antes de subirlas.
//
// Por que la foto completa NO va dentro del mensaje: el chat se lee con un
// listener de los mensajes del dia, y los moviles reconectan constantemente. Si
// la foto fuera dentro, cada reconexion descargaria todas las fotos del dia. Asi
// que en el mensaje viaja solo una miniatura (unos pocos KB) y la foto completa
// vive en /fotos, que se pide unicamente al tocarla.

(function () {
  "use strict";

  var MAX_LADO_FOTO  = 1280;   // px del lado mayor de la foto completa
  var MAX_LADO_THUMB = 200;    // px del lado mayor de la miniatura
  var TOPE_B64       = 700000; // caracteres; el documento de Firestore no pasa de 1 MB
  var TOPE_THUMB     = 30000;

  function leerComoImagen(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen")); };
      img.src = url;
    });
  }

  // Redimensiona a JPEG y devuelve el base64 sin la cabecera "data:".
  function aBase64(img, maxLado, calidad) {
    var escala = Math.min(1, maxLado / Math.max(img.width, img.height));
    var w = Math.max(1, Math.round(img.width  * escala));
    var h = Math.max(1, Math.round(img.height * escala));
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";           // las fotos con transparencia no salen negras
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", calidad).split(",")[1];
  }

  // Baja calidad y tamaño hasta entrar en el tope. Con fotos de movil actuales
  // basta la primera pasada, pero una camara de 48 Mpx puede necesitar mas.
  function comprimir(img, maxLado, tope) {
    var intentos = [
      { lado: maxLado,     calidad: 0.72 },
      { lado: maxLado,     calidad: 0.55 },
      { lado: maxLado * 0.75, calidad: 0.5 },
      { lado: maxLado * 0.6,  calidad: 0.45 }
    ];
    var b64 = null;
    for (var i = 0; i < intentos.length; i++) {
      b64 = aBase64(img, intentos[i].lado, intentos[i].calidad);
      if (b64.length <= tope) return b64;
    }
    return b64.length <= tope ? b64 : null;
  }

  // ── Enviar ────────────────────────────────────────────────────────────────
  // ctx: { lanzadera, de: "almacen"|"lanzadera", emisor, onEstado(texto|null) }
  function enviar(ctx) {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.setAttribute("capture", "environment");   // en el movil abre la camara
    inp.style.display = "none";
    document.body.appendChild(inp);

    inp.onchange = function () {
      var file = inp.files && inp.files[0];
      document.body.removeChild(inp);
      if (!file) return;
      subir(file, ctx);
    };
    inp.click();
  }

  async function subir(file, ctx) {
    var aviso = ctx.onEstado || function () {};
    try {
      aviso("Preparando la foto...");
      var img = await leerComoImagen(file);

      var b64   = comprimir(img, MAX_LADO_FOTO,  TOPE_B64);
      var thumb = comprimir(img, MAX_LADO_THUMB, TOPE_THUMB);
      if (!b64 || !thumb) throw new Error("La foto es demasiado grande");

      aviso("Enviando...");
      var db = firebase.firestore();
      var Ts = firebase.firestore.Timestamp;

      // Primero la foto: si falla, no queda un mensaje apuntando a nada.
      var ref = await db.collection("fotos").add({
        b64:       b64,
        lanzadera: ctx.lanzadera,
        de:        ctx.de,
        ts:        Ts.now()
      });

      var msg = {
        lanzadera: ctx.lanzadera,
        de:        ctx.de,
        texto:     "",
        foto:      ref.id,
        thumb:     thumb,
        ts:        Ts.now()
      };
      if (ctx.emisor) msg.emisor = ctx.emisor;
      await db.collection("mensajes").add(msg);

      aviso(null);
    } catch (e) {
      console.error("foto:", e);
      aviso(null);
      alert("No se pudo enviar la foto. " + (e.message || ""));
    }
  }

  // ── Ver ───────────────────────────────────────────────────────────────────

  function overlay() {
    var d = document.getElementById("foto-overlay");
    if (d) return d;
    d = document.createElement("div");
    d.id = "foto-overlay";
    d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;" +
      "display:none;align-items:center;justify-content:center;padding:12px";
    d.onclick = function () { d.style.display = "none"; d.innerHTML = ""; };
    document.body.appendChild(d);
    return d;
  }

  async function ver(fotoId) {
    var d = overlay();
    d.innerHTML = "<div style='color:#fff;font:14px system-ui'>Cargando foto...</div>";
    d.style.display = "flex";
    try {
      var doc = await firebase.firestore().collection("fotos").doc(fotoId).get();
      if (!doc.exists) {
        d.innerHTML = "<div style='color:#fff;font:14px system-ui;text-align:center;line-height:1.6'>" +
          "Esta foto ya no esta disponible.<br><span style='color:#9CA3AF;font-size:13px'>" +
          "Las fotos se borran a los 3 dias.</span></div>";
        return;
      }
      d.innerHTML = "<img src='data:image/jpeg;base64," + doc.data().b64 +
        "' style='max-width:100%;max-height:100%;border-radius:8px'>";
    } catch (e) {
      console.error("ver foto:", e);
      d.innerHTML = "<div style='color:#fff;font:14px system-ui'>No se pudo cargar la foto.</div>";
    }
  }

  // HTML de la miniatura dentro de una burbuja de chat.
  function thumbHtml(msg) {
    if (!msg.thumb) return "";
    var onclick = msg.foto ? " onclick=\"Fotos.ver('" + msg.foto + "')\"" : "";
    return "<img src='data:image/jpeg;base64," + msg.thumb + "'" + onclick +
      " style='display:block;max-width:190px;width:100%;border-radius:8px;margin:2px 0 4px;cursor:pointer'>";
  }

  window.Fotos = { enviar: enviar, ver: ver, thumbHtml: thumbHtml };
})();
