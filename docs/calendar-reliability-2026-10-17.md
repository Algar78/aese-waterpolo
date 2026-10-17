# PR #9: fiabilidad y validación real, 17 de octubre de 2026

## Cambios auditados

- Los bloqueos ocupados devuelven un estado explícito y no generan un falso éxito.
- Límite cooperativo de 240 segundos compartido por el ciclo; se deja margen antes de iniciar otro partido. ActaWP procesa como máximo ocho identidades por llamada y guarda el cursor después de cada intento. Un partido fallido no bloquea los posteriores, pero impide marcar la vuelta como correcta.
- El cursor depende de las identidades ordenadas, no de la hora de publicación. Una publicación nueva con los mismos 80 partidos no reinicia permanentemente la conciliación.
- Clupik usa un registro local validado de identidades, categorías y sedes. No necesita descargar ActaWP ni Pages para leer Gmail y modificar Calendar. Una sede desconocida se bloquea para revisión.
- Correo paginado con ventana congelada y cursor persistente; máximo 12 mensajes nuevos por llamada. No se adelanta el checkpoint hasta completar la ventana sin errores. Las marcas usan la hora de procesamiento y se purgan a las 49 horas incluso si falla la ventana, para evitar agotar PropertiesService por un mensaje permanentemente defectuoso.
- Desempate determinista por ID para avisos con la misma fecha. Un aviso ya confirmado no revierte un avance posterior de ActaWP. Recuperación de creación sin referencia, también con caché activa dentro de la misma ejecución.
- El fallo de las alertas no impide ejecutar la otra vía. La vigilancia distingue Clupik, conciliación completa, fuente y publicación; comprueba activadores aunque falle la descarga de la fuente.
- HTTP 429: el exportador reintenta el mismo endpoint con backoff exponencial y jitter, respetando `Retry-After` en segundos o fecha HTTP y la hora del servidor. No acorta una espera que exceda su presupuesto ni cambia a un proxy tras el 429. El cooldown se guarda en `data/actawp_http_cooldowns.json` para el siguiente workflow. Apps Script conserva también el cooldown y cede al siguiente activador.

## Despliegue

Proyecto real: `AESE – Partidos Clupik → Google Calendar`, ID `1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A`.

Correspondencia de archivos:

| Repositorio | Apps Script |
| --- | --- |
| clupik_calendar_sync.gs | Código.gs |
| actawp_calendar_sync.gs | actawp_calendar_sync.gs |
| calendar_reliability.gs | calendar_reliability.gs |
| calendar_offline_bundle.gs | calendar_offline_bundle.gs |
| calendar_verification.gs | calendar_verification.gs |

Los activadores usan el código principal guardado del proyecto; no necesitan una implementación web pública. La versión se identifica como `pr9-reliability-2026-10-17-v1`. Se conservaron copias del código anterior y evidencias locales fuera del repositorio, en `aese-live-backup-20261017/`. No hubo bloqueo de acceso a Google ni se necesitaron permisos nuevos.

El registro local se regenera con `node scripts/prepare-calendar-release.cjs` a partir del paquete validado; debe acompañar las siguientes publicaciones del Apps Script.

## Pruebas y observaciones reales

