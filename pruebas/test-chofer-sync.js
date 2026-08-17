// Simula el navegador de un conductor y comprueba que la identidad guardada en
// el movil llega a Firestore, que es el fallo que hubo que arreglar.
const fs = require("fs");
const src = fs.readFileSync("/home/user/aldelis-muelles/public/js/lanzadera.js", "utf8");

function montar(opciones) {
  const escrituras = [];
  const store = Object.assign({}, opciones.localStorage || {});

  const doc = (col) => (id) => ({
    set: (d) => { escrituras.push({ col, id, datos: d }); return Promise.resolve(); },
    get: () => Promise.resolve({ exists: false, data: () => ({}) }),
    onSnapshot: (cb) => { cb({ exists: false, data: () => ({}) }); return () => {}; }
  });

  const ctx = {
    console: { log(){}, warn(){}, error(){} },
    location: { search: opciones.search || "" },
    URLSearchParams,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; }
    },
    document: {
      getElementById: () => ({ innerHTML: "", value: "", style: {}, textContent: "" }),
      addEventListener(){}, createElement: () => ({ style:{}, appendChild(){} }),
      body: { appendChild(){} }, head: { appendChild(){} }
    },
    window: {},
    setInterval(){}, clearInterval(){}, setTimeout(){},
    navigator: {},
    alert(){}, confirm: () => true,
    firebase: {
      firestore: Object.assign(() => ({ collection: (c) => ({ doc: doc(c), add: (d) => { escrituras.push({col:c,id:"(add)",datos:d}); return Promise.resolve(); }, where(){return this;}, orderBy(){return this;}, limit(){return this;}, onSnapshot:(cb)=>{cb({forEach(){}}); return ()=>{};} }) }),
        { Timestamp: { now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }), fromDate: (d) => ({ toMillis: () => d.getTime(), toDate: () => d }), fromMillis: (m) => ({ toMillis: () => m, toDate: () => new Date(m) }) } })
    }
  };
  ctx.db = ctx.firebase.firestore();
  ctx.window = ctx;

  const vm = require("vm");
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { escrituras, store, ctx };
}

let pass = 0, fail = 0;
function t(nombre, f) {
  try { f(); console.log("  OK   " + nombre); pass++; }
  catch (e) { console.log("  FALLO " + nombre + "\n         " + e.message); fail++; }
}

const IDENT = JSON.stringify({ nombre: "Juan Perez", telefono: "600111222" });

console.log("\n=== El fallo que habia que arreglar ===");
t("conductor con datos ya guardados abre su QR: escribe en Firestore", () => {
  const r = montar({ search: "?l=2", localStorage: { chofer_datos: IDENT } });
  const w = r.escrituras.filter(x => x.col === "lanzaderas_chofer");
  if (!w.length) throw new Error("no escribio nada en lanzaderas_chofer");
  if (w[0].id !== "2") throw new Error("escribio en la lanzadera " + w[0].id);
  if (w[0].datos.nombre !== "Juan Perez") throw new Error("nombre: " + w[0].datos.nombre);
  if (w[0].datos.telefono !== "600111222") throw new Error("telefono: " + w[0].datos.telefono);
});

console.log("\n=== Lo que no debe hacer ===");
t("sin datos guardados no escribe (esperara el formulario)", () => {
  const r = montar({ search: "?l=2" });
  const w = r.escrituras.filter(x => x.col === "lanzaderas_chofer");
  if (w.length) throw new Error("no deberia escribir sin identidad");
});
t("sin lanzadera en el QR no escribe (aun no sabe cual)", () => {
  const r = montar({ search: "", localStorage: { chofer_datos: IDENT } });
  const w = r.escrituras.filter(x => x.col === "lanzaderas_chofer");
  if (w.length) throw new Error("no deberia escribir sin saber la lanzadera");
});

console.log("\n=== Migracion de las claves antiguas ===");
t("migra chofer_lanz_3 a la clave nueva y borra la vieja", () => {
  const r = montar({ search: "?l=3", localStorage: { chofer_lanz_3: IDENT } });
  if (!r.store.chofer_datos) throw new Error("no migro a chofer_datos");
  if (r.store.chofer_lanz_3) throw new Error("no borro la clave vieja");
  const w = r.escrituras.filter(x => x.col === "lanzaderas_chofer");
  if (!w.length) throw new Error("no escribio tras migrar");
});

console.log("\n=========================================");
console.log("  " + pass + " correctos, " + fail + " fallos");
console.log("=========================================\n");
process.exit(fail ? 1 : 0);
