# Actualización de calendarios — 7 de noviembre de 2026

## Diagnóstico y alcance

La pantalla principal «PARTIDOS / CALENDARIO» consultaba exclusivamente la tabla de partidos guardados por los delegados en Supabase. No leía los calendarios oficiales. La página pública de calendarios ofrecía enlaces a FCN y suscripciones, pero no una lista de encuentros. La sincronización de Clupik no estaba congelada: el repositorio, los nueve feeds y Google Calendar contenían 111 identidades únicas. La última publicación anterior era e3fa353 (6 de noviembre).

Se revisaron la PR #9 y `docs/calendar-reliability-2026-10-17.md`, además de las modificaciones posteriores documentadas en `docs/audit-2026-10-18.md`. Desde el 18 de octubre el exportador ActaWP no está programado; Clupik/Gmail es la vía automática. El workflow «Clupik overlay» del 7 de noviembre a las 01:52 UTC terminó correctamente. La consulta al endpoint Apps Script devolvió última lectura correcta del correo a las 07:23:37 UTC del día 7. La unión conserva avisos anteriores aunque el endpoint ya no los entregue.

Gmail: se revisaron los avisos desde el 1 de noviembre. El último cambio recibido es Cadete Masculino, AESE–Premià, 20/12/2026 a las 13:30, piscina 228; ya figuraba tanto en el feed como en Google Calendar. Los seis avisos «Nuevo partido» de Cadete del 2 de noviembre no contenían fecha/piscina: no se inventan eventos a partir de ellos. El aviso fechado posterior de uno de esos partidos sí está publicado.

Google Calendar «AESE Waterpolo-Partidos»: lectura de temporada 2026-27, 111 eventos, 111 marcadores ACTAWP únicos y sin duplicados. No se escribieron ni borraron eventos.

## Cambios publicados

- «PARTIDOS / CALENDARIO» abre la nueva lista oficial, con selector de las nueve categorías, próximos partidos / toda la temporada, fecha y hora de Barcelona, rival, piscina y enlace al partido de FCN.
- Se conserva el acceso a todos los partidos de Supabase mediante «PARTIDOS GUARDADOS». No se modifica Supabase, sus estadísticas, actas, plantillas ni sus identificadores.
- `calendars/matches.json` se genera a partir de la misma lista validada que los nueve `.ics`, incluyendo los avisos de Clupik. No se usa el paquete `general-calendar.json` como lista de la app: ese paquete contiene solo el snapshot base para Apps Script.
- La vista recarga al volver a primer plano, cada cinco minutos mientras está visible y con el botón Actualizar. El service worker no devuelve calendarios antiguos desde caché tras un fallo de conexión; los fallos se muestran de forma explícita. Se incrementa su versión a v23 y se revalidan los recursos de la aplicación.
- El workflow de generación ahora valida también los pushes de código/datos a main, además de PR, ejecución manual y publicación del exportador. Los avisos de Clupik continúan regenerando el mismo JSON y los nueve feeds automáticamente.
- La revisión de cinco grupos oficiales permitió corregir 29 etiquetas de jornada del snapshot histórico, que antes indicaban Jornada 1. La evidencia por identidad y URL está en `data/calendar-round-review-2026-11-07.json`. No se alteraron horarios basándose en una lectura incompleta.
- `actawp_fetch.py` detecta ahora una página de verificación del navegador antes del backoff HTTP 429 y se detiene tras la primera respuesta de ese tipo. Se añade una regresión para impedir reintentos ante esa verificación.

## Conteos

| Categoría | Antes | Después |
| --- | ---: | ---: |
| Absoluto Masculino | 16 | 16 |
| Alevín Mixto A | 8 | 8 |
| Alevín Mixto B | 12 | 12 |
| Cadete Masculino | 3 | 3 |
| Infantil Mixto A | 13 | 13 |
| Infantil Mixto B | 20 | 20 |
| Juvenil Femenino | 5 | 5 |
| 1a Div Fem Absoluta B | 18 | 18 |
| Juvenil Masculino | 16 | 16 |
| **Total** | **111** | **111** |

No se han añadido ni eliminado partidos durante esta intervención: los 31 encuentros de fases nuevas que aportó Clupik ya estaban publicados antes de la revisión, pero no se podían consultar desde la pantalla principal. UID, secuencias de los feeds e identificadores se conservan.

## Límite real de la revisión de fuentes

Se consultaron cinco grupos de ActaWP con peticiones identificadas, espaciadas más de 30 segundos. Al llegar a Infantil Mixto B, ActaWP devolvió HTTP 429 con una página «Comprovant el teu navegador». El cliente anterior realizó sus tres esperas de backoff; después se detuvo toda la revisión. No se utilizaron proxies, rutas alternativas ni resolución del desafío. Se conserva el cooldown y el registro HTTP.

No se publica un snapshot parcial ni se cambia la fecha de última exportación completa (10 de octubre). Solo se corrigen etiquetas de jornada verificadas de partidos ya existentes. No se puede certificar que se hayan recogido todos los partidos nuevos de todas las fases desde ActaWP mientras siga este bloqueo. La vía automática de avisos Clupik/Gmail está operativa; la extracción automática integral de ActaWP sigue desactivada. Una lectura completa autorizada de las páginas de todas las fases sigue pendiente.

## Validación

- 144 pruebas JavaScript y 80 Python.
- Nueve feeds regenerados: 111 partidos, ninguna identidad eliminada o duplicada.
- Prueba nueva de igualdad entre la lista de la app y las identidades, categorías y conteos de los nueve feeds.
- La comprobación visual pública se registra después de la publicación. El acceso a la parte privada de Supabase requiere iniciar sesión y no se utiliza para modificar datos.
