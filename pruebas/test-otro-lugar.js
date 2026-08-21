// Simula el navegador del conductor y recorre el flujo de "Otro lugar",
// comprobando que lo escrito llega a Firestore en el campo nave/destino.
const fs = require("fs"), vm = require("vm");
const src = fs.readFileSync("/home/user/aldelis-muelles/public/js/lanzadera.js", "utf8");

function montar(opts) {
  const escrituras = [];
  const store = Object.assign({ chofer_datos: JSON.stringify({nombre:"Juan",telefono:"600111222"}) }, opts.localStorage||{});
  const campos = {};   // valores de los inputs por id

  const nodo = (id) => ({
    get value(){ return campos[id] || ""; },
    set value(v){ campos[id] = v; },
    set innerHTML(v){ this._h = v; }, get innerHTML(){ return this._h || ""; },
    style: {}, textContent: "", focus(){}, placeholder: ""
  });
  const nodos = {};
  const getEl = (id) => (nodos[id] = nodos[id] || nodo(id));

  const col = (c) => ({
    doc: () => ({
      set: (d) => { escrituras.push({col:c, datos:d}); return Promise.resolve(); },
      get: () => Promise.resolve({ exists:false, data:()=>({}) }),
      onSnapshot: (cb) => { cb({exists:false,data:()=>({})}); return ()=>{}; }
    }),
    add: (d) => { escrituras.push({col:c, datos:d}); return Promise.resolve({id:"nuevo"}); },
    where(){return this;}, orderBy(){return this;}, limit(){return this;},
    onSnapshot:(cb)=>{ cb({forEach(){}}); return ()=>{}; }
  });

  const ctx = {
    console:{log(){},warn(){},error(){}},
    location:{search:opts.search||""}, URLSearchParams,
    localStorage:{ getItem:k=>(k in store?store[k]:null), setItem:(k,v)=>{store[k]=v;}, removeItem:k=>{delete store[k];} },
    document:{ getElementById:getEl, addEventListener(){}, createElement:()=>({style:{},appendChild(){},click(){}}), body:{appendChild(){},removeChild(){}}, head:{appendChild(){}} },
    setInterval(){}, clearInterval(){}, setTimeout:(f)=>f&&f(), navigator:{}, alert(){}, confirm:()=>true,
    firebase:{ firestore: Object.assign(()=>({collection:col}),
      { Timestamp:{ now:()=>({toMillis:()=>Date.now(),toDate:()=>new Date()}),
                    fromDate:d=>({toMillis:()=>d.getTime()}), fromMillis:m=>({toMillis:()=>m}) } }) }
  };
  ctx.db = ctx.firebase.firestore();
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  // sel se declara con let, asi que no es propiedad del contexto: hay que
  // evaluar dentro para leerlo o modificarlo.
  const dentro = (codigo) => vm.runInContext(codigo, ctx);
  return { ctx, escrituras, store, campos, dentro };
}

let pass=0, fail=0;
async function t(n,f){ try{ await f(); console.log("  OK   "+n); pass++; }
  catch(e){ console.log("  FALLO "+n+"\n         "+e.message); fail++; } }
function contiene(txt, sub, que){ if (String(txt).indexOf(sub)===-1) throw new Error((que||"")+" no contiene '"+sub+"'"); }

