import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import fs from "fs";
import { addDoc, collection, doc, getDoc, updateDoc, deleteDoc, Timestamp } from "firebase/firestore";

const env = await initializeTestEnvironment({
  projectId: "aldelis-ubic",
  firestore: { rules: fs.readFileSync("/home/user/aldelis-muelles/firestore.rules","utf8"), host:"127.0.0.1", port:8080 }
});
const admin = () => env.authenticatedContext("uid_a", { email:"mlorente@aldelis.com" }).firestore();
const otro  = () => env.authenticatedContext("uid_b", { email:"otro@aldelis.com" }).firestore();
const anon  = () => env.unauthenticatedContext().firestore();

let pass=0, fail=0;
async function t(n,f){ try{ await f(); console.log("  OK   "+n); pass++; }
  catch(e){ console.log("  FALLO "+n+"\n         "+String(e.message).split("\n")[0]); fail++; } }

function alta(extra){ return Object.assign({
  sscc:"SSCC123456", producto:"Costillas", lote:"L001", caducidad:"2026-09-01",
  pasillo:"P3", nivel:"suelo", posicion:1,
  fecha_ubicacion: Timestamp.now(), usuario_ubicacion:"mlorente@aldelis.com",
  fecha_baja:null, usuario_baja:null, activo:true
}, extra||{}); }

console.log("\n=== Alta (solo admin) ===");
await t("admin da de alta un palet", () => assertSucceeds(addDoc(collection(admin(),"ubicaciones_palet"), alta())));
await t("un no-admin no puede", () => assertFails(addDoc(collection(otro(),"ubicaciones_palet"), alta())));
await t("un anonimo no puede", () => assertFails(addDoc(collection(anon(),"ubicaciones_palet"), alta())));
await t("usuario_ubicacion tiene que ser el que escribe", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({usuario_ubicacion:"otro@aldelis.com"}))));
await t("producto fuera de la lista se rechaza", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({producto:"Pollo"}))));
await t("posicion 17 se rechaza", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({posicion:17}))));
await t("sin lote se rechaza", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({lote:""}))));
await t("no se puede crear ya de baja", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({activo:false}))));
await t("un campo de mas se rechaza (hasOnly)", () =>
  assertFails(addDoc(collection(admin(),"ubicaciones_palet"), alta({dni:"12345678A"}))));

console.log("\n=== Lectura ===");
let id;
await env.withSecurityRulesDisabled(async c => {
  const r = await addDoc(collection(c.firestore(),"ubicaciones_palet"), alta());
  id = r.id;
});
await t("admin lee", () => assertSucceeds(getDoc(doc(admin(),"ubicaciones_palet",id))));
await t("no-admin no lee", () => assertFails(getDoc(doc(otro(),"ubicaciones_palet",id))));
await t("anonimo no lee", () => assertFails(getDoc(doc(anon(),"ubicaciones_palet",id))));

console.log("\n=== Baja: solo activo->false y los 3 campos de baja ===");
await t("baja normal", () => assertSucceeds(updateDoc(doc(admin(),"ubicaciones_palet",id), {
  activo:false, fecha_baja:Timestamp.now(), usuario_baja:"mlorente@aldelis.com"
})));

let id2;
await env.withSecurityRulesDisabled(async c => {
  const r = await addDoc(collection(c.firestore(),"ubicaciones_palet"), alta());
  id2 = r.id;
});
await t("no se puede colar un cambio de lote en la misma baja", () => assertFails(updateDoc(doc(admin(),"ubicaciones_palet",id2), {
  activo:false, fecha_baja:Timestamp.now(), usuario_baja:"mlorente@aldelis.com", lote:"OTRO"
})));
await t("usuario_baja tiene que ser el que la retira", () => assertFails(updateDoc(doc(admin(),"ubicaciones_palet",id2), {
  activo:false, fecha_baja:Timestamp.now(), usuario_baja:"otro@aldelis.com"
})));
await t("no-admin no puede dar de baja", () => assertFails(updateDoc(doc(otro(),"ubicaciones_palet",id2), {
  activo:false, fecha_baja:Timestamp.now(), usuario_baja:"otro@aldelis.com"
})));

let id3;
await env.withSecurityRulesDisabled(async c => {
  const r = await addDoc(collection(c.firestore(),"ubicaciones_palet"), alta({activo:false, fecha_baja:Timestamp.now(), usuario_baja:"mlorente@aldelis.com"}));
  id3 = r.id;
});
await t("no se puede volver a dar de baja algo ya dado de baja", () => assertFails(updateDoc(doc(admin(),"ubicaciones_palet",id3), {
  activo:false, fecha_baja:Timestamp.now(), usuario_baja:"mlorente@aldelis.com"
})));

console.log("\n=== Nunca se borra fisicamente ===");
await t("ni admin puede borrar", () => assertFails(deleteDoc(doc(admin(),"ubicaciones_palet",id))));

console.log("\n=========================================");
console.log("  " + pass + " correctos, " + fail + " fallos");
console.log("=========================================\n");
await env.cleanup();
process.exit(fail?1:0);
