const CLUPIK_REMITENTE = 'no-reply@clupik.com';
const CALENDAR_ID = '68af70845551fc729e20ff0ff1ca9f69bbbadade7031e6b90ace51fbcd279c7f@group.calendar.google.com';
function procesarPartidosAESE() {
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Clupik: ejecución solapada; se reintentará'); return {status:'locked'}; }
  try {
    // Clupik must work while the remote exporter or Pages is unavailable.
    AESE_SNAPSHOT_CACHE=AESE_OFFLINE_BUNDLE.matches;
    ACTAWP_VENUES=AESE_OFFLINE_BUNDLE.venues;
    ACTAWP_SNAPSHOT_TIME=null;
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
  const deadline=AESE_RUN_DEADLINE || Date.now()+180000;
  const done=props.getProperties();
  // Replay overlapping delivery windows, including messages indexed late by Gmail.
  const checkpoint=Date.parse(props.getProperty('ULTIMA_EJECUCION')||'');
  const from=Number.isFinite(checkpoint)?checkpoint-48*3600000:now.getTime()-7*86400000;
  // Bound storage even when a held notice keeps the window checkpoint from
  // advancing. Values are processing times, which are never earlier than the
  // message date, so a mark older than the window start belongs to a message the
  // window no longer reaches. While the window is held open the marks must stay,
  // or every run would process the same notices again.
  const doneLimit=Math.min(now.getTime()-49*3600000,from-3600000);
  Object.keys(done).filter(k=>k.startsWith('AESE_CLUPIK_DONE_') && Date.parse(done[k])<doneLimit).forEach(k=>{props.deleteProperty(k);delete done[k];});
  Object.keys(done).filter(k=>(k.startsWith('AESE_CLUPIK_BAD_') || k.startsWith('AESE_ALERT_aviso_')) && Number(done[k])<now.getTime()-10*86400000).forEach(k=>{props.deleteProperty(k);delete done[k];});
  let scan={};
  try { scan=JSON.parse(props.getProperty('AESE_CLUPIK_SCAN_V1')||'{}'); } catch(_) {}
  if(!Number.isFinite(scan.from)||!Number.isFinite(scan.until)||!Number.isInteger(scan.offset)||scan.offset<0)
    scan={from,until:now.getTime(),offset:0,errors:0};
  const query='from:'+CLUPIK_REMITENTE+' after:'+Math.floor(scan.from/1000)+' before:'+(Math.floor(scan.until/1000)+1);
  const messages=[], seen=new Set();
  let processed=0, skipped=0, setAside=0, held=0;
  const unreadable=[];
  for(let offset=scan.offset;;offset+=100) {
    scan.offset=offset;
    props.setProperty('AESE_CLUPIK_SCAN_V1',JSON.stringify(scan));
    if(Date.now()>deadline-30000) return {status:'pending'};
    const threads=GmailApp.search(query,offset,100);
    messages.length=0;
    for(const thread of threads) for(const message of thread.getMessages()) {
      if(message.getDate().getTime()<scan.from || message.getDate().getTime()>scan.until ||
        !/^(?:.*<)?no-reply@clupik\.com>?$/i.test(message.getFrom().trim())) continue;
      const id=message.getId();
      if(!seen.has(id)) { seen.add(id); messages.push(message); }
    }
  messages.sort((a,b)=>a.getDate()-b.getDate()||a.getId().localeCompare(b.getId()));
  // 48h overlap is retained, but already-successful messages need no
  // further Calendar reads or writes on every 15-minute trigger.
  for(const message of messages) {
    if(!/partid|match/i.test(message.getSubject())) continue;
    const doneKey='AESE_CLUPIK_DONE_'+message.getId();
    if(done[doneKey]) { skipped++; continue; }
    if(processed>=12 || Date.now()>deadline-30000) return {status:'pending'};
    try {
      procesarMensajeAESE_(message,calendar);
      props.setProperty(doneKey,new Date().toISOString());
      processed++;
    } catch(error) {
      ACTAWP_EVENT_CACHE={};
      if(error.unreadable) {
        // A notice that cannot be interpreted is not a failure of the run (it
        // would repeat the same error every 15 minutes): it is held, reported
        // once and, after the grace period, set aside.
        const state=aeseTriageUnreadable_(props,message,error,now.getTime());
        if(state==='aside') setAside++;
        else { held++; unreadable.push({id:message.getId(),subject:message.getSubject(),received:message.getDate().toISOString(),reason:error.message}); }
        Logger.log('Clupik '+message.getId()+' sin interpretar ('+state+'): '+error.message);
        continue;
      }
      scan.errors++;
      Logger.log('Clupik '+message.getId()+': '+error.message);
    }
  }
    if(threads.length<100) break;
  }
  props.deleteProperty('AESE_CLUPIK_SCAN_V1');
  Logger.log('Clupik procesados='+processed+' omitidos='+skipped+(held?' retenidos='+held:'')+(setAside?' apartados='+setAside:''));
  aeseAlertUnreadable_(props,unreadable,now.getTime());
  if(scan.errors) throw Error('Clupik incompleto: se conserva ULTIMA_EJECUCION para reintentar; errores='+scan.errors+
    (held?'; avisos sin interpretar retenidos='+held:''));
  // While a notice is held the window stays open so it is read again each run;
  // the run itself has worked, so it is reported as complete.
  if(!held) props.setProperty('ULTIMA_EJECUCION',new Date(scan.until).toISOString());
  Logger.log('Clupik OK mensajes='+messages.length+(held?' (ventana abierta por '+held+' aviso(s) retenido(s))':''));
  return {status:'complete',held};
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

