# PR #9: fiabilidad y validación real, 17 de octubre de 2026

## Cambios auditados

- Los bloqueos ocupados devuelven un estado explícito y no generan un falso éxito.
- Límite cooperativo de 240 segundos compartido por el ciclo; se deja margen antes de iniciar otro partido. ActaWP procesa como máximo ocho identidades por llamada y guarda el cursor después de cada intento. Un partido fallido no bloquea los posteriores, pero impide marcar la vuelta como correcta.
- El cursor depende de las identidades ordenadas, no de la hora de publicación. Una publicación nueva con los mismos 80 partidos no reinicia permanentemente la conciliación.
- Clupik usa un registro local validado de identidades, categorías y sedes. No necesita descargar ActaWP ni Pages para leer Gmail y modificar Calendar. Una sede desconocida se bloquea para revisión.
- Correo paginado con ventana congelada y cursor persistente; máximo 12 mensajes nuevos por llamada. No se adelanta el checkpoint hasta completar la ventana sin errores. Se conservan las marcas de los mensajes correctos y se purgan cuando dejan de ser necesarias.
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

- Pruebas locales: suite JavaScript, parser/exportador Python y regresiones de backoff. También GitHub Actions ejecuta ambas suites en el PR.
- Consulta directa real a ActaWP: HTTP 200, tabla pública presente, sin desafío de navegador.
- Exportación real en carpeta aislada: una fila incompleta de Absoluto Masculino (`145573548`) bloqueó esa categoría; Alevín Mixto B respondió 429. Se observaron tres esperas crecientes antes de agotar el reintento y detener las categorías restantes. Se preservó el snapshot válido. No se publicó una exportación parcial ni se eludió el límite mediante proxy.
- Auditoría inicial en Google Calendar: 80 identidades ActaWP originales presentes y únicas, pero 83 eventos en total. Los tres adicionales eran duplicados Clupik antiguos, con fechas erróneas en 2027/2028. La auditoría se amplió para detectar ambos tipos de marcadores en 2020–2035.
- Reparación limitada a los tres IDs exactos: previsualización, comprobación de un original único, fecha e identidad del candidato, copia de los tres eventos antes de borrar el primero y retirada reversible. No hay eliminación automática general de duplicados. La reparación se puede repetir sin volver a borrar nada.
- Activador habitual de las 09:53:33 CEST: completado en 14,710 segundos. Primera verificación temporizada de las 09:53:49 CEST: completada en 22,955 segundos. Estos registros pertenecen al código nuevo; no se usaron ejecuciones históricas como prueba de esta versión.

La evidencia final de vuelta completa, ciclos posteriores a la limpieza y prueba de Clupik con fallo de fuente se añade al terminar la observación.

## Límites operativos

El servidor puede seguir devolviendo 429; la corrección consiste en respetar su espera, conservar el último estado válido y mantener Clupik independiente. Una fuente incompleta sigue bloqueando su publicación. Los presupuestos son cooperativos entre operaciones: Apps Script no permite imponer un timeout a una llamada individual de CalendarApp/GmailApp; si Google interrumpe una ejecución, el estado persistente permite reanudarla. No se afirma disponibilidad permanente del origen ni ausencia futura de cuotas.

Referencias: [cuotas de Apps Script](https://developers.google.com/apps-script/guides/services/quotas), [errores de Calendar y backoff](https://developers.google.com/workspace/calendar/api/guides/errors).
