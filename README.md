# Aldelis — Gestión de muelles

Aplicación web para la gestión de muelles de carga, lanzaderas e incidencias de
las líneas de etiquetado Bizerba.

Stack: **Firebase Hosting + Firestore + Auth + App Check + Cloud Functions v2**.
Sin framework ni build: HTML, CSS y JavaScript plano con los SDK `compat` de
Firebase cargados por CDN.

---

## Estructura

```
public/                       Todo lo que se sirve por Hosting
  index.html                  Formulario público de reserva de muelle
  consulta.html               Consulta pública del estado de una reserva
  admin.html                  Panel de almacén (requiere login)
  lanzadera.html              App del conductor de lanzadera (QR, sin login)
  bizerba.html                Panel del técnico de Bizerba (QR, sin login)
  incidencia.html             Formulario del operario de línea (QR, sin login)
  404.html
  css/                        style.css (público) y admin.css (panel)
  js/
    firebase-config-compat.js Inicialización de Firebase y App Check
    reserva.js                Lógica del formulario de reserva
    consulta.js               Lógica de la consulta pública
    admin.js                  Panel de almacén (el fichero principal)
    movil.js                  Vista móvil del almacén (lanzaderas + chat)
    lanzadera.js              App del conductor
    bizerba.js                Panel del técnico
    push.js                   Registro del token FCM para notificaciones
    fotos.js                  Fotos del chat: comprimir, enviar y ver
  firebase-messaging-sw.js    Service worker de notificaciones push

functions/index.js            Cloud Functions (envío de correo e informes)
firestore.rules               Reglas de seguridad
firestore.indexes.json        Índices compuestos
firebase.json                 Configuración de Hosting y Firestore
pruebas/                      Pruebas que no se despliegan (no están en public/)
```

`aldelis-functions/` es una versión anterior de las functions que ya no se
despliega; se conserva solo como referencia.

`movil.html` es una página aparte del panel **a propósito**, no una versión
adaptada. El panel suscribe ocho colecciones y dibuja rejillas, informes y
costes; la vista móvil solo necesita los cuatro documentos de estado en vivo,
los cuatro de conductor y el chat del día. Con varios móviles abiertos toda la
jornada, la diferencia en lecturas de Firestore es grande.

---

## Páginas y accesos

| Página | Acceso | Para quién |
|---|---|---|
| `index.html` | Público | Transportistas que reservan muelle |
| `consulta.html` | Público | Consultar una reserva por código o matrícula |
| `admin.html` | Login (Firebase Auth) | Personal de almacén |
| `lanzadera.html` | QR, sin login | Conductores de lanzadera (1-4) |
| `bizerba.html?t=N` | QR, sin login | Técnicos de Bizerba (N = 1..6) |
| `incidencia.html` | QR, sin login | Operarios de línea que reportan averías |
| `carga.html` | QR, sin login | Choferes que registran su entrada a muelle (M1-M5) |
| `merca.html` | QR, sin login | Proveedores que descargan en Merca (M2 y M4) |
| `movil.html` | Login | Vista movil del almacen: donde esta cada lanzadera y chat |
| `ubicacion.html` | Login, solo admins por ahora | Ubicación de palets en la cámara frigorífica |

Las páginas sin login están protegidas por **App Check (reCAPTCHA v3)**: solo
se aceptan peticiones que vengan del dominio real de la aplicación. Se decidió
no pedir credenciales a conductores y operarios porque acceden desde el móvil
escaneando un QR pegado en la línea o en su tarjeta.

---

## Colecciones de Firestore

| Colección | Contenido | Notas |
|---|---|---|
| `reservas` | Reservas de muelle | Estados: `pendiente`, `confirmada`, `en_curso`, `rechazada`, `completada` |
| `lanzaderas` | Estado en vivo, un documento por lanzadera (`"1"`..`"4"`) | Estados: `en_nave`, `transito`, `fuera` |
| `lanzaderas_log` | Histórico de movimientos | Solo se añade; base de los informes de costes |
| `lanzaderas_nota` | Indicación del almacén al conductor | Un documento por lanzadera |
| `lanzaderas_chofer` | Quién conduce cada lanzadera y su teléfono | **Contiene un teléfono**: lectura solo con la sección `lanzaderas`. Lo escribe el conductor desde su móvil; el servidor garantiza un conductor por lanzadera |
| `mensajes` | Chat entre almacén y lanzaderas | Campo `lanzadera` (1-4) y `de` (`almacen`/`lanzadera`). Si lleva foto, incluye `thumb` (miniatura) y `foto` (id) |
| `fotos` | Fotos del chat, en base64 | **Se borran a los 3 días** (`limpiarFotos`). Van aparte del mensaje para que el chat no descargue todas en cada reconexión |
| `cargas` | Registro de cargas en muelles M1-M5 | **Contiene DNI de choferes**, lectura restringida |
| `descargas_merca` | Descargas de proveedores en Merca (M2, M4) | |
| `incidencias` | Averías de las líneas Bizerba (0-16) | Estados: `abierta`, `aceptada`, `repuesto`, `resuelta` |
| `push_tokens` | Tokens FCM, uno por dispositivo | |
| `permisos` | Permisos por usuario, id = email | Ver «Permisos» |
| `config` | Ajustes del sistema | Ver abajo |

