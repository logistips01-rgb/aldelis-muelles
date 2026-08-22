// Modulo de ubicacion de palets en la camara frigorifica. Independiente del
// resto de la app a proposito: coleccion propia (ubicaciones_palet), reglas
// propias, sin Cloud Functions ni relacion con ninguna otra pantalla. Un fallo
// aqui no puede tocar reservas, lanzaderas, bizerba ni los informes.
//
// Puerta de acceso: por ahora solo ADMINS (igual que esAdmin() en las reglas).
// El filtro real de seguridad esta en firestore.rules; esto solo evita que un
// no-admin vea la pantalla vacia y confusa.
//
// Portado desde un prototipo HTML/JS con almacenamiento local: misma logica y
// misma experiencia, con Firestore en tiempo real en lugar de window.storage.

(function () {
  "use strict";

  const ADMINS = ["mlorente@aldelis.com"];

  const NIVELES_ORDEN_VISUAL = [
    { key: "cota3", label: "Cota 3" },
    { key: "cota2", label: "Cota 2" },
    { key: "cota1", label: "Cota 1" },
    { key: "suelo", label: "Suelo" }
  ];
  const N_UBIC = 16;
  const PASILLOS = ["P3", "P4"];
  const PASILLO_LABEL = { P3: "Pasillo 3", P4: "Pasillo 4" };

  let state = defaultState();
  let currentPasillo = "P3";
  let selectedProducto = null;
  let selectedCell = null;
  let miEmail = null;
  let unsub = null;

  function defaultState() {
    const s = {};
    PASILLOS.forEach(p => {
      s[p] = {};
      NIVELES_ORDEN_VISUAL.forEach(n => { s[p][n.key] = new Array(N_UBIC).fill(null); });
    });
    return s;
  }

  function el(id) { return document.getElementById(id); }

  // ── Sesion ──────────────────────────────────────────────────────────────

  window.entrar = function () {
    const err = el("l-err");
    err.style.display = "none";
    auth.signInWithEmailAndPassword(el("l-email").value.trim(), el("l-pass").value)
      .catch(() => {
        err.textContent = "Email o contraseña incorrectos.";
        err.style.display = "block";
      });
  };

  auth.onAuthStateChanged(user => {
    if (unsub) { unsub(); unsub = null; }

    if (!user) {
      el("login").style.display = "";
      el("sin-acceso").style.display = "none";
      el("app").style.display = "none";
      return;
    }

    miEmail = (user.email || "").toLowerCase();
    el("login").style.display = "none";

    if (ADMINS.indexOf(miEmail) === -1) {
      el("sin-acceso").style.display = "";
      el("app").style.display = "none";
      return;
    }

    el("sin-acceso").style.display = "none";
    el("app").style.display = "";
    arrancar();
  });

  // ── Datos en tiempo real ────────────────────────────────────────────────
  // Se lee solo lo activo: el volumen de trabajo real (como mucho 128
  // ubicaciones) no crece aunque el historico de bajas crezca con los meses.

  function arrancar() {
    unsub = db.collection("ubicaciones_palet")
      .where("activo", "==", true)
      .onSnapshot(snap => {
        state = defaultState();
        snap.forEach(doc => {
          const d = doc.data();
          if (!state[d.pasillo] || !state[d.pasillo][d.nivel]) return;
          const idx = d.posicion - 1;
          if (idx < 0 || idx >= N_UBIC) return;
          state[d.pasillo][d.nivel][idx] = {
            _id: doc.id,
            sscc: d.sscc, producto: d.producto, lote: d.lote,
            caducidad: d.caducidad || null,
            fecha: d.fecha_ubicacion
          };
        });
        render();
      }, e => {
        console.error("ubicaciones_palet:", e);
        showToast("No se pudo conectar con la camara. Revisa tu conexion.");
      });
  }

  function showToast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._tid);
    showToast._tid = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function allSlots() {
    const out = [];
    PASILLOS.forEach(p => {
      NIVELES_ORDEN_VISUAL.forEach(n => {
        state[p][n.key].forEach((slot, i) => { if (slot) out.push({ pasillo: p, nivel: n.key, idx: i, ...slot }); });
      });
    });
    return out;
  }

  function findSSCC(sscc) { return allSlots().find(s => s.sscc === sscc) || null; }
  function nivelLabel(key) { return NIVELES_ORDEN_VISUAL.find(n => n.key === key).label; }

  function setHint(text, cls) {
    const h = el("hint");
    h.textContent = text;
    h.className = "hint " + cls;
  }

  function updateHintForInput() {
    const val = el("sscc-input").value.trim();
    if (!val) { setHint("Escanea un SSCC para ubicarlo o localizarlo.", "info"); clearHighlight(); el("quick-remove-btn").style.display = "none"; return; }
    const found = findSSCC(val);
    const quickBtn = el("quick-remove-btn");
    if (found) {
      setHint("Este SSCC ya esta en " + PASILLO_LABEL[found.pasillo] + ", " + nivelLabel(found.nivel) + ", ubicacion " + String(found.idx + 1).padStart(2, "0") + ". Puedes verlo en el mapa o darlo de baja directamente.", "locate");
      highlightCell(found.pasillo, found.nivel, found.idx);
      quickBtn.style.display = "block";
    } else {
      if (!selectedProducto) setHint("SSCC nuevo. Selecciona el producto, añade el lote y toca una ubicacion libre.", "place");
      else if (!el("lote-input").value.trim()) setHint("Añade el numero de lote antes de ubicar el palet.", "warn");
      else setHint("Toca una ubicacion libre en el " + PASILLO_LABEL[currentPasillo] + " para colocar este palet.", "place");
      clearHighlight();
      quickBtn.style.display = "none";
    }
  }

  function clearHighlight() { document.querySelectorAll(".cell.highlight").forEach(c => c.classList.remove("highlight")); }

  function highlightCell(pasillo, nivel, idx) {
    if (pasillo !== currentPasillo) { currentPasillo = pasillo; renderTabs(); renderRack(); }
    clearHighlight();
    const cel = document.querySelector('.cell[data-nivel="' + nivel + '"][data-idx="' + idx + '"]');
    if (cel) { cel.classList.add("highlight"); cel.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }); }
  }

  function computeFefoNext() {
    // Caducidad mas proxima por producto; si ninguno de esa referencia tiene
    // caducidad registrada, se usa el mas antiguo por fecha de ubicacion.
    const next = {};
    ["Costillas", "Alitas"].forEach(producto => {
      const items = allSlots().filter(s => s.producto === producto);
      if (!items.length) { next[producto] = null; return; }
      const withExp = items.filter(s => s.caducidad);
      next[producto] = withExp.length
        ? withExp.reduce((a, b) => (a.caducidad < b.caducidad ? a : b))
        : items.reduce((a, b) => (tsMillis(a.fecha) < tsMillis(b.fecha) ? a : b));
    });
    return next;
  }

  function tsMillis(ts) { return ts && ts.toMillis ? ts.toMillis() : 0; }

  function render() { renderStats(); renderTabs(); renderRack(); updateHintForInput(); }

  function renderStats() {
    let libres = 0, ocupadas = 0, costillas = 0, alitas = 0;
    PASILLOS.forEach(p => NIVELES_ORDEN_VISUAL.forEach(n => state[p][n.key].forEach(slot => {
      if (slot) { ocupadas++; if (slot.producto === "Costillas") costillas++; else alitas++; } else libres++;
    })));
    el("stat-libres").textContent = libres;
    el("stat-ocupadas").textContent = ocupadas;
    el("stat-costillas").textContent = costillas;
    el("stat-alitas").textContent = alitas;
  }

  function renderTabs() {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.pasillo === currentPasillo));
    PASILLOS.forEach(p => {
      let ocupadas = 0;
      NIVELES_ORDEN_VISUAL.forEach(n => state[p][n.key].forEach(s => { if (s) ocupadas++; }));
      el("sub-" + p).textContent = ocupadas + " / 64";
    });
  }

  function renderRack() {
    const fefoNext = computeFefoNext();
    const fefoKeys = new Set(Object.values(fefoNext).filter(Boolean).map(s => s.pasillo + "|" + s.nivel + "|" + s.idx));

    // Pasillo 4 en espejo respecto al 3: la ubicacion 16 queda a la izquierda,
    // para que coincida con la vista fisica real de la nave. Es solo orden de
    // dibujado, el dato de "posicion" no cambia.
    const displayOrder = [];
    for (let i = 0; i < N_UBIC; i++) displayOrder.push(i);
    if (currentPasillo === "P4") displayOrder.reverse();

    let html = "<div class='loc-header-row'><div class='sticky-col'>Cota / Ubic.</div>";
    displayOrder.forEach(i => { html += "<div class='col-num'>" + String(i + 1).padStart(2, "0") + "</div>"; });
    html += "</div>";

    NIVELES_ORDEN_VISUAL.forEach(n => {
      html += "<div class='level-row " + (n.key === "suelo" ? "suelo" : "") + "'>";
      html += "<div class='sticky-col'>" + n.label + "</div>";
      displayOrder.forEach(i => {
        const slot = state[currentPasillo][n.key][i];
        const isFefo = fefoKeys.has(currentPasillo + "|" + n.key + "|" + i);
        if (slot) {
          const cls = slot.producto === "Costillas" ? "costillas" : "alitas";
          html += "<div class='cell filled " + cls + " " + (isFefo ? "fefo-next" : "") + "' data-nivel='" + n.key + "' data-idx='" + i + "'>" +
            "<div class='lote-txt'>" + esc(slot.lote) + "</div>" +
            "<div class='sscc-tail'>…" + esc(String(slot.sscc).slice(-5)) + "</div></div>";
        } else {
          html += "<div class='cell' data-nivel='" + n.key + "' data-idx='" + i + "'><span class='empty-mark'>+</span></div>";
        }
      });
      html += "</div>";
    });

    const rack = el("rack");
    rack.innerHTML = html;
    rack.querySelectorAll(".cell").forEach(cell => {
      cell.addEventListener("click", () => onCellClick(cell.dataset.nivel, parseInt(cell.dataset.idx, 10)));
    });
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  async function onCellClick(nivel, idx) {
    const slot = state[currentPasillo][nivel][idx];
    if (slot) { openDetailSheet(currentPasillo, nivel, idx, slot); return; }

    const sscc = el("sscc-input").value.trim();
    const lote = el("lote-input").value.trim();
    const caducidad = el("caducidad-input").value || null;

    if (!sscc) { showToast("Primero escanea o escribe un SSCC."); return; }
    if (findSSCC(sscc)) { showToast("Ese SSCC ya esta ubicado en otra posicion."); return; }
    if (!selectedProducto) { showToast("Selecciona el tipo de producto: Costillas o Alitas."); return; }
    if (!lote) { showToast("Añade el numero de lote."); return; }

    try {
      await db.collection("ubicaciones_palet").add({
        sscc, producto: selectedProducto, lote, caducidad,
        pasillo: currentPasillo, nivel, posicion: idx + 1,
        fecha_ubicacion: firebase.firestore.Timestamp.now(),
        usuario_ubicacion: miEmail,
        fecha_baja: null, usuario_baja: null,
        activo: true
      });
      el("sscc-input").value = "";
      showToast("Ubicado en " + PASILLO_LABEL[currentPasillo] + ", " + nivelLabel(nivel) + ", posicion " + String(idx + 1).padStart(2, "0"));
      el("sscc-input").focus();
      // El propio listener repinta al llegar el cambio; no hace falta llamar a render() aqui.
    } catch (e) {
      console.error("ubicar:", e);
      showToast("No se pudo ubicar el palet.");
    }
  }

  function fmtFecha(ts) {
    try { return ts.toDate().toLocaleString("es-ES"); } catch (e) { return "—"; }
  }
  function fmtCaducidad(dstr) {
    if (!dstr) return null;
    const [y, m, d] = dstr.split("-");
    return d + "/" + m + "/" + y;
  }

  function openDetailSheet(pasillo, nivel, idx, slot) {
    selectedCell = { pasillo, nivel, idx, id: slot._id };
    el("sheet-tag").textContent = slot.producto;
    el("sheet-tag").className = "sheet-tag " + (slot.producto === "Costillas" ? "costillas" : "alitas");
    el("sheet-ubic").textContent = PASILLO_LABEL[pasillo] + " · " + nivelLabel(nivel) + " · Ubicacion " + String(idx + 1).padStart(2, "0");
    el("sheet-sscc").textContent = "SSCC: " + slot.sscc;
    el("sheet-lote").innerHTML = "Lote: <b>" + esc(slot.lote) + "</b>";
    el("sheet-caducidad").innerHTML = slot.caducidad ? ("Caduca: <b>" + fmtCaducidad(slot.caducidad) + "</b>") : "Sin fecha de caducidad registrada";
    el("sheet-fecha").textContent = "Ubicado el " + fmtFecha(slot.fecha);
    el("sheet-remove").disabled = false;
    showSheet("sheet");
  }

  function showSheet(id) { el("sheet-backdrop").classList.add("show"); el(id).classList.add("show"); }
  function closeSheets() {
    el("sheet-backdrop").classList.remove("show");
    el("sheet").classList.remove("show");
    el("fefo-sheet").classList.remove("show");
    el("cotejar-sheet").classList.remove("show");
    selectedCell = null;
  }

  async function darDeBaja(id) {
    await db.collection("ubicaciones_palet").doc(id).update({
      activo: false,
      fecha_baja: firebase.firestore.Timestamp.now(),
      usuario_baja: miEmail
    });
  }

  el("sheet-backdrop").addEventListener("click", closeSheets);
  el("sheet-cancel").addEventListener("click", closeSheets);
  el("fefo-cancel").addEventListener("click", closeSheets);

  el("sheet-remove").addEventListener("click", async () => {
    if (!selectedCell) return;
    const btn = el("sheet-remove");
    btn.disabled = true;
    try {
      await darDeBaja(selectedCell.id);
      closeSheets();
      showToast("Palet retirado.");
    } catch (e) {
      console.error("retirar:", e);
      showToast("No se pudo retirar el palet.");
      btn.disabled = false;
    }
  });

  el("quick-remove-btn").addEventListener("click", async () => {
    const val = el("sscc-input").value.trim();
    const found = findSSCC(val);
    if (!found) return;
    if (!confirm("¿Dar de baja el palet " + found.lote + " (" + found.producto + ") de " + PASILLO_LABEL[found.pasillo] + ", " + nivelLabel(found.nivel) + " " + String(found.idx + 1).padStart(2, "0") + "?")) return;
    try {
      await darDeBaja(found._id);
      el("sscc-input").value = "";
      showToast("Palet dado de baja.");
    } catch (e) {
      console.error("baja rapida:", e);
      showToast("No se pudo dar de baja el palet.");
    }
  });

  el("cotejar-open-btn").addEventListener("click", () => { el("cotejar-results").innerHTML = ""; showSheet("cotejar-sheet"); });
  el("cotejar-cancel").addEventListener("click", closeSheets);
  el("cotejar-file").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { el("cotejar-textarea").value = ev.target.result; };
    reader.readAsText(file);
  });

  function parseSSCCList(text) {
    const set = new Set();
    text.split(/\r?\n/).forEach(line => {
      line.split(/[,;\t]/).forEach(tok => {
        const t = tok.trim();
        if (t && t.toLowerCase() !== "sscc") set.add(t);
      });
    });
    return set;
  }

  el("cotejar-run").addEventListener("click", () => {
    const fileSet = parseSSCCList(el("cotejar-textarea").value);
    const results = el("cotejar-results");
    if (!fileSet.size) { results.innerHTML = "<div class='meta' style='margin-top:14px;'>Pega o carga un listado de SSCC primero.</div>"; return; }

    const located = allSlots();
    const locatedMap = new Map(located.map(s => [s.sscc, s]));
    const sinUbicar = [...fileSet].filter(s => !locatedMap.has(s));
    const sobrantes = located.filter(s => !fileSet.has(s.sscc));
    const coinciden = fileSet.size - sinUbicar.length;

    let html = "<div class='cotejar-summary'>" +
      "<div class='c ok'><div class='n'>" + coinciden + "</div><div class='l'>Coinciden</div></div>" +
      "<div class='c warn'><div class='n'>" + sinUbicar.length + "</div><div class='l'>Sin ubicar</div></div>" +
      "<div class='c bad'><div class='n'>" + sobrantes.length + "</div><div class='l'>No estan en el archivo</div></div></div>";

    html += "<div class='cotejar-block'><h3>Sin ubicar en la camara (" + sinUbicar.length + ")</h3>";
    html += !sinUbicar.length
      ? "<div class='meta'>Todos los SSCC del archivo estan ubicados.</div>"
      : sinUbicar.map(s => "<div class='cotejar-row'><span>" + esc(s) + "</span></div>").join("");
    html += "</div>";

    html += "<div class='cotejar-block'><h3>En la camara pero no estan en el archivo (" + sobrantes.length + ")</h3>";
    html += !sobrantes.length
      ? "<div class='meta'>No hay palets sobrantes respecto al archivo.</div>"
      : sobrantes.map(s => "<div class='cotejar-row'><span>" + esc(s.lote) + " · …" + esc(String(s.sscc).slice(-6)) + "</span><span class='loc'>" + PASILLO_LABEL[s.pasillo] + " " + nivelLabel(s.nivel) + " " + String(s.idx + 1).padStart(2, "0") + "</span></div>").join("");
    html += "</div>";

    results.innerHTML = html;
  });

  el("fefo-open-btn").addEventListener("click", () => {
    const items = allSlots();
    items.sort((a, b) => {
      const ca = a.caducidad || "9999-12-31";
      const cb = b.caducidad || "9999-12-31";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return tsMillis(a.fecha) - tsMillis(b.fecha);
    });
    const list = el("fefo-list");
    if (!items.length) {
      list.innerHTML = "<div class='meta'>Todavia no hay palets ubicados.</div>";
    } else {
      const hoy = new Date().toISOString().slice(0, 10);
      list.innerHTML = items.map((it, i) => {
        const color = it.producto === "Costillas" ? "var(--costillas)" : "var(--alitas)";
        let expHtml;
        if (it.caducidad) {
          const dias = Math.round((new Date(it.caducidad) - new Date(hoy)) / 86400000);
          expHtml = "<div class='fefo-exp " + (dias <= 3 ? "soon" : "") + "'>" + fmtCaducidad(it.caducidad) + "<br>" + (dias < 0 ? "caducado" : dias + " d.") + "</div>";
        } else {
          expHtml = "<div class='fefo-exp none'>sin fecha</div>";
        }
        return "<div class='fefo-list-item'><div class='fefo-rank'>" + (i + 1) + "</div>" +
          "<div class='fefo-dot' style='background:" + color + "'></div>" +
          "<div class='fefo-body'><div class='fefo-lote'>" + esc(it.lote) + " · " + esc(it.producto) + "</div>" +
          "<div class='fefo-loc'>" + PASILLO_LABEL[it.pasillo] + " · " + nivelLabel(it.nivel) + " · Ubic. " + String(it.idx + 1).padStart(2, "0") + "</div></div>" +
          expHtml + "</div>";
      }).join("");
    }
    showSheet("fefo-sheet");
  });

  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => { currentPasillo = t.dataset.pasillo; renderTabs(); renderRack(); updateHintForInput(); });
  });
  document.querySelectorAll(".producto-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedProducto = selectedProducto === btn.dataset.producto ? null : btn.dataset.producto;
      document.querySelectorAll(".producto-btn").forEach(b => b.classList.toggle("active", b.dataset.producto === selectedProducto));
      updateHintForInput();
    });
  });

  const scanInput = el("sscc-input");
  scanInput.addEventListener("input", updateHintForInput);
  scanInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); updateHintForInput(); } });
  el("clear-btn").addEventListener("click", () => { scanInput.value = ""; updateHintForInput(); scanInput.focus(); });
  el("lote-input").addEventListener("input", updateHintForInput);
})();
