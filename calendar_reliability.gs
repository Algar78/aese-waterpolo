/** Clupik notices are a durable, per-match overlay on the last good snapshot.
 * Never discard a notice merely because ActaWP already owns its identity.
 */
const AESE_ALERT_EMAIL = 'algarri1978@gmail.com';
const AESE_NOTICE_PREFIX = 'AESE_NOTICE_';
let AESE_SNAPSHOT_CACHE = null;
let AESE_RUN_DEADLINE = null;

function decodeClupikHTML_(text) {
  return String(text).replace(/&amp;/gi,'&').replace(/&nbsp;/gi,' ')
    .replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));
}

function clupikIdentity_(html) {
  const identities = {};
  for (const link of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let url = decodeClupikHTML_(link[1]);
    // Extract the tracking destination without requesting the tracking endpoint.
    const target = url.match(/[?&]url=([^&]+)/i);
    if (target) url = target[1];
    for (let i=0;i<4;i++) {
      let decoded;
      try { decoded = decodeURIComponent(url); } catch (_) { break; }
      if (decoded === url) break;
      url = decoded;
    }
    const m=url.match(/^https:\/\/(?:leverade\.com|clupik\.pro|actawp\.natacio\.cat)\/(?:[a-z]{2}\/)?tournament\/(\d+)\/match\/(\d+)\/results(?:[?#].*)?$/i);
    if (m) identities[m[1]+':'+m[2]]={tournament_id:Number(m[1]),match_id:Number(m[2]),url:'https://actawp.natacio.cat/ca/tournament/'+m[1]+'/match/'+m[2]+'/results'};
  }
  const keys=Object.keys(identities);
  if (keys.length !== 1) throw Error('Identidad Clupik ausente o ambigua');
  return identities[keys[0]];
}

function parseClupikNotice_(message) {
  const html=message.getBody(), identity=clupikIdentity_(html);
  const clean=text=>decodeClupikHTML_(text.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
  // Leaf blocks avoid capturing nested col-1/row wrappers as a single field.
  const blocks=Array.from(html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
    .matchAll(/<(?:div|td|p|span)\b[^>]*>((?:(?!<(?:div|td|p|span)\b)[\s\S])*?)<\/(?:div|td|p|span)>/gi),m=>clean(m[1])).filter(Boolean);
  const ti=blocks.findIndex(b=>/^\d{1,2}:\d{2}$/.test(b));
  const di=blocks.findIndex(b=>/^\d{2}\/\d{2}\/\d{4}$/.test(b));
  if (ti<0 || di<0) throw Error('No se pudieron localizar los datos principales del partido');
  const competition=blocks.find(b=>/LLIGA CATALANA/i.test(b));
  const home=blocks[ti+1], away=blocks[di+1];
  const venue=blocks.slice(di+2).find(b=>/^\d+\s*-\s*\S/.test(b));
  if (!competition || !home || !away || !venue || !/SANTA EUL|\bAESE\b/i.test(home+' '+away)) throw Error('Equipos, competición o piscina Clupik inválidos');
  const [a,b,year]=blocks[di].split('/').map(Number);
  const knownTemplate=/id=["']calendar["']/.test(html) && /id=["']clock["']/.test(html);
  if (!knownTemplate && a<=12 && b<=12 && a!==b) throw Error('Fecha Clupik ambigua; contrastar origen');
  const day=knownTemplate?b:b>12?b:a, month=knownTemplate?a:b>12?a:b;
  const [hour,minute]=blocks[ti].split(':').map(Number);
  const start=clupikMadridDate_(year,month,day,hour,minute);
  let category=obtenerCategoriaCorta_(competition).replace(/MIXTE/i,'MIXTO');
  const aeseTeam=/SANTA EUL|\bAESE\b/i.test(home)?home:away;
  if (!/\s[AB]$/.test(category) && /\s([AB])$/.test(aeseTeam)) category+=' '+aeseTeam.match(/\s([AB])$/)[1];
  const subject=message.getSubject();
  const cancelled=/cancel|anul|susp[eè]s|suspend/i.test(subject);
  const tentative=/ajorn|aplaz/i.test(subject);
  return Object.assign(identity,{category,home_team:home,away_team:away,venue,
    round_name:blocks.slice(ti+2,di).find(b=>/Jornada/i.test(b))||'',
    start:Utilities.formatDate(start,'Europe/Madrid',"yyyy-MM-dd'T'HH:mm:ssXXX"),
    status:cancelled?'cancelled':tentative?'tentative':'confirmed',
    received_at:message.getDate().toISOString(), message_id:message.getId()});
}

function applyClupikNotice_(match) {
  const saved=PropertiesService.getScriptProperties().getProperty(AESE_NOTICE_PREFIX+actaWPIdentity_(match));
  if (!saved) return match;
  const notice=JSON.parse(saved);
  // A successful snapshot must first agree with the notice. Later successful
  // snapshots can then advance it; replaying the same email cannot pin it forever.
  const snapshotTime=Date.parse(ACTAWP_SNAPSHOT_TIME || '');
  const agrees=['start','venue','home_team','away_team'].every(k=>match[k]===notice[k]) &&
    (match.status||'confirmed')===notice.status;
  if(Number.isFinite(snapshotTime) && snapshotTime>Date.parse(notice.received_at)) {
    if(agrees && !notice.acknowledged_snapshot) {
      notice.acknowledged_snapshot=ACTAWP_SNAPSHOT_TIME;
      PropertiesService.getScriptProperties().setProperty(AESE_NOTICE_PREFIX+actaWPIdentity_(match),JSON.stringify(notice));
    }
    if(notice.acknowledged_snapshot && snapshotTime>=Date.parse(notice.acknowledged_snapshot)) return match;
    if(!agrees) aeseAlert_('discordancia_'+actaWPIdentity_(match),'La fuente posterior no confirma el aviso FCN. Se conserva el aviso y se requiere revisión: '+actaWPIdentity_(match));
  }
  return Object.assign({},match,notice,{category:match.category});
}

function reconcileClupikNotice_(message,calendar) {
  let notice;
  // A notice that cannot be read fails the same way on every retry and touches
  // no state, unlike a Calendar or venue error, which can heal by itself.
  try { notice=parseClupikNotice_(message); } catch(error) { error.unreadable=true; throw error; }
  const id=actaWPIdentity_(notice);
  const props=PropertiesService.getScriptProperties(), key=AESE_NOTICE_PREFIX+id;
  const saved=props.getProperty(key), old=saved?JSON.parse(saved):null;
  if (old && (Date.parse(old.received_at)>Date.parse(notice.received_at) ||
    (old.received_at===notice.received_at && old.message_id && old.message_id>notice.message_id))) return 'older';
  const source=(AESE_SNAPSHOT_CACHE || loadActaWPSnapshot_()).find(m=>actaWPIdentity_(m)===id);
  if(old && old.received_at===notice.received_at && (!old.message_id || old.message_id===notice.message_id)) {
    if(old.acknowledged_snapshot) return 'acknowledged';
    return reconcileActaWPMatch_(calendar,applyClupikNotice_(source || old));
  }
  const match=Object.assign({},source||{},notice,{category:source?source.category:notice.category});
  // Persist before Calendar: if Calendar fails, the next ActaWP run repairs it.
  // Unknown venues fail safely before persisting or creating an event.
  actaWPMapsURL_(match.venue);
  props.setProperty(key,JSON.stringify(match));
  const result=reconcileActaWPMatch_(calendar,match);
  Logger.log('Clupik '+id+' '+result);
  return result;
}

// A Clupik notice that cannot be interpreted keeps the checkpoint (it might hold
// a real change) for a grace period, so a person can look at it. After that it
// is set aside, with one alert: otherwise a single email blocks every later
// notice, repeats the alerts all day and makes each run reprocess a window that
// only grows.
const AESE_UNREADABLE_GRACE_MS = 72*3600000;
function aeseSetAsideUnreadable_(props,message,error,nowMs) {
  const key='AESE_CLUPIK_BAD_'+message.getId(), first=Number(props.getProperty(key)||0);
  if(!first) { props.setProperty(key,String(nowMs)); return false; }
  if(nowMs-first<AESE_UNREADABLE_GRACE_MS) return false;
  props.setProperty('AESE_CLUPIK_DONE_'+message.getId(),new Date(nowMs).toISOString());
  aeseAlert_('apartado_'+message.getId(),
    'Un aviso de Clupik no se ha podido interpretar en 72 horas y se aparta para que el resto de avisos sigan procesándose.\n'+
    'Asunto: «'+message.getSubject()+'»\nRecibido: '+message.getDate().toISOString()+'\nMotivo: '+error.message+'\n'+
    'Puede contener un cambio real de un partido: ábrelo en Gmail y, si es así, compruébalo en ActaWP.',
    30*86400000,'AESE: aviso de Clupik apartado por no poder interpretarse','');
  return true;
}

function aeseAlert_(key,detail,windowMs,subject,tail) {
  const props=PropertiesService.getScriptProperties(), now=Date.now();
  const previous=Number(props.getProperty('AESE_ALERT_'+key)||0);
  if(now-previous<(windowMs||6*3600000)) return;
  try { MailApp.sendEmail(AESE_ALERT_EMAIL,subject||('AESE: incidencia de sincronización — '+key),
    detail+(tail===undefined?'\nSe conservan las identidades y se reintentará automáticamente.':tail)+'\n'+
    'https://script.google.com/home/projects/1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A/executions');
  props.setProperty('AESE_ALERT_'+key,String(now));
  } catch(error) { console.log('Alert delivery failed: '+error.message); }
}

// ---- Frescura de los datos oficiales -------------------------------------
// "Ejecutado correctamente" no significa "actualizado": el 16/10 el ciclo
// terminó bien con datos de hacía seis días. Estas funciones miden la edad del
// último dato oficial completo y avisan solo cuando importa.
// Valores por defecto, para una lectura automática cada 6 h. La política real
// viaja dentro del paquete publicado (status.freshness_policy, que sale de
// data/freshness_policy.json): con una lectura semanal hecha por una persona
// se cambia allí, sin volver a desplegar este archivo.
const AESE_FRESH_HOURS = 12;      // una vuelta perdida del exportador (cada 6 h) aún es normal
const AESE_OUTDATED_HOURS = 48;   // a partir de aquí el calendario depende solo de los avisos Clupik
const AESE_FRESHNESS_REMINDER_MS = 48*3600000;

function aeseFreshnessPolicy_(status) {
  const p=(status && status.freshness_policy) || {};
  const fresh=Number(p.fresh_hours), outdated=Number(p.outdated_hours), reminder=Number(p.reminder_hours);
  if(!(fresh>0 && outdated>fresh)) return {freshHours:AESE_FRESH_HOURS,outdatedHours:AESE_OUTDATED_HOURS,reminderMs:AESE_FRESHNESS_REMINDER_MS};
  return {freshHours:fresh,outdatedHours:outdated,reminderMs:(reminder>0?reminder:outdated)*3600000};
}

function aeseFreshness_(status, now) {
  const policy=aeseFreshnessPolicy_(status);
  const stamp=Date.parse((status && status.last_complete_export_at) || '');
  if(!Number.isFinite(stamp)) return {state:'unknown',ageHours:null,stamp:null,policy};
  const ageHours=Math.max(0,(now-stamp)/3600000);
  return {state:ageHours<=policy.freshHours?'fresh':ageHours<=policy.outdatedHours?'stale':'outdated',ageHours,stamp,policy};
}

function aeseCheckFreshness_(status, attempt) {
  const props=PropertiesService.getScriptProperties(), now=Date.now();
  const f=aeseFreshness_(status,now), previous=props.getProperty('AESE_FRESHNESS_STATE')||'fresh';
  props.setProperty('AESE_FRESHNESS_STATE',f.state);
  props.setProperty('AESE_FRESHNESS_AGE_HOURS',f.ageHours===null?'':f.ageHours.toFixed(1));
  const when=f.stamp?Utilities.formatDate(new Date(f.stamp),'Europe/Madrid','dd/MM/yyyy HH:mm'):'desconocida';
  const days=f.ageHours===null?'?':(f.ageHours/24).toFixed(1);
  // Causes live in the latest attempt; the published status only describes the last good export.
  const errors=(attempt && attempt.error_classes && attempt.error_classes.length)?attempt.error_classes.join(', '):'';
  const failures=(attempt && attempt.consecutive_failures) || 0;
  const lastTry=(failures>0 && errors)?' El último intento de lectura falló ('+errors+'; '+failures+' seguidos).':'';
  if(f.state==='outdated') {
    aeseAlert_('frescura_obsoleta','Los datos oficiales de ActaWP no se actualizan desde hace '+days+' días '+
      '(última lectura completa: '+when+', hora de Madrid).'+lastTry+'\n'+
      'El calendario sigue funcionando con los avisos oficiales de Clupik, pero un cambio que no llegue por correo no se reflejará.\n'+
      'Para confirmarlo contra la fuente oficial, sube las páginas guardadas: https://github.com/Algar78/aese-waterpolo/tree/main/data/manual',
      f.policy.reminderMs,'AESE: datos oficiales sin actualizar desde hace '+days+' días');
  } else if(f.state==='unknown') {
    aeseAlert_('frescura_desconocida','No se puede saber cuándo se leyeron por última vez los datos oficiales: el paquete publicado no incluye last_complete_export_at.',
      24*3600000,'AESE: no se puede comprobar la frescura de los datos');
  } else if(f.state==='fresh' && previous==='outdated') {
    aeseAlert_('frescura_recuperada','Los datos oficiales de ActaWP vuelven a estar al día (última lectura completa: '+when+').',
      3600000,'AESE: datos oficiales de nuevo al día');
  }
  return f;
}

function runAESECalendarSync() {
  const props=PropertiesService.getScriptProperties();
  AESE_RUN_DEADLINE=Date.now()+240000;
  props.setProperty('AESE_LAST_ATTEMPT',new Date().toISOString());
  // Clupik is the primary notification path. A stale ActaWP export must
  // not make an otherwise healthy email-to-Calendar sync appear failed.
  let clupikFailure=null;
  try {
    const result=procesarPartidosAESE();
    if(!result || result.status!=='complete') throw Error('Clupik '+(result?result.status:'unknown'));
    props.setProperty('AESE_CLUPIK_LAST_SUCCESS',new Date().toISOString());
    props.setProperty('AESE_CLUPIK_LAST_ERROR','');
  } catch(error) {
    clupikFailure=error;
    props.setProperty('AESE_CLUPIK_LAST_ERROR',error.message);
    aeseAlert_('clupik','No se procesaron los avisos Clupik: '+error.message);
  }
  let actawpFailure=null;
  try {
    const result=syncActaWPToCalendar();
    if(!result || result.status==='locked') throw Error('ActaWP locked');
    // A batch completing is not equivalent to reconciling the full season.
    const pending=props.getProperty('ACTAWP_BATCH_CURSOR_V1');
    if (!pending) props.setProperty('AESE_ACTAWP_LAST_SUCCESS',new Date().toISOString());
    props.setProperty('AESE_ACTAWP_LAST_ERROR','');
  } catch(error) {
    actawpFailure=error;
    props.setProperty('AESE_ACTAWP_LAST_ERROR',error.message);
    aeseAlert_('actawp','No se pudo conciliar ActaWP: '+error.message);
  }
  if(clupikFailure) {
    props.setProperty('AESE_LAST_ERROR','Clupik: '+clupikFailure.message);
    throw Error('Clupik: '+clupikFailure.message);
  }
  // Keep legacy heartbeat for monitoring of the primary Calendar pathway.
  props.setProperty('AESE_LAST_SUCCESS',new Date().toISOString());
  props.setProperty('AESE_LAST_ERROR',actawpFailure?'ActaWP: '+actawpFailure.message:'');
  console.log('AESE Clupik OK; ActaWP '+(actawpFailure?'degraded':'OK'));
}

function installAESEAutomation() {
  // Install replacements before removing the old schedule; unrelated triggers stay.
  const managed=['runAESECalendarSync','checkAESECalendarHealth','syncActaWPToCalendar','procesarPartidosAESE'];
  const old=ScriptApp.getProjectTriggers().filter(t=>managed.includes(t.getHandlerFunction()));
  ScriptApp.newTrigger('runAESECalendarSync').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('checkAESECalendarHealth').timeBased().everyMinutes(30).create();
  old.forEach(t=>ScriptApp.deleteTrigger(t));
  console.log('AESE: ciclo cada 15 minutos; vigilancia cada 30 minutos');
}

function checkAESECalendarHealth() {
  const props=PropertiesService.getScriptProperties(), last=Date.parse(props.getProperty('AESE_CLUPIK_LAST_SUCCESS')||props.getProperty('AESE_LAST_SUCCESS')||'');
  if(!Number.isFinite(last)||Date.now()-last>45*60000) {
    aeseAlert_('retraso','Sin procesamiento Clupik correcto en 45 minutos. Se intenta recuperación.');
    runAESECalendarSync();
  }
  const lastFull=Date.parse(props.getProperty(ACTAWP_SYNC_PROPERTY)||'');
  if(!Number.isFinite(lastFull)||Date.now()-lastFull>6*3600000) aeseAlert_('conciliacion','Sin conciliación completa ActaWP en seis horas.');
  try {
  const attempt=fetchActaWPJSON_('https://algar78.github.io/aese-waterpolo/data/actawp_last_attempt.json');
  const attempted=Date.parse(attempt.attempted_at||'');
  if(!attempt.complete || !Number.isFinite(attempted) || Date.now()-attempted>8*3600000)
    aeseAlert_('fuente','Exportación ActaWP incompleta o sin intento en 8 horas: '+JSON.stringify(attempt.errors||[]),24*3600000);
  const bundle=fetchActaWPJSON_(ACTAWP_BUNDLE_URL);
  aeseCheckFreshness_(bundle.status || {}, attempt);
  const published=Date.parse((bundle.status || {}).attempted_at || '');
  if(attempt.complete && Date.now()-attempted>30*60000 && (!Number.isFinite(published) || published<attempted))
    aeseAlert_('publicacion','La exportación correcta no ha llegado al paquete de Calendar en 30 minutos. Revisar generación de feeds y Pages.');
  } catch(error) { aeseAlert_('fuente','No se pudo vigilar la fuente: '+error.message); }
  const handlers=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction());
  if(!handlers.includes('runAESECalendarSync')) {
    ScriptApp.newTrigger('runAESECalendarSync').timeBased().everyMinutes(15).create();
    aeseAlert_('activador','Se ha restaurado el activador de actualización ausente.');
  }
  console.log('AESE vigilancia completada');
}

// A one-shot, real time-trigger verification. It cleans up its own test trigger.
function scheduleAESEAutomaticVerification() {
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='verifyAESEAutomaticSync'))
    ScriptApp.newTrigger('verifyAESEAutomaticSync').timeBased().after(60000).create();
  console.log('AESE verificación automática programada');
}
function verifyAESEAutomaticSync() {
  try { runAESECalendarSync(); }
  finally {
    ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()==='verifyAESEAutomaticSync')
      .forEach(t=>ScriptApp.deleteTrigger(t));
  }
}
