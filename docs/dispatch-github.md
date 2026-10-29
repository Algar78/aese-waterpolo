# Aviso inmediato a los `.ics` de las familias (opcional)

**Para qué sirve.** Cuando Clupik avisa de un cambio, Apps Script lo aplica a tu Google Calendar en el mismo ciclo (≤ 15 min). Los `.ics` de las familias los regenera el workflow «Clupik overlay» de GitHub, y GitHub ejecuta los workflows programados solo cada pocas horas (el 29/10 hubo tres pasadas entre las 22:53 y las 09:24). Con este aviso, Apps Script pide a GitHub que ejecute ese workflow **en cuanto guarda el aviso**, y las familias lo reciben en unos 2–3 minutos sin que nadie lance nada a mano.

**Es un acelerador, no un requisito.** El workflow programado sigue funcionando igual. Sin token no pasa nada: el código no hace nada y no manda ningún correo.

## Qué hace el código (`calendar_reliability.gs`)

1. Al guardar un aviso nuevo o cambiado de Clupik, marca «familias pendientes» (`AESE_FEEDS_DIRTY`). Un aviso repetido que no cambia nada no la marca.
2. En el mismo ciclo, si existe el token, hace **una** petición a la API oficial de GitHub (`workflow_dispatch` de `clupik-overlay.yml`, rama `main`). Si GitHub responde `204`, borra la marca.
3. Si falla, **la marca se conserva y se reintenta en cada ciclo** (cada 15 min):
   - `401`, `403`, `404` o `422` (token caducado, revocado o sin permiso): un correo al mantenedor, como mucho uno al día.
   - Red, `429` o `5xx`: no avisa hasta que lleve más de 2 horas sin conseguirse.
4. Si el token caduca en menos de 14 días, un correo (como mucho uno cada 3 días) para que lo cambies antes de que deje de funcionar.
5. **Nada de esto puede afectar al Google Calendar**: se ejecuta después de procesar el correo, dentro de un `try/catch`, y un fallo no cambia el resultado del ciclo. El token no sale nunca en registros ni en correos.

No necesita permisos nuevos de Google: Apps Script ya usa `UrlFetchApp` para leer el paquete de ActaWP, así que la ventana de autorización no cambia.

## Cómo activarlo (lo haces tú; yo no veo ni escribo credenciales)

Solo después de desplegar el `.gs` (ver «Despliegue»).

1. **Crear el token** en GitHub: *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*.
   - *Token name*: `AESE Apps Script - avisar a los .ics`
   - *Expiration*: 1 año (el máximo para este tipo).
   - *Resource owner*: `Algar78`.
   - *Repository access*: **Only select repositories** → `aese-waterpolo`.
   - *Repository permissions*: **Actions → Read and write** (Metadata → Read-only se añade solo). Ninguna más.
   - *Generate token* y copiarlo (empieza por `github_pat_`; GitHub no vuelve a enseñarlo).
2. **Guardarlo en Apps Script**: proyecto → *Configuración del proyecto* (engranaje) → *Propiedades de la secuencia de comandos* → *Añadir propiedad*: nombre `AESE_GITHUB_TOKEN`, valor el token → *Guardar*. No lo pegues en ningún archivo de código ni en el repositorio.
3. **Probarlo sin esperar a un cambio real**: añade la propiedad `AESE_FEEDS_DIRTY` con valor `1`, ejecuta `runAESECalendarSync` y comprueba en *Actions → Clupik overlay* que hay una ejecución nueva («Manually run by Algar78»). Es inofensivo: el workflow solo vuelve a leer los avisos y no cambia nada si no hay novedades. La propiedad `AESE_FEEDS_DIRTY` desaparece sola.

## Qué puede hacer el token si se filtrara

Solo lanzar el workflow «Clupik overlay» (u otros del repositorio) en este repositorio: no puede leer ni cambiar el código, ni los secretos, ni otros repositorios, ni tu cuenta. Aun así, se guarda solo en las propiedades del script (privadas del proyecto) y caduca al año.

## Reversión

Borrar la propiedad `AESE_GITHUB_TOKEN` desactiva el aviso al instante (y se puede revocar el token en GitHub → *Fine-grained tokens*). El resto del sistema no cambia: los `.ics` vuelven a depender del ciclo programado de GitHub.

## Despliegue

Es un cambio en `calendar_reliability.gs`, un archivo del Apps Script real. **No se despliega hasta después de la comprobación del permiso «En producción» (31/10–1/11)**; se hace en el mismo paso que los `.gs` de la PR #29 y la tabla de sedes de `calendar_offline_bundle.gs` (167, 168 y 260): copiar el archivo al proyecto de Apps Script, guardar y ejecutar una vez `runAESECalendarSync` para comprobar que termina en «Completada». Sin token, el comportamiento es idéntico al de ahora.

## Comprobaciones hechas

`tests/notices.test.mjs` (últimas seis pruebas, «aviso a GitHub»): una sola petición por aviso con el token solo en la cabecera; sin token no se llama a GitHub; un aviso repetido no vuelve a avisar; un `401` no frena el Calendar, conserva la marca, manda un solo correo y se recupera cuando el token vuelve a valer; un fallo pasajero o de red no envía correo antes de 2 horas ni rompe el ciclo; aviso de caducidad a 14 días y no antes. Las pruebas nuevas fallan sin el cambio del `.gs`.
