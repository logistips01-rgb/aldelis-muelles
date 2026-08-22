import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import fs from "fs";
import { addDoc, collection, setDoc, doc, getDoc, Timestamp } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "aldelis-ubicperm",
  firestore: { rules: fs.readFileSync("/home/user/aldelis-muelles/firestore.rules","utf8"), host:"127.0.0.1", port:8080 }
});
const admin = () => env.authenticatedContext("uid_a", { email:"mlorente@aldelis.com" }).firestore();
const conAcceso = () => env.authenticatedContext("uid_b", { email:"garita@aldelis.com" }).firestore();
const sinFicha  = () => env.authenticatedContext("uid_c", { email:"nuevo@aldelis.com" }).firestore();
const otraFicha = () => env.authenticatedContext("uid_d", { email:"otro@aldelis.com" }).firestore();

let pass=0, fail=0;
async function t(n,f){ try{ await f(); console.log("  OK   "+n); pass++; }
  catch(e){ console.log("  FALLO "+n+"\n         "+String(e.message).split("\n")[0]); fail++; } }

function alta(email, extra){ return Object.assign({
  sscc:"S1", producto:"Costillas", lote:"L1", caducidad:null,
  pasillo:"P3", nivel:"suelo", posicion:1,
  fecha_ubicacion: Timestamp.now(), usuario_ubicacion:email,
  fecha_baja:null, usuario_baja:null, activo:true
}, extra||{}); }

await env.withSecurityRulesDisabled(async c => {
  const db = c.firestore();
  await setDoc(doc(db,"permisos","garita@aldelis.com"), { secciones:["ubicacion"] });
  await setDoc(doc(db,"permisos","otro@aldelis.com"),    { secciones:["lanzaderas"] }); // ficha, pero SIN ubicacion
});

console.log("\n=== Sin refuerzo progresivo: sin ficha = sin acceso ===");
await t("un usuario SIN ficha en /permisos NO puede leer", () =>
  assertFails(addDoc(collection(sinFicha(),"ubicaciones_palet"), alta("nuevo@aldelis.com"))));
await t("un usuario con ficha que NO incluye ubicacion tampoco puede", () =>
  assertFails(addDoc(collection(otraFicha(),"ubicaciones_palet"), alta("otro@aldelis.com"))));

console.log("\n=== Con la seccion concedida, funciona igual que antes ===");
await t("usuario con seccion ubicacion puede dar de alta", () =>
  assertSucceeds(addDoc(collection(conAcceso(),"ubicaciones_palet"), alta("garita@aldelis.com"))));
await t("el admin sigue teniendo acceso total", () =>
  assertSucceeds(addDoc(collection(admin(),"ubicaciones_palet"), alta("mlorente@aldelis.com"))));

let id;
await env.withSecurityRulesDisabled(async c => {
  const r = await addDoc(collection(c.firestore(),"ubicaciones_palet"), alta("garita@aldelis.com"));
  id = r.id;
});
await t("usuario con la seccion puede leer", () => assertSucceeds(getDoc(doc(conAcceso(),"ubicaciones_palet",id))));
await t("usuario sin ficha no puede leer", () => assertFails(getDoc(doc(sinFicha(),"ubicaciones_palet",id))));

console.log("\n=========================================");
console.log("  " + pass + " correctos, " + fail + " fallos");
console.log("=========================================\n");
await env.cleanup();
process.exit(fail?1:0);
