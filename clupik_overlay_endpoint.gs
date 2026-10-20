/**
 * AESE Waterpolo — qué ha cambiado Clupik, para los .ics de las familias.
 *
 * Apps Script ya lee los avisos de Clupik y los aplica al Google Calendar. Los 9
 * enlaces .ics se generan en GitHub solo con los datos de ActaWP, así que no se
 * enteraban. Esta función, publicada como aplicación web de solo lectura, entrega
 * esos mismos avisos ya interpretados; un workflow de GitHub los lee cada 30
 * minutos (scripts/clupik-overlay.mjs) y el generador (scripts/calendar-feeds.mjs)
 * los aplica con la misma regla que el calendario.
 *
 * Solo sale lo que ya es público en ActaWP: identidad del partido, equipos, sede,
 * fecha y estado. Nunca salen correos, identificadores de mensaje, remitentes ni
 * texto libre del aviso. No escribe nada ni toca el Calendar.
 */
const AESE_OVERLAY_SCHEMA = 1;
const AESE_OVERLAY_FIELDS = ['category','home_team','away_team','venue','round_name','start','status','received_at','acknowledged_snapshot'];

function aeseOverlayText_(value) {
  // Cada campo es un texto corto de una línea; cualquier otra cosa se descarta.
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f]/.test(value)) return null;
  return value;
}

function aeseOverlayDocument_(props, nowMs) {
  const all = props.getProperties(), notices = [];
  Object.keys(all).filter(key => key.indexOf(AESE_NOTICE_PREFIX) === 0).sort().forEach(key => {
    let saved;
    try { saved = JSON.parse(all[key]); } catch (_) { return; }
    if (!saved || saved.undated || !saved.start) return;                      // un partido sin fecha no tiene nada que publicar
    if (!Number.isSafeInteger(saved.tournament_id) || !Number.isSafeInteger(saved.match_id)) return;
    if (key !== AESE_NOTICE_PREFIX + saved.tournament_id + ':' + saved.match_id) return;
    const entry = {tournament_id: saved.tournament_id, match_id: saved.match_id};
    for (const field of AESE_OVERLAY_FIELDS) {
      if (saved[field] === undefined || saved[field] === null) continue;
      const text = aeseOverlayText_(saved[field]);
      if (text === null) return;                                              // un aviso con un campo raro no sale entero
      entry[field] = text;
    }
    notices.push(entry);
  });
  return {
    schema_version: AESE_OVERLAY_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    // Cuándo terminó bien por última vez la lectura del correo de Clupik: permite a
    // quien lee esto distinguir «sin cambios» de «Apps Script lleva horas sin leer».
    clupik_last_success: all.AESE_CLUPIK_LAST_SUCCESS || null,
    notices
  };
}

// Aplicación web (Implementar → Nueva implementación → Aplicación web; ejecutar como
// «Yo»; acceso «Cualquier usuario»). Solo responde a GET y no recibe parámetros.
function doGet() {
  return ContentService.createTextOutput(JSON.stringify(aeseOverlayDocument_(PropertiesService.getScriptProperties(), Date.now())))
    .setMimeType(ContentService.MimeType.JSON);
}
