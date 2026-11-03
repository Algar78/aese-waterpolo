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
2. **Guardarlo en Apps Script** con un archivo temporal. *No se puede* añadir desde *Configuración del proyecto → Propiedades de la secuencia de comandos*: este proyecto tiene más de 50 propiedades, Google solo enseña las 50 primeras y esa lista es de solo lectura. El token no se pega nunca en el repositorio ni en un archivo que se quede en el proyecto:
   1. En el editor, *Añadir un archivo → Apps Script* y llámalo `token_temporal`. Pega esto, con el token entre las comillas (empieza por `github_pat_`), y guarda:
      ```js
      function guardarTokenGitHubYProbar() {
        const TOKEN = 'PEGA_AQUI_EL_TOKEN';
        if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(TOKEN)) throw new Error('Falta pegar el token entre las comillas (empieza por github_pat_). No se ha guardado nada.');
        const props = PropertiesService.getScriptProperties();
        props.setProperty('AESE_GITHUB_TOKEN', TOKEN);
        props.setProperty('AESE_FEEDS_DIRTY', String(Date.now()));
        const result = aeseRefreshFeeds_();
        Logger.log('Resultado del aviso a GitHub: ' + result);
        if (result !== 'dispatched') {
          props.deleteProperty('AESE_GITHUB_TOKEN');
          props.deleteProperty('AESE_FEEDS_DIRTY');
          throw new Error('GitHub no ha aceptado el token (mira el registro). No se ha guardado nada.');
        }
      }
      ```
   2. Selecciona `guardarTokenGitHubYProbar` y pulsa *Ejecutar*. Solo toca esas dos propiedades (`AESE_GITHUB_TOKEN` y `AESE_FEEDS_DIRTY`); si GitHub no acepta el token, las vuelve a borrar y no se pierde nada más.
   3. **Borra el archivo `token_temporal` entero** (tres puntos → *Eliminar*): así el token no queda en el código, solo en las propiedades privadas del script.
3. **Comprobarlo**: la función hace la prueba sola. El registro debe decir `Familias: aviso enviado a GitHub` y `Resultado del aviso a GitHub: dispatched`, y en *Actions → Clupik overlay* aparece una ejecución nueva («Manually run by Algar78»). Es inofensivo: el workflow solo vuelve a leer los avisos y no cambia nada si no hay novedades. Si GitHub rechaza el token, la función no guarda nada y lo dice en el registro.

## Qué puede hacer el token si se filtrara

Solo lanzar el workflow «Clupik overlay» (u otros del repositorio) en este repositorio: no puede leer ni cambiar el código, ni los secretos, ni otros repositorios, ni tu cuenta. Aun así, se guarda solo en las propiedades del script (privadas del proyecto) y caduca al año.

## Reversión

Borrar la propiedad `AESE_GITHUB_TOKEN` desactiva el aviso al instante (y se puede revocar el token en GitHub → *Fine-grained tokens*). El resto del sistema no cambia: los `.ics` vuelven a depender del ciclo programado de GitHub.

## Despliegue

**Desplegado el 1/11/2026** en el Apps Script real, junto con los `.gs` de la PR #29 y la tabla de sedes (167, 168 y 260) de `calendar_offline_bundle.gs` (ver `docs/audit-2026-10-18.md` §18). Sin token (`AESE_GITHUB_TOKEN`) el comportamiento no cambia: este aviso sigue dormido hasta que el mantenedor cree el token y lo guarde, como se explica arriba.

**Activado el 2/11/2026**: el mantenedor creó el token (fine-grained, solo `Algar78/aese-waterpolo`, Actions: Read and write, caduca el 2/11/2027) y se guardó con el archivo temporal descrito en el paso 2, que se borró después (el proyecto volvió a sus 7 archivos, sin ningún `github_pat_` en el código). La prueba (9:56, hora de Madrid) devolvió `dispatched` y la ejecución #263 de «Clupik overlay» («Manually run by Algar78») terminó correctamente sin cambiar nada. **Renovación**: antes del 2/11/2027 (el script avisa por correo 14 días antes) crear otro token igual y repetir el paso 2 con el archivo temporal; sustituye al anterior.

## Comprobaciones hechas

`tests/notices.test.mjs` (últimas seis pruebas, «aviso a GitHub»): una sola petición por aviso con el token solo en la cabecera; sin token no se llama a GitHub; un aviso repetido no vuelve a avisar; un `401` no frena el Calendar, conserva la marca, manda un solo correo y se recupera cuando el token vuelve a valer; un fallo pasajero o de red no envía correo antes de 2 horas ni rompe el ciclo; aviso de caducidad a 14 días y no antes. Las pruebas nuevas fallan sin el cambio del `.gs`.