Documentos de `config`:

- `app` — versión de la app (fuerza recarga en los clientes), `tiempoMaxLanz`, `diasLaborables`
- `destinos` — lista de naves disponibles para las lanzaderas. El conductor puede
  además escribir un lugar que no esté en la lista («Otro lugar»): se guarda tal
  cual en `nave` o `destino`, que en las reglas son texto libre, y todas las
  vistas e informes lo muestran porque hacen `NAVE_NOMBRE[x] || x`. Si un sitio
  se vuelve habitual, conviene añadirlo aquí desde Config
- `alertas` — destinatarios de las alertas de lanzadera parada
- `costes` — destinatarios del informe diario de costes
- `bizerba` — destinatarios del informe diario de incidencias

---

## Módulo de ubicación de palets (cámara frigorífica)

`ubicacion.html` + `public/js/ubicacion.js`. **Deliberadamente independiente**
del resto de la app: colección propia (`ubicaciones_palet`), bloque propio en
`firestore.rules`, sin Cloud Functions ni relación con ninguna otra colección
o pantalla. Un fallo aquí no puede afectar a reservas, lanzaderas, Bizerba ni
los informes.

Rejilla fija de 2 pasillos (P3, P4) × 4 niveles (suelo, cota1-3) × 16
posiciones. Cada documento es un movimiento (alta o baja), nunca se borra:
`activo` pasa a `false` en la baja para dejar histórico y trazabilidad, algo
obligatorio en alimentación. Solo se leen los documentos con `activo == true`
(como mucho 128), así que el histórico puede crecer con los meses sin que
suban las lecturas del día a día.

Las reglas dejan la baja tocar únicamente `activo`, `fecha_baja` y
`usuario_baja` — el resto de campos tiene que llegar idéntico al documento
anterior, así una actualización no puede colarse como una reescritura del
alta. Verificado con el emulador (18 + 6 casos): alta, lectura, baja e
inmutabilidad de los campos que no debe tocar, y que sin la sección concedida
no hay acceso aunque el usuario ya tenga ficha para otra cosa.

El acceso se gestiona desde **Config → Permisos de usuario**, sección
«Ubicación de palets», igual que el resto de secciones del panel. El botón
«📦 Ubicación» de la barra superior aparece para quien tenga esa sección
marcada (o sea administrador) y abre la página en una pestaña nueva.

Una diferencia importante con el resto de secciones: aquí **no hay refuerzo
progresivo**. En las demás secciones, un usuario sin ficha en `/permisos`
conserva el acceso que ya tenía (para no dejar a nadie fuera de golpe al
introducir el sistema de permisos). Como `ubicacion` es una sección nueva sin
usuarios previos que proteger, sin ficha —o con ficha que no la incluya— el
acceso es que no, tanto en el cliente como en `firestore.rules`
(`permitidoEstricto`, en vez de `permitido`). Verificado con el emulador.

El diseño está adaptado a la paleta de Aldelis (rojo `#D41F3A`, cabecera
oscura), conservando los colores por producto del prototipo original
(Costillas en terracota, Alitas en ámbar), que son información, no marca.

---

## Permisos

Los permisos se guardan en la colección `permisos`, un documento por usuario con
el email como id y un array `secciones`. Se gestionan desde el panel, en
**Config → Permisos de usuario**.

Secciones disponibles: `rejilla`, `lista`, `informes`, `lanzaderas`, `cargas`,
`merca`, `bizerba`, `costes`, `chat`, `config`.

Dos detalles importantes de la implementación:

1. Los permisos se leen **antes** de suscribir los listeners de Firestore, de
   modo que cada usuario solo lee las colecciones de las secciones que puede
   ver. Es una medida de coste, no solo de interfaz.
2. Las reglas aplican **refuerzo progresivo**: mientras un usuario no tenga
   documento en `permisos` conserva el acceso de usuario autenticado. En cuanto
   se le crea el documento, se le aplica de forma estricta. Así se pudo
   desplegar sin dejar a nadie fuera de golpe.