- Pruebas: 55 JavaScript y 24 Python (79 en total), además de generación de los nueve feeds. [GitHub Actions](https://github.com/Algar78/aese-waterpolo/actions/runs/39015795265) ejecutó ambas suites correctamente sobre el código corregido.
- Consulta directa real a ActaWP: HTTP 200, tabla pública presente, sin desafío de navegador.
- Exportación real en carpeta aislada: una fila incompleta de Absoluto Masculino (`145573548`) bloqueó esa categoría; Alevín Mixto B respondió 429. Se observaron tres esperas crecientes antes de agotar el reintento y detener las categorías restantes. Se preservó el snapshot válido. No se publicó una exportación parcial ni se eludió el límite mediante proxy.
- Auditoría inicial en Google Calendar dentro de 2026–2028: 80 identidades ActaWP originales presentes y únicas, pero 83 eventos. Tres eran duplicados Clupik antiguos con fechas erróneas en 2027/2028. Al ampliar la auditoría a 2020–2035 se encontró otro duplicado anterior al inicio de temporada, fechado el 10 de marzo de 2026. Se revisaron ambos tipos de marcadores para evitar el falso resultado de contar solo ActaWP.
- Reparación limitada a cuatro IDs exactos: previsualización, comprobación de un original único, fecha e identidad del candidato, copia previa y retirada reversible. No hay eliminación automática general de duplicados. La reparación se puede repetir sin volver a borrar nada.
- Prueba de Clupik en Apps Script a las 10:00:33 CEST con Gmail/Calendar reales y la lectura remota forzada a fallar: completada, cero llamadas remotas y cinco mensajes correctos omitidos por idempotencia. No había mensajes nuevos para aplicar en esa prueba; las modificaciones de hora bajo fallo remoto están cubiertas por regresiones con los correos reales guardados como fixtures.
- Después de recargar el editor de Google se compararon íntegramente los cinco archivos guardados con los locales: coincidencia exacta en todos.
- Activador habitual de las 09:53:33 CEST: completado en 14,710 segundos. Primera verificación temporizada de las 09:53:49 CEST: completada en 22,955 segundos. Estos registros pertenecen al código nuevo; no se usaron ejecuciones históricas como prueba de esta versión.

## Evidencia final observada

Auditoría real a las **10:06:49 CEST** del 17 de octubre:

| Comprobación | Resultado |
| --- | --- |
| Eventos en 2020–2035 | **80** |
| Identidades originales encontradas | **80 de 80** |
| Originales ausentes | **0** |
| Duplicados ActaWP o Clupik | **0** |
| Eventos adicionales | **0** |
| Última vuelta completa | **10:02:10 CEST** |
| Cursor de la vuelta siguiente | **40 de 80**, sin fallos |
| Último éxito Clupik | **10:06:28 CEST** |
| Activadores restantes | `runAESECalendarSync`, `checkAESECalendarHealth` |

Se registraron doce intentos de verificación temporizados. No se presentan todos como correctos: las verificaciones de las 10:01–10:04 detectaron el cuarto duplicado y fallaron de forma explícita. Tras retirarlo a las **10:04:15**, las auditorías automáticas de las **10:05:04** y **10:06:07** encontraron los 80 originales sin duplicados Clupik/ActaWP. Se programó además una ejecución automática independiente de una sola vez; la auditoría final posterior conservó los 80 eventos. Todos los activadores temporales ya se habían retirado en la lectura final.

Los horarios de control conservaron el mismo ID de evento: Banyoles, **24/10/2026 13:00 CEST**; Olot, **15/11/2026 13:30 CET**; Mediterrani, **22/11/2026 09:00 CET**. Los cambios de fecha/hora y los reintentos sin duplicación se verificaron además mediante regresiones. No se alteraron artificialmente horarios de producción para simular avisos futuros.

El código final de ejecución de correo pasó nuevamente las regresiones y [GitHub Actions](https://github.com/Algar78/aese-waterpolo/actions/runs/39016105147), antes de la fusión. El fichero de cooldown del exportador aislado y los hashes de snapshot/validación prueban que el 429 real no modificó los datos publicados.

## Límites operativos

El servidor puede seguir devolviendo 429; la corrección consiste en respetar su espera, conservar el último estado válido y mantener Clupik independiente. Una fuente incompleta sigue bloqueando su publicación. Los presupuestos son cooperativos entre operaciones: Apps Script no permite imponer un timeout a una llamada individual de CalendarApp/GmailApp; si Google interrumpe una ejecución, el estado persistente permite reanudarla. No se afirma disponibilidad permanente del origen ni ausencia futura de cuotas.

Referencias: [cuotas de Apps Script](https://developers.google.com/apps-script/guides/services/quotas), [errores de Calendar y backoff](https://developers.google.com/workspace/calendar/api/guides/errors).
