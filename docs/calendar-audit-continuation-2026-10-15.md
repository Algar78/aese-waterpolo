# Continuación de PR #8 — 15/10/2026

El propietario autoriza publicar el paquete/feed corregido y restaurar actualizaciones automáticas, manteniendo la PR sin fusionar. Para no depender de fusionarla, se publican por separado los datos y la corrección imprescindible del exportador en la rama que alimenta Pages. Los cambios de Apps Script de la PR siguen pendientes de fusión.

## Auditoría oficial de 80 horarios

Se consultaron mediante navegador las nueve tablas completas oficiales ActaWP, servidas por Clupik. Se identificaron exactamente los 80 partidos del snapshot por su ID, sin consultar proxies ni eludir límites. No se incluyen los descansos sin rival ni fecha. No se afirma haber abierto 80 fichas individuales ni auditado nuevamente todo el correo Clupik.

Fuentes, con prefijo https://actawp.natacio.cat/ca/tournament/:

| Categoría | Torneo | Calendario /all | Partidos |
| --- | --- | --- | --- |
| Absoluto Masculino | 1339803 | 3714121 | 16 |
| Alevín Mixto A | 1339810 | 3714189 | 2 |
| Alevín Mixto B | 1339810 | 3714193 | 12 |
| Cadete Masculino | 1339808 | 3714157 | 2 |
| Infantil Mixto A | 1339809 | 3714172 | 3 |
| Infantil Mixto B | 1339809 | 3714183 | 20 |
| Juvenil Femenino | 1339811 | 3714139 | 5 |
| Absoluta Femenina B | 1339806 | 3713773 | 18 |
| Juvenil Masculino | 1339807 | 3714147 | 2 |

La fecha/hora visible de cada fila concuerda con su data-sort UTC convertido a Europe/Madrid. La etiqueta GMT+2 permanece incluso en invierno y no se puede interpretar como offset verdadero. El CSV official-times-2026-10-15.csv registra los 80 valores UTC observados; las URLs de cada partido permanecen en el snapshot. El registro official-time-corrections-2026-10-15.json enumera los 53 cambios frente a la PR anterior.

Resultado: 51 partidos de invierno estaban adelantados una hora; se corrigen a la hora visible oficial. Otros dos partidos de Absoluta Femenina B cambian de fecha:

- 1339806:145574389, Barceloneta B–AESE B: 03/10 17:15 → 16/12/2026 20:45 Madrid.
- 1339806:145574400, Manresa–AESE B: 24/10 16:20 → 29/11/2026 12:00 Madrid.

Olot 1339803:145573561 conserva 15/11/2026 13:30 Madrid, 12:30 UTC. El dato UTC de la tabla oficial confirma también el instante, además de la hora local previamente comprobada.

El parser usa el valor UTC ordenable y comprueba su concordancia con la fecha/hora local visible; bloquea la exportación si divergen o falta el dato UTC. No confía en GMT+2. Las correcciones revisadas de Olot y los dos aplazamientos bloquean volver exactamente a sus fechas anteriores. Se mantienen UID, conteos, duración y SEQUENCE incremental.

## Verificaciones locales

18 pruebas Python y 38 JavaScript aprobadas. Las pruebas de publicación y ficheros temporales requirieron ejecutarse fuera del aislamiento de Windows; la primera ejecución restringida falló por permisos y no se contabiliza como aprobada. Se verifica invierno, cambio estacional, contradicción visible/UTC, preservación de snapshot, sincronización repetida sin duplicados y publicación concurrente sin force.

## Publicación y comprobación operativa

Activadores consultados en el proyecto existente: exactamente uno, syncActaWPToCalendar, Principal, cada 15 minutos, aviso diario de errores. Clupik no tiene activador. Se consultó el diálogo de configuración sin modificarlo.

Publicación independiente en main: d19119a60708cae97ed777d00311775078886b09. No se fusionó la PR. Pages build 38746385918 y validación PR 38746398391 finalizaron correctamente. Se descargaron el paquete y los nueve feeds desde sus URLs públicas y se compararon byte por byte con los archivos validados: diez coincidencias exactas. Hash del snapshot: cac4c91b07e7dcbbc200412754044fc8df7fda245eee5b6f77977e06e494463c.

El navegador comparó además los 80 instantes del paquete público con los data-sort observados en las nueve tablas: cero discrepancias y 80 identidades únicas.

Después de esas verificaciones se sustituyó en el proyecto existente la URL raw fijada al commit 02e7a263 por https://algar78.github.io/aese-waterpolo/calendars/general-calendar.json. Se comprobó Guardado en Drive. No se creó una aplicación web ni una implementación versionada.

Primera ejecución manual con Pages, 15:53:21–15:55:07 Europe/Madrid: total=80, created=0, updated=53, unchanged=27. Lectura posterior de Google Calendar: 80 eventos, 80 identidades únicas, mismos IDs que antes de terminar la ejecución, todas las duraciones de 90 minutos; cero discrepancias con el paquete publicado y cero títulos con hora distinta de la local Madrid. Olot conserva ID 0kigtd6h48172psimklp4m5ens y 15/11/2026 13:30–15:00.

El historial muestra un error anterior a esta ejecución, 15:50:39: Lock timeout, another process was holding the lock for too long. Había otra ejecución iniciada a las 15:50:00 que terminó correctamente. El bloqueo evitó escrituras simultáneas; no se eliminaron activadores ni se desactivó la protección.

Segunda ejecución manual ActaWP, 15:55:24–15:56:02: total=80, created=0, updated=0, unchanged=80, completada correctamente.

Clupik ejecutado 15:56:44–15:56:45 con checkpoint existente desde 15:42:20: dos hilos encontrados, cero partidos nuevos procesados, cero errores. ULTIMA_EJECUCION avanzó a 15:56:44. No se reinicializó historial ni se afirma haber reprocesado los 14 avisos de la sesión anterior.

Lectura final de Calendar tras ambas pasadas y Clupik: 80 eventos, 80 identidades únicas, sin paginación pendiente, mismos IDs/horas/títulos que al terminar la primera pasada; cero discrepancias con los 80 horarios publicados. Ninguna creación ni borrado.

No queda bloqueo para estos pasos. La auditoría se limita a los 80 eventos actualmente exportados; no constituye una suscripción a futuras verificaciones. El exportador programado sigue cada seis horas y conserva el último snapshot ante errores; Apps Script vuelve a incorporar sus publicaciones mediante Pages cada 15 minutos. Clupik permanece sin activador, según lo solicitado. La PR #8 sigue abierta, en borrador y sin fusionar.