La lista de administradores está duplicada en dos sitios y **hay que cambiarla
en ambos**: la constante `ADMINS` en `public/js/admin.js` y la función
`esAdmin()` en `firestore.rules`.

---

## Cloud Functions

Todas en `functions/index.js`, región `us-central1`, runtime Node 24.

| Función | Tipo | Cuándo | Qué hace |
|---|---|---|---|
| `enviarEmail` | Callable | A demanda desde el cliente | Envía los avisos por Microsoft Graph |
| `enviarInformeDiario` | Programada | 23:59 Europe/Madrid | Informe de costes de lanzaderas |
| `enviarInformeManana` | Programada | 08:30 Europe/Madrid | El mismo informe (para revisarlo por la mañana) |
| `enviarInformeBizerba` | Programada | 23:59 Europe/Madrid | Informe de incidencias de etiquetado |
| `notifChat` | Trigger Firestore | Al crear en `mensajes` | Notificación push del chat |
| `choferUnaLanzadera` | Trigger Firestore | Al escribir en `lanzaderas_chofer` | Libera cualquier otra lanzadera con el mismo teléfono |
| `liberarChoferAlSalir` | Trigger Firestore | Al escribir en `lanzaderas` | Borra el conductor cuando ficha fin de jornada |
| `limpiarFotos` | Programada | 04:15 Europe/Madrid | Borra las fotos del chat con más de 3 días |

### enviarEmail: el cliente no elige destinatario ni contenido

Esta función **no acepta un destinatario ni un texto libres**. Recibe un `tipo`
de aviso y los datos mínimos, y resuelve todo en el servidor. Antes aceptaba
`to`, `subject` y `html` del cliente sin exigir nada, lo que la convertía en un
relay abierto: cualquiera podía enviar correo desde `reservas@aldelis.com`.

| `tipo` | Acceso | Datos | Destinatarios |
|---|---|---|---|
| `reserva_nueva` | Público | `reservaId` | El `email` del documento + `config/reservas` (por defecto mlorente y garita) |
| `reserva_estado` | Login | `reservaId` | El `email` del documento |
| `alerta_lanzadera` | Login | `numero`, `lugar`, `minutos` | `config/alertas` |
| `informe_costes` | Login + sección `costes` | `fechaFmt`, `costeTotal`, `html`, `imageBase64` | `config/costes` |
| `password_reset` | Público | `email` | La propia dirección, si tiene cuenta |

Reglas que aplica siempre:

- **App Check obligatorio.** Para las funciones callable esto no se puede
  activar desde la consola de Firebase (el panel solo enlaza documentación):
  se comprueba en el código con `ctx.app`.
- `reserva_nueva` solo funciona una vez por reserva (marca `aviso_enviado` en el
  documento) y únicamente dentro de los 15 minutos siguientes a su creación, en
  estado `pendiente`. Así nadie puede reenviar avisos en bucle ni resucitar
  reservas viejas.
- Los textos de los correos se redactan dentro de la función. Si hay que cambiar
  la redacción de un aviso, se cambia ahí, no en el navegador.
- `password_reset` genera el enlace con el SDK de administrador y lo envía por
  Graph **a propósito, en lugar de dejárselo a Firebase**: los correos de
  Firebase salen de `noreply@aldelis-muelles.firebaseapp.com` y Exchange Online
  los manda a cuarentena, así que no llegaban. Responde lo mismo exista la
  cuenta o no (para que no sirva para averiguar quién tiene cuenta) y admite un
  correo cada 5 minutos por dirección, controlado en la colección
  `password_resets`, que el cliente no puede leer ni escribir.

Hay pruebas en `functions/test-enviarEmail.js`, que interceptan las llamadas a
Microsoft y usan el emulador de Firestore. No se despliegan (`test-*.js` está en
el `ignore` de `firebase.json`):

```bash
firebase emulators:start --only firestore
cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=aldelis-test node test-enviarEmail.js
```

El correo se envía con la **API de Microsoft Graph** desde `reservas@aldelis.com`
mediante client credentials. El secreto se lee de `process.env.MS_SECRET`, que
vive en `functions/.env` — **ese fichero no está en el repositorio** y hay que
crearlo para poder desplegar:

```
MS_SECRET=<el secreto de la aplicación de Azure>
```

Detalles a tener en cuenta al tocar estas funciones:

- Usan la **API v2** (`onSchedule`, `onDocumentCreated`). La v1
  (`functions.pubsub.schedule`, `functions.firestore.document`) no funciona con
  `firebase-functions` v7 y el despliegue falla con «codebase could not be
  analyzed».
- Los nombres de función no admiten caracteres especiales: `enviarInformeManana`
  va sin `ñ` porque Cloud Run rechaza el nombre del servicio.
