# Revisión de calendarios — 15/10/2026

Estado posterior: publicación corregida verificada, fuente Pages restaurada y 80 horarios auditados. Se corrigieron otros 53 horarios y se repitió la sincronización sin duplicados. Véase [la continuación y sus evidencias](calendar-audit-continuation-2026-10-15.md). Las referencias siguientes al commit fijo y a verificaciones pendientes describen el estado histórico anterior.

## Partido Olot–AESE

Identidad: 1339803:145573561, Absoluto Masculino, Jornada 4.
Fecha anterior: 24/10/2026 13:30 Europe/Madrid.
Fecha corregida: 15/11/2026 13:30 Europe/Madrid (12:30 UTC).
Sede: 173 - Olot, CN.

Fuente de la corrección: aviso oficial FCN/Clupik del 15/10/2026 a las 08:39 UTC, «Modificado un partido de Jornada 4». El aviso enlaza el partido 145573561 del torneo 1339803. No se incorpora el correo, datos personales ni enlaces de seguimiento al repositorio.
La consulta directa de ActaWP encontró el desafío de navegador/HTTP 429. No se afirma que la fecha se haya podido verificar directamente en su web. El exportador conserva el último snapshot ante el 429 y rechaza volver a la fecha anterior a este aviso revisado. Para aceptar una vuelta legítima a esa fecha hay que revisar y retirar la entrada correspondiente de reviewed_corrections en el estado validado.

Se actualizó el evento existente de Google Calendar y se comprobó por lectura su nueva fecha, manteniendo su ID y duración de 90 minutos. No se creó un evento adicional. La corrección de datos mantiene UID del feed y aumenta SEQUENCE de 1 a 2; siguen siendo 80 partidos.

## Código

- Clupik convierte explícitamente la hora local de Europe/Madrid a un instante UTC, independiente de la zona del proyecto. Rechaza fechas imposibles y horas ambiguas/inexistentes durante el cambio estacional.
- La búsqueda Gmail usa Europe/Madrid.
- ActaWP recupera el marcador de identidad aunque la descripción esté en HTML o tenga campos plegados, sin confundir prefijos numéricos.
- Los partidos de otra identidad no bloquean la creación por compartir equipos y horario entre categorías. Los duplicados de la misma identidad siguen bloqueándose sin borrarse.
- El parser obtiene la jornada de la tabla correspondiente en lugar de asignar la primera jornada a todos los partidos.
- Datos, hash de validación, paquete general y feed masculino se regeneraron juntos.

## Validación y límites

16 pruebas Python y 37 pruebas JavaScript funcionales. Incluyen cambios de fecha/sede, conservación de identidad, repetición de la sincronización completa, bloqueo de datos parciales y regresiones de zona horaria. La prueba separada publication.test.mjs no pudo ejecutarse por restricciones del Git/MSYS de Windows al crear procesos para el remoto local; no se ha marcado como aprobada. git diff --check sin errores.

El cron de GitHub exporta cada seis horas. El código contiene un instalador del trigger de Apps Script de 15 minutos; su presencia no prueba que esté instalado ni qué versión esté desplegada. No se accedió al editor de Apps Script ni se modificaron sus activadores. Tras publicar, hay que desplegar ambos archivos .gs en el proyecto existente, comprobar los triggers y ejecutar la sincronización dos veces. Revisar los cambios de jornada que traerá la siguiente exportación completa.

La rama y la PR #8 se publicaron con autorización expresa del propietario. El estado operativo actualizado se recoge a continuación.

## Despliegue y verificación efectiva — 15/10/2026

Proyecto existente: AESE – Partidos Clupik → Google Calendar.
Script ID: 1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A.
Ambos archivos están en este mismo proyecto: clupik_calendar_sync.gs se corresponde con Código.gs. Zona del proyecto: Madrid; entorno V8 habilitado.

Se guardaron y releyeron los dos archivos en el editor. Código.gs coincide con el contenido de la PR en el commit 02e7a263f59c3a875e27ac9945b440e56588880f. ActaWP contiene las mismas correcciones con una única diferencia de configuración: ACTAWP_BUNDLE_URL apunta temporalmente al paquete inmutable de ese commit:
https://raw.githubusercontent.com/Algar78/aese-waterpolo/02e7a263f59c3a875e27ac9945b440e56588880f/calendars/general-calendar.json

Motivo: se consultó el paquete publicado en GitHub Pages y todavía contiene Olot el 24/10/2026 13:30 +02:00. Usarlo en una prueba podía revertir la corrección. La fuente fijada se leyó correctamente desde Apps Script. Esta medida congela los datos en ese commit: el activador NO incorporará nuevas exportaciones hasta cambiar la fuente. Tras una fusión expresamente autorizada y la publicación verificada del paquete corregido, restaurar la URL de GitHub Pages y repetir dos pasadas. No restaurarla mientras contenga la fecha antigua.

Para estas funciones y el activador existente, el código guardado en Principal es el que se ejecuta. No se creó una aplicación web ni una implementación versionada.

Activadores revisados: exactamente uno, syncActaWPToCalendar, Principal, basado en tiempo, cada 15 minutos, notificación diaria de errores. Se conserva sin reinstalarlo. No existe activador de procesarPartidosAESE; no se añadió uno. La cadencia futura de Clupik continúa sin automatizarse.

Ejecuciones manuales, horas Europe/Madrid:
- ActaWP 15:40:38–15:41:14: total=80 created=0 updated=1 unchanged=79.
- ActaWP 15:41:25–15:41:58: total=80 created=0 updated=0 unchanged=80.
- Clupik 15:42:19–15:42:41: 6 hilos, 14 mensajes procesados, 0 errores. Los partidos ya gestionados por ActaWP, incluido Olot en dos avisos, se reconocieron sin crearlos ni reescribirlos. ULTIMA_EJECUCION avanzó a la hora de inicio de la búsqueda; no se reinicializó ni se forzó el historial.

Calendario editable AESE Waterpolo-Partidos, lectura de la temporada 01/08/2026–01/08/2027: 80 eventos, 80 identidades ActaWP distintas, sin identidades duplicadas. Los 80 instantes coinciden con el paquete validado de la PR y las horas de los títulos coinciden con su conversión Europe/Madrid. No equivale a una nueva auditoría de los 80 horarios contra todas las páginas oficiales.

Olot conserva el evento 0kigtd6h48172psimklp4m5ens: 15/11/2026 13:30–15:00 Europe/Madrid (12:30–14:00 UTC), Jornada 4, 173 - Olot, CN. No queda copia del mismo partido el 24/10; el otro encuentro con Olot corresponde a la vuelta, identidad distinta.

Verificación directa oficial:
https://actawp.natacio.cat/ca/tournament/1339803/match/145573561/results
El navegador completó automáticamente su comprobación y mostró C.N. OLOT — A.E. SANTA EULÀLIA, Jornada 4, domingo 15/11/2026, 13:30, 173 - Olot, CN. No se resolvió ningún CAPTCHA, no se alteró el acceso ni se lanzaron bucles para eludir HTTP 429. El lector web no pudo acceder; el navegador sí.

La ficha oficial muestra literalmente GMT+2 junto a 13:30. Esa etiqueta es incoherente con Europe/Madrid el 15/11, que es UTC+1. Se valida la fecha y hora local de la ficha, concordante con el aviso FCN/Clupik; no se afirma que su etiqueta GMT+2 sea correcta ni que se haya confirmado el instante UTC interno del servidor oficial.

PR #8 permanece sin fusionar. Las validaciones históricas de pruebas se describen arriba; esta continuación valida las ejecuciones reales y no afirma haber repetido la batería local.