(async () => {
console.log("\n=== El boton aparece en las dos pantallas ===");
await t("'Otro lugar' en la pantalla de donde estas", () => {
  const r = montar({ search:"?l=2" });
  r.ctx.render();
  contiene(r.ctx.document.getElementById("app").innerHTML, "Otro lugar", "la pantalla de naves");
  contiene(r.ctx.document.getElementById("app").innerHTML, "pedirOtroLugar('estoy')", "el onclick");
});
await t("'Otro lugar' en la pantalla de hacia donde vas", () => {
  const r = montar({ search:"?l=2" });
  r.ctx.renderDestino("", false);
  contiene(r.ctx.document.getElementById("app").innerHTML, "pedirOtroLugar('voy')", "la pantalla de destino");
});

console.log("\n=== Registrar estando en un sitio no listado ===");
await t("guarda el nombre escrito en el campo nave", async () => {
  const r = montar({ search:"?l=2" });
  r.ctx.pedirOtroLugar("estoy");
  r.campos["otro-nombre"] = "Mercadona Plaza";
  r.ctx.confirmarOtroLugar("estoy");
  await r.ctx.registrar();
  const log = r.escrituras.filter(e => e.col === "lanzaderas_log");
  if (!log.length) throw new Error("no registro el movimiento");
  const d = log[0].datos;
  if (d.nave !== "Mercadona Plaza") throw new Error("nave = " + d.nave);
  if (d.accion !== "presente") throw new Error("accion = " + d.accion);
  if (d.muelle !== null) throw new Error("muelle deberia ser null, es " + d.muelle);
  if (d.estado !== "en_nave") throw new Error("estado = " + d.estado);
});
await t("un nombre de una letra se rechaza", () => {
  const r = montar({ search:"?l=2" });
  r.ctx.pedirOtroLugar("estoy");
  r.campos["otro-nombre"] = "x";
  r.ctx.confirmarOtroLugar("estoy");
  const nave = r.dentro("sel.nave");
  if (nave) throw new Error("no deberia aceptarlo, nave = " + nave);
});

console.log("\n=== Salir hacia un sitio no listado ===");
await t("guarda el nombre en el campo destino", async () => {
  const r = montar({ search:"?l=2" });
  r.dentro("sel.nave='plaza'; sel.muelle='M6'; sel.accion='cargando';");
  r.ctx.pedirOtroLugar("voy");
  r.campos["otro-nombre"] = "Taller Ruiz";
  r.ctx.confirmarOtroLugar("voy");
  // confirmarOtroLugar no devuelve la promesa del registro: hay que ceder el
  // turno para que la escritura llegue a producirse.
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  const log = r.escrituras.filter(e => e.col === "lanzaderas_log");
  if (!log.length) throw new Error("no registro el transito");
  const d = log[log.length-1].datos;
  if (d.destino !== "Taller Ruiz") throw new Error("destino = " + d.destino);
  if (d.estado !== "transito") throw new Error("estado = " + d.estado);
});

console.log("\n=== Recuerda los ultimos sitios en el movil ===");
await t("guarda el sitio escrito para reutilizarlo", () => {
  const r = montar({ search:"?l=2" });
  r.ctx.pedirOtroLugar("estoy");
  r.campos["otro-nombre"] = "Mercadona Plaza";
  r.ctx.confirmarOtroLugar("estoy");
  const l = JSON.parse(r.store.otros_lugares || "[]");
  if (l[0] !== "Mercadona Plaza") throw new Error("recientes = " + JSON.stringify(l));
});
await t("los ofrece como botones la vez siguiente", () => {
  const r = montar({ search:"?l=2", localStorage:{ otros_lugares: JSON.stringify(["Taller Ruiz","Mercadona Plaza"]) } });
  r.ctx.pedirOtroLugar("estoy");
  const h = r.ctx.document.getElementById("app").innerHTML;
  contiene(h, "Taller Ruiz", "los recientes");
  contiene(h, "Mercadona Plaza", "los recientes");
});
await t("no duplica y pone el ultimo primero", () => {
  const r = montar({ search:"?l=2", localStorage:{ otros_lugares: JSON.stringify(["Taller Ruiz","Mercadona Plaza"]) } });
  r.ctx.usarOtroLugar("estoy", "Mercadona Plaza");
  const l = JSON.parse(r.store.otros_lugares);
  if (l[0] !== "Mercadona Plaza") throw new Error("no lo puso primero: " + JSON.stringify(l));
  if (l.length !== 2) throw new Error("duplico: " + JSON.stringify(l));
});
await t("guarda como maximo 6", () => {
  const muchos = ["a","b","c","d","e","f"];
  const r = montar({ search:"?l=2", localStorage:{ otros_lugares: JSON.stringify(muchos) } });
  r.ctx.usarOtroLugar("estoy", "nuevo sitio");
  const l = JSON.parse(r.store.otros_lugares);
  if (l.length !== 6) throw new Error("guardo " + l.length);
  if (l[0] !== "nuevo sitio") throw new Error("orden mal");
});

console.log("\n=== No se rompe la pantalla de confirmacion ===");
await t("muestra el nombre escrito, no 'undefined'", () => {
  const r = montar({ search:"?l=2" });
  r.dentro("sel.nave='Mercadona Plaza'; sel.accion='presente';");
  r.ctx.renderConfirmar();
  const h = r.ctx.document.getElementById("app").innerHTML;
  contiene(h, "Mercadona Plaza", "la confirmacion");
  if (h.indexOf("undefined") !== -1) throw new Error("aparece 'undefined'");
});
await t("la pantalla de registrado tampoco dice 'undefined'", () => {
  const r = montar({ search:"?l=2" });
  r.dentro("sel.nave='Mercadona Plaza';");
  r.ctx.renderHecho("en_nave");
  const h = r.ctx.document.getElementById("app").innerHTML;
  contiene(h, "Mercadona Plaza", "la pantalla de registrado");
  if (h.indexOf("undefined") !== -1) throw new Error("aparece 'undefined'");
});
await t("en transito muestra el destino escrito", () => {
  const r = montar({ search:"?l=2" });
  r.dentro("sel.destino='Taller Ruiz';");
  r.ctx.renderHecho("transito");
  const h = r.ctx.document.getElementById("app").innerHTML;
  contiene(h, "Taller Ruiz", "la pantalla de transito");
  if (h.indexOf("undefined") !== -1) throw new Error("aparece 'undefined'");
});

console.log("\n=========================================");
console.log("  " + pass + " correctos, " + fail + " fallos");
console.log("=========================================\n");
process.exit(fail?1:0);
})();
