const CLUPIK_REMITENTE = 'no-reply@clupik.com';
const CALENDAR_ID = '68af70845551fc729e20ff0ff1ca9f69bbbadade7031e6b90ace51fbcd279c7f@group.calendar.google.com';
function procesarPartidosAESE() {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Clupik: ejecución solapada; se reintentará'); return; }
  try {
    AESE_SNAPSHOT_CACHE=loadActaWPSnapshot_();
    ACTAWP_EVENT_CACHE={};
    return procesarPartidosAESESinBloqueo_();
  }
  finally { AESE_SNAPSHOT_CACHE=null; ACTAWP_EVENT_CACHE=null; lock.releaseLock(); }
}
function procesarPartidosAESESinBloqueo_() {
  const calendar=CalendarApp.getCalendarById(CALENDAR_ID);
  if(!calendar) throw Error('Calendario AESE no accesible');
  const props=PropertiesService.getScriptProperties();
  const now=new Date();
  // Replay overlapping delivery windows, including messages indexed late by Gmail.
  const checkpoint=Date.parse(props.getProperty('ULTIMA_EJECUCION')||'');
  const from=Number.isFinite(checkpoint)?checkpoint-48*3600000:now.getTime()-7*86400000;
  const query='from:'+CLUPIK_REMITENTE+' after:'+Math.floor(from/1000);
  const messages=[], seen=new Set();
  for(let offset=0;;offset+=100) {
    const threads=GmailApp.search(query,offset,100);
    for(const thread of threads) for(const message of thread.getMessages()) {
      if(message.getDate().getTime()<from || message.getDate()>now ||
        !/^(?:.*<)?no-reply@clupik\.com>?$/i.test(message.getFrom().trim())) continue;
      const id=message.getId();
      if(!seen.has(id)) { seen.add(id); messages.push(message); }
    }
    if(threads.length<100) break;
    if(offset>=900) throw Error('Backlog Clupik supera 1000 hilos; checkpoint conservado');
  }
  messages.sort((a,b)=>a.getDate()-b.getDate()||a.getId().localeCompare(b.getId()));
  let errors=0, processed=0, skipped=0;
  // 48h overlap is retained, but already-successful messages need no
  // further Calendar reads or writes on every 15-minute trigger.
  for(const message of messages) {
    if(!/partid|match/i.test(message.getSubject())) continue;
    const doneKey='AESE_CLUPIK_DONE_'+message.getId();
    if(props.getProperty(doneKey)) { skipped++; continue; }
    try {
      procesarMensajeAESE_(message,calendar);
      props.setProperty(doneKey,message.getDate().toISOString());
      processed++;
    } catch(error) { errors++; Logger.log('Clupik '+message.getId()+': '+error.message); }
  }
  Logger.log('Clupik procesados='+processed+' omitidos='+skipped);
  if(errors) throw Error('Clupik incompleto: se conserva ULTIMA_EJECUCION para reintentar; errores='+errors);
  props.setProperty('ULTIMA_EJECUCION',now.toISOString());
  Logger.log('Clupik OK mensajes='+messages.length);
}
function procesarMensajeAESE_(message,calendar) { return reconcileClupikNotice_(message,calendar); }
function obtenerCategoriaCorta_(competicion) {
  const texto =
    normalizarSinAcentos_(competicion);
  const categoriasBase = [
    'ALEVIN',
    'ALEVI',
    'INFANTIL',
    'CADET',
    'JUVENIL',
    'ABSOLUT'
  ];
  let categoriaBase = null;
  for (const categoria of categoriasBase) {
    if (
      new RegExp(
        '\\b' +
        categoria +
        '\\b'
      ).test(texto)
    ) {
      categoriaBase = categoria;
      break;
    }
  }
  if (!categoriaBase) {
    // Si no reconocemos la categoría,
    // no inventamos una.
    return competicion
      .replace(
        /\s+\d{2}\/\d{2}\s*$/i,
        ''
      )
      .trim();
  }
  let genero = '';
  if (
    /\bFEMENI\b/.test(texto)
  ) {
    genero = 'FEMENINO';
  } else if (
    /\bMASCULI\b/.test(texto)
  ) {
    genero = 'MASCULINO';
  } else if (
    /\bMIXT(?:O|E)?\b/.test(texto)
  ) {
    genero = 'MIXTO';
  }
  const baseMostrar = {
    'ALEVIN': 'ALEVÍN',
    'ALEVI': 'ALEVÍN',
    'INFANTIL': 'INFANTIL',
    'CADET': 'CADETE',
    'JUVENIL': 'JUVENIL',
    'ABSOLUT': 'ABSOLUTO'
  }[categoriaBase];
  let resultado =
    baseMostrar;
  if (genero) {
    resultado +=
      ' ' +
      genero;
  }
  // Detectar equipos A/B cuando formen
  // parte de la categoría.
  const marcadorGenero =
    genero === 'FEMENINO'
      ? 'FEMENI'
      : genero === 'MASCULINO'
        ? 'MASCULI'
        : genero === 'MIXTO'
          ? 'MIXT'
          : '';
  const indiceGenero =
    marcadorGenero
      ? texto.indexOf(marcadorGenero)
      : -1;
  if (indiceGenero !== -1) {
    const despuesGenero =
      texto.substring(
        indiceGenero +
        marcadorGenero.length
      ).trim();
    const grupo =
      despuesGenero.match(
        /^([AB])\b/
      );
    if (grupo) {
      resultado +=
        ' ' +
        grupo[1];
    }
  }
  return resultado;
}
// ======================================================
// NORMALIZAR TEXTO SIN ACENTOS
// ======================================================
function normalizarSinAcentos_(texto) {
  return texto
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .toUpperCase()
    .trim();
}
function clupikMadridDate_(year, month, day, hour, minute) {
  const fields = [year, month, day, hour, minute];
  if (!fields.every(Number.isInteger) || year < 2000 || year > 2100) {
    throw new Error('Fecha u hora Clupik inválida');
  }
  const pad = value => String(value).padStart(2, '0');
  const expected = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hour) + ':' + pad(minute);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = [60, 120].map(offset => new Date(wall - offset * 60000)).filter(date =>
    Utilities.formatDate(date, 'Europe/Madrid', "yyyy-MM-dd'T'HH:mm") === expected);
  if (candidates.length !== 1) throw new Error('Fecha u hora Clupik inválida o ambigua en Europe/Madrid: ' + expected);
  return candidates[0];
}

