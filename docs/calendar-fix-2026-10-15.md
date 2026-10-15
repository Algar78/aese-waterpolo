# Revisión de calendarios — 15/10/2026

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

La publicación de la rama/PR está pendiente de autorización: la revisión automática rechazó el envío por incluir datos corregidos a partir de un correo privado. La verificación directa en ActaWP también permanece pendiente.
