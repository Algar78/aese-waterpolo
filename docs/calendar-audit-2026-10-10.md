# Auditoría de calendarios AESE — 10 octubre 2026

## Evidencia real y alcance

- Base: main `eb7cf5e`, después de [PR #4](https://github.com/Algar78/aese-waterpolo/pull/4), fusionada el 10/10/2026 a las 10:41 Madrid.
- [Exportación 38046635140](https://github.com/Algar78/aese-waterpolo/actions/runs/38046635140): obtuvo 80 partidos de 9 categorías, pero `git push` fue rechazado porque main había avanzado. El job de feeds posterior fue omitido. Se añadió rebase con hasta tres intentos de publicación, sin force; un conflicto sigue siendo un fallo visible.
- Cron actual del exportador: `17 */6 * * *`, Europe/Madrid. La frecuencia de 15 minutos citada en la auditoría anterior ya no describe el workflow actual. Apps Script tiene una función instaladora de trigger cada 15 minutos; eso no prueba que el trigger desplegado exista.
- Comprobación HTTP a las 14:49 Madrid: nueve feeds HTTP 200, 80 eventos, UID únicos y correspondencia exacta con el JSON; hash del manifiesto correcto. El contenido público anterior a esta PR no tiene enlaces Maps.
- Consulta de Google Calendar: 85 eventos entre 01/09/2026 y 01/08/2027; ninguno conserva `ACTAWP_MATCH_ID:`. No se puede demostrar desde esos eventos que el código del repositorio sea el que se ejecuta. No se modificó el calendario real durante esta auditoría.
- El [proyecto Apps Script facilitado](https://script.google.com/home/projects/1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A/edit) se redirige a la página pública en el navegador sin sesión. Código desplegado, logs, permisos y triggers siguen sin verificar.

## Correcciones y pruebas

| Caso | Resultado y protección |
| --- | --- |
| HTTP 429 | Detiene también la cadena de proxies; conserva JSON, estado validado y feeds. El intento fallido lleva fecha propia. Un workflow verde por 429 solo significa conservación, no datos nuevos. |
| Fallo parcial | No publica un snapshot parcial. Fecha ilegible o ausente en una fila AESE produce error en vez de omitir silenciosamente el partido. |
| Desaparición de partido | Bloquea el exportador y los feeds. La ausencia por sí sola no se interpreta como cancelación. |
| Duplicados de origen | Filas exactamente iguales se deduplican. Datos contradictorios para la misma identidad bloquean la exportación. |
| Cambio de fecha o sede | Mantiene UID/URL; incrementa SEQUENCE y LAST-MODIFIED. Apps Script recupera eventos con marcador de identidad incluso tras aplazamientos largos o a otra temporada. |
| Aplazamiento/cancelación | Texto explícito detectado en HTML bloquea publicación y exige revisión. Los consumidores admiten `tentative`/`cancelled` explícitos, manteniendo UID y evento. No se ha supuesto ningún estado nuevo en los 80 partidos. |
| Referencias Apps Script | Identidad `torneo:partido`, marcador por línea exacta, migración de referencias antiguas solo con URL de origen coincidente; error de lectura no provoca creación. |
| Fallo tras crear evento | El marcador permite recuperar el evento si falla guardar su referencia. La ejecución fallida no registra LAST_SYNC exitoso; siempre libera el bloqueo. |
| Duplicados Clupik | No se borran ni se adoptan por similitud. Coincidencia de equipos y hora bloquea una creación potencialmente duplicada. Un evento movido sin marcador no se puede relacionar de forma segura: requiere vinculación revisada. |
| Maps | Los 80 eventos de los nueve feeds incluyen URL de búsqueda `api=1`, codificación correcta y fuente de sede. No se cambian URL de ActaWP ni UID. Las 26 sedes están en `data/venues.json`; sede desconocida bloquea generación en vez de inventar dirección. |

Pruebas: `python -m unittest discover -s tests -p 'test_*.py'` (13), `node --test tests/*.test.mjs` (26 inicialmente), generación repetida estable y `git diff --check`. Las pruebas de Apps Script usan servicios simulados: no validan permisos ni cuotas reales del proyecto. La prueba de publicación usa dos clones y un remoto Git local, reproduce el rechazo inicial y verifica que ambos cambios sobreviven.

Formato Maps conforme a [Google Maps URLs](https://developers.google.com/maps/documentation/urls/get-started). Se usan nombres de instalaciones y direcciones contrastadas, sin coordenadas ni place IDs inventados. El enlace es una búsqueda de la instalación; no certifica un pin ni una puerta de acceso. Las variantes de Sant Andreu (25m/Trinitat Vella), Mediterrani Regent Mendieta, Sabadell Can Llong y Martorell se distinguen de otras sedes del club. Cada entrada registra su fuente primaria/federativa; no se sustituye una sede por la dirección social de otro recinto.

## Duplicados observados: conservar y revisar

Tres pares coinciden en equipos y hora. Se conserva toda la información hasta elegir con el propietario qué evento mantiene historial, invitados o enlaces:

| Fecha Madrid | Partido | IDs de los eventos |
| --- | --- | --- |
| 26/09/2026 16:00 | Santa Eulàlia – Martorell | `16r2kdaag0mch2oni3l4qjmfu8`, `n37ac3g6v21ubq5sc6jo2gvv80` |
| 03/10/2026 17:00 | Banyoles – Santa Eulàlia | `egmgapnouvdok5fn2mq8fopfsc`, `oe7uj4t4qauhepc5trtqfe6fa4` |
| 09/10/2026 20:45 | Santa Eulàlia – Granollers | `p508819l13bul1qld2emuaqtng`, `umif47qkl74m9n4g596f7qpc7o` |

## Aplicación al calendario general y pendientes

1. Acceder al editor del proyecto con la cuenta propietaria. Revisar código real, ejecuciones y triggers de ambas automatizaciones (Clupik y ActaWP); conservar copia del código antes de sustituirlo.
2. Revisar y fusionar esta PR únicamente cuando Actions del commit propuesto termine correctamente. Comprobar después nueve feeds públicos, 80 Maps, UID/URL intactos y JSON/manifiesto concordantes. El proyecto Apps Script carga archivos de un commit inmutable de main; `venues.json` debe estar publicado antes de utilizar las nuevas funciones.
3. Copiar el código revisado al proyecto adecuado evitando funciones/constantes duplicadas. Ejecutar `previewGeneralCalendarMaps()`: devuelve cambios sin escribir. `updateGeneralCalendarMaps()` añade solo un bloque Maps en las descripciones de eventos con sede exacta verificada; conserva texto, fechas, sedes, identidades y duplicados. Repetir es idempotente. No instalar un trigger de sincronización antes de revisar el preview y la relación con Clupik.
4. Comprobar por lectura que los enlaces persisten tras una ejecución de Clupik. Si la automatización existente reescribe descripciones, incorporar el mismo enriquecimiento después de esa escritura; no se ha podido comprobar ese código desplegado.
5. Vincular eventos existentes al origen mediante revisión de torneo, categoría, equipos y fecha antes de activar `syncActaWPToCalendar`. Los 85 eventos sin marcador no deben asumirse todos como eventos administrados por el nuevo script. No se ofrece una limpieza automática de duplicados.
6. Ante un aviso de partido cancelado/aplazado, confirmar el estado en ActaWP o FCN. El parser no implementa un contrato completo de estados del HTML porque no se dispone de muestras reales contrastadas de cada variante. Requiere revisión y pruebas de esas muestras antes de automatizar todos los estados. Un `status` revisado en JSON puede publicarse con `CANCELLED` o `TENTATIVE`, conservando la última fecha conocida; coordinarlo con el exportador antes del siguiente refresco para evitar que lo sustituya por datos antiguos.
7. Revisar nuevas sedes en `data/venues.json` y cambios de temporada. La protección de desapariciones requiere revisión al retirar legítimamente eventos de una temporada anterior.

No se modifica PWA/Supabase. La disponibilidad de ActaWP, cuotas/latencia de Apps Script y refresco de suscripciones Google/Apple no pueden garantizarse con pruebas locales. Una ejecución parcialmente escrita en Google Calendar no es una transacción: se reintenta por identidad, sin borrar eventos.