- Las funciones corren en **UTC**. Cualquier hora que se muestre al usuario hay
  que formatearla con `timeZone: "Europe/Madrid"` o saldrá desfasada.

---

## Informes de costes

El informe de costes de lanzaderas se puede enviar por dos caminos, y generan
**diseños distintos a propósito**:

- **Automático (Cloud Function, 23:59 y 08:30):** HTML que reproduce la vista
  del panel. Es el que reciben los destinatarios de `config/costes`.
- **Manual (botón en el panel):** captura el `div#costes-historial` con
  html2canvas y lo envía como imagen incrustada.

El envío automático desde el navegador está **desactivado** a propósito
(`autoEnviarCostesAlFinalDelDia` devuelve sin hacer nada). Antes lo hacían el
navegador y la función a la vez: si el panel quedaba abierto a las 23:59
llegaban dos correos con diseños distintos.

El coste por minuto de cada lanzadera se calcula así:

- L1, L2, L3: 16.000 €/mes ÷ `diasLaborables` ÷ 1440 min (24 h)
- L4: 150 €/h (tarifa horaria fija)

`diasLaborables` se configura en el panel y por defecto es 22. Las tarifas, en
cambio, estan en el codigo como constantes `LANZ_MENSUAL` y `LANZ4_HORA`, y
estan **duplicadas** en `public/js/admin.js` y `functions/index.js`: si cambian,
hay que cambiarlas en los dos sitios o el panel y el informe automatico daran
cifras distintas.

---

## Despliegue

Requiere el plan **Blaze** de Firebase: las Cloud Functions y las llamadas de
red salientes (Microsoft Graph) no están disponibles en el plan gratuito.

```bash
# Todo
firebase deploy

# Solo la parte estática
firebase deploy --only hosting

# Solo funciones
firebase deploy --only functions

# Reglas e índices de Firestore
firebase deploy --only firestore
```

Si el CLI responde `Skipped (No changes detected)` cuando sí hay cambios, está
reutilizando el hash anterior. Hay que forzarlo:

```bash
firebase deploy --only functions:nombreFuncion --force
```

Al tocar `public/js/admin.js` conviene subir `APP_VERSION` y el documento
`config/app`, que es el mecanismo que fuerza la recarga en los navegadores ya
abiertos.

### Probar las reglas de Firestore

Las reglas tienen pruebas contra el emulador. Merece la pena ejecutarlas antes
de desplegar cambios en `firestore.rules`, porque un fallo ahí deja la
aplicación inservible:

```bash
firebase emulators:start --only firestore
# y contra el emulador, con @firebase/rules-unit-testing
```

---

## Consumo de Firestore

El plan gratuito de Firestore corta a las **50.000 lecturas diarias**, y la
aplicación ha llegado a superarlas. Las causas fueron listeners sin acotar, y
conviene tenerlo presente al añadir código nuevo:

- **Todo listener debe llevar filtro de fecha y, si la colección crece, `limit()`.**
  El caso que disparó el consumo fue el chat de `lanzadera.js`, que releía el
  histórico completo de mensajes en cada reconexión del móvil.
- Los móviles reconectan constantemente (bloqueo de pantalla, cambio de red), y
  **cada reconexión relee el conjunto completo** de la consulta. Lo que en un PC
  es una lectura inicial, en seis móviles son cientos al día.
- Recargar el panel resuscribe todos los listeners. En días de desarrollo, con
  muchas recargas, ese es el mayor consumidor.
- Los informes hacen una lectura puntual (`.get()`) antes de construirse, no
  usan listeners.

---

## Cosas que conviene saber

- **No uses comillas tipográficas** (`"` `"`) en los `.js`. Un copiar-pegar desde
  un documento ya rompió el login con `SyntaxError: Invalid or unexpected token`.
- **Si creas una página nueva, cométela.** `bizerba.html` y `carga.html` se
  perdieron por trabajar en local sin subirlas: al desplegar desde una copia
  limpia, Hosting sustituye el contenido de `public/` y los QR impresos que
  apuntaban a ellas empezaron a dar 404. Hay carteles plastificados en la nave
  con esas URL, así que un fichero que falte se traduce en gente que no puede
  trabajar.
- Los formularios públicos escriben con los campos **exactos** que valida
  `firestore.rules` (`hasOnly`). Añadir un campo de más hace que la escritura se
  deniegue sin error visible para el usuario.
- `firebase.txt` es un resto del alta del proyecto en Firebase; no se usa.
- Las reglas dejan `mensajes`, `incidencias` y `reservas` con lectura pública
  porque las páginas sin login las necesitan. Es una consecuencia asumida de que
  conductores y operarios entren por QR sin credenciales; la protección efectiva
  ahí es App Check.
