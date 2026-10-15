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

## Comprobación operativa en curso

Activadores consultados en el proyecto existente: exactamente uno, syncActaWPToCalendar, Principal, cada 15 minutos, aviso diario de errores. Clupik no tiene activador. Se consultó el diálogo de configuración sin modificarlo.

La publicación efectiva, restauración de URL y nuevas ejecuciones se registrarán después de observar sus resultados. Este documento no certifica todavía esos pasos.
