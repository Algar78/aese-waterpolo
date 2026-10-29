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

// Una fecha como 05/11/2026 puede ser día/mes o mes/día, y Clupik escribe las dos
// (auditoría del 18/10/2026: 17 avisos día/mes y 67 mes/día, mezclados incluso dentro
// de un mismo torneo; ni las cabeceras ni el HTML distinguen uno de otro). Antes se
// suponía siempre mes/día y, cuando no era así, o fallaba o el partido caía en otro mes.
// Ahora solo se lee si hay una prueba; si no la hay, el aviso no se interpreta.
const AESE_DATE_REF_MAX_MS = 120*86400000;   // un cambio de fecha mayor que esto no se da por válido
const AESE_DATE_REF_GAP_MS = 14*86400000;    // la lectura elegida debe estar al menos 14 días más cerca
const AESE_DATE_WINDOW_PAST_MS = 3*86400000, AESE_DATE_WINDOW_FUTURE_MS = 300*86400000;

function clupikDateReadings_(a,b,year) {
  const valid=(day,month)=>month>=1 && month<=12 && day>=1 && day<=new Date(Date.UTC(year,month,0)).getUTCDate();
  const readings=[];
  if (valid(a,b)) readings.push({day:a,month:b,format:'DD/MM'});
  if (a!==b && valid(b,a)) readings.push({day:b,month:a,format:'MM/DD'});
  return readings;
}

function clupikResolveDate_(text,receivedAtMs,reference,knownTemplate) {
  const [a,b,year]=text.split('/').map(Number);
  const readings=clupikDateReadings_(a,b,year);
  if (!readings.length) throw Error('Fecha Clupik inválida: '+text);
  if (readings.length===1) return Object.assign({how:a===b?'igual':'formato'},readings[0]);
  const noon=r=>Date.UTC(year,r.month-1,r.day,12);
  const label=r=>r.day+'/'+r.month+'/'+year;
  // 1. Lo que ya se sabe del partido (evento del calendario, aviso anterior o paquete oficial).
  const known=reference?Date.parse(String(reference).slice(0,10)+'T12:00:00Z'):NaN;
  if (Number.isFinite(known)) {
    const sorted=readings.map(r=>({r,d:Math.abs(noon(r)-known)})).sort((x,y)=>x.d-y.d);
    if (sorted[0].d<=AESE_DATE_REF_MAX_MS && sorted[1].d-sorted[0].d>=AESE_DATE_REF_GAP_MS) return Object.assign({how:'referencia'},sorted[0].r);
  }
  // 2. Un partido nuevo no puede estar ya jugado ni dentro de casi un año: solo en la plantilla conocida.
  if (knownTemplate) {
    const plausible=readings.filter(r=>noon(r)>=receivedAtMs-AESE_DATE_WINDOW_PAST_MS && noon(r)<=receivedAtMs+AESE_DATE_WINDOW_FUTURE_MS);
    if (plausible.length===1) return Object.assign({how:'ventana'},plausible[0]);
  }
  throw Error('Fecha Clupik ambigua: «'+text+'» puede ser '+label(readings[0])+' o '+label(readings[1])+' y no hay dato oficial que lo decida; contrastar origen');
}

function clupikCategory_(competition,home,away) {
  let category=obtenerCategoriaCorta_(competition).replace(/MIXTE/i,'MIXTO');
  const aeseTeam=/SANTA EUL|\bAESE\b/i.test(home)?home:away;
  if (!/\s[AB]$/.test(category) && /\s([AB])$/.test(aeseTeam)) category+=' '+aeseTeam.match(/\s([AB])$/)[1];
  return category;
}

// options.reference(identity) devuelve la fecha ya conocida del partido (ISO) o null.
function parseClupikNotice_(message,options) {
  const html=message.getBody(), identity=clupikIdentity_(html);
  const clean=text=>decodeClupikHTML_(text.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
  // Leaf blocks avoid capturing nested col-1/row wrappers as a single field.
  const blocks=Array.from(html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
    .matchAll(/<(?:div|td|p|span)\b[^>]*>((?:(?!<(?:div|td|p|span)\b)[\s\S])*?)<\/(?:div|td|p|span)>/gi),m=>clean(m[1])).filter(Boolean);
  const subject=message.getSubject();
  const ti=blocks.findIndex(b=>/^\d{1,2}:\d{2}$/.test(b));
  const di=blocks.findIndex(b=>/^\d{2}\/\d{2}\/\d{4}$/.test(b));
  const competition=blocks.find(b=>/LLIGA CATALANA/i.test(b));
  const stamp={received_at:message.getDate().toISOString(), message_id:message.getId()};
  if (ti<0 && di<0 && /nuevo partido|new match|nou partit|partit nou/i.test(subject)) {
    // Un partido se crea antes de tener fecha (auditoría del 18/10/2026: 87 avisos así, sin hora, fecha ni
    // piscina). No es un error: no hay nada que publicar hasta que llegue el aviso con la fecha.
    const colon=blocks.indexOf(':');
    const home=colon>=2?blocks[colon-2]:'', away=colon>=0?(blocks[colon+1]||''):'';
    if (!competition || !home || !away || !/SANTA EUL|\bAESE\b/i.test(home+' '+away)) throw Error('Equipos o competición Clupik inválidos');
    return Object.assign(identity,{undated:true,category:clupikCategory_(competition,home,away),home_team:home,away_team:away,
      round_name:blocks[colon-1]||'',status:'undated'},stamp);
  }
  if (ti<0 || di<0) throw Error('No se pudieron localizar los datos principales del partido');
  const home=blocks[ti+1], away=blocks[di+1];
  const venue=blocks.slice(di+2).find(b=>/^\d+\s*-\s*\S/.test(b));
  if (!competition || !home || !away || !venue || !/SANTA EUL|\bAESE\b/i.test(home+' '+away)) throw Error('Equipos, competición o piscina Clupik inválidos');
  const year=Number(blocks[di].split('/')[2]);
  const knownTemplate=/id=["']calendar["']/.test(html) && /id=["']clock["']/.test(html);
  const reference=options && options.reference?options.reference(actaWPIdentity_(identity)):null;
  const date=clupikResolveDate_(blocks[di],message.getDate().getTime(),reference,knownTemplate);
  const [hour,minute]=blocks[ti].split(':').map(Number);
  const start=clupikMadridDate_(year,date.month,date.day,hour,minute);
  const cancelled=/cancel|anul|susp[eè]s|suspend/i.test(subject);
  const tentative=/ajorn|aplaz/i.test(subject);
  return Object.assign(identity,{category:clupikCategory_(competition,home,away),home_team:home,away_team:away,venue,
    round_name:blocks.slice(ti+2,di).find(b=>/Jornada/i.test(b))||'',
    start:Utilities.formatDate(start,'Europe/Madrid',"yyyy-MM-dd'T'HH:mm:ssXXX"),
    date_resolution:date.how,
    status:cancelled?'cancelled':tentative?'tentative':'confirmed'},stamp);
}

// Lo que ya se sabe de la fecha de un partido, por orden de fiabilidad: paquete oficial,
// evento del calendario y aviso anterior. Sin nada de eso devuelve null.
function aeseKnownStart_(calendar) {
  const props=PropertiesService.getScriptProperties();
  return id=>{
    try {
      const official=(AESE_SNAPSHOT_CACHE||[]).find(m=>actaWPIdentity_(m)===id);
      if (official && official.start) return official.start;
      const eventId=props.getProperty(ACTAWP_PROPERTY_PREFIX+id);
      const event=eventId?calendar.getEventById(eventId):null;
      if (event) return Utilities.formatDate(event.getStartTime(),'Europe/Madrid',"yyyy-MM-dd'T'HH:mm:ssXXX");
      const saved=props.getProperty(AESE_NOTICE_PREFIX+id);
      if (saved) { const old=JSON.parse(saved); if (old.start) return old.start; }
    } catch (error) { /* sin referencia: la fecha ambigua se tratará como tal */ }
    return null;
  };
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
  try { notice=parseClupikNotice_(message,{reference:aeseKnownStart_(calendar)}); } catch(error) { error.unreadable=true; throw error; }
  if (notice.undated) {
    // Partido nuevo sin fecha: se da por atendido; el aviso con la fecha llegará después.
    Logger.log('Clupik '+actaWPIdentity_(notice)+' partido nuevo sin fecha');
    aeseQueueNewMatch_(notice);
    return 'undated';
  }
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
  // Una sede sin verificar no retrasa el partido: se publica con el nombre de la sede y sin enlace de Maps,
  // y se avisa una vez por sede para que se compruebe la dirección y se añada a data/venues.json.
  if(!actaWPVenueVerified_(match.venue)) aeseAlert_('sede_'+String(match.venue).replace(/[^A-Za-z0-9]+/g,'_').slice(0,60),
    'El partido '+id+' ('+match.home_team+' vs '+match.away_team+') se ha publicado sin enlace de Google Maps porque la piscina «'+match.venue+'» aún no está verificada. '+
    'Hay que comprobar su dirección y añadirla a data/venues.json.',30*86400000,'AESE: piscina nueva sin enlace de Maps','');
  props.setProperty(key,JSON.stringify(match));
  aeseMarkFeedsDirty_(props);       // los .ics de las familias aún no recogen este aviso (aeseRefreshFeeds_)
  const result=reconcileActaWPMatch_(calendar,match);
  Logger.log('Clupik '+id+' '+result);
  return result;
}

// A Clupik notice that cannot be interpreted is never applied (guessing could
// move a real match). It is held for a grace period, with the checkpoint kept so
// it is read again every run in case the calendar learns the official date in
// the meantime; after that it is set aside so it stops holding the window open.
// Holding it is NOT a failure of the run: the person gets one email that names
// it (aeseAlertUnreadable_), not an error every 15 minutes.
// Returns 'new' (first sight, held), 'held' or 'aside'.
const AESE_UNREADABLE_GRACE_MS = 72*3600000;
function aeseTriageUnreadable_(props,message,error,nowMs) {
  const key='AESE_CLUPIK_BAD_'+message.getId(), stored=Number(props.getProperty(key)||0);
  if(!stored) props.setProperty(key,String(nowMs));
  if(stored && nowMs-stored>=AESE_UNREADABLE_GRACE_MS) {
    props.setProperty('AESE_CLUPIK_DONE_'+message.getId(),new Date(nowMs).toISOString());
    return 'aside';
  }
  return stored?'held':'new';
}

// One email per run for every notice not yet reported, however many there are
// (if Clupik changed its template, twenty notices must not mean twenty emails).
// A notice counts as reported only once the email has gone out, so a failed
// delivery is retried on the next run.
function aeseAlertUnreadable_(props,items,nowMs) {
  const pending=items.filter(item=>!Number(props.getProperty('AESE_ALERT_aviso_'+item.id)||0));
  if(!pending.length) return;
  const shown=pending.slice(0,10).map(item=>'- «'+item.subject+'» (recibido el '+item.received.slice(0,10)+'): '+item.reason);
  try {
    MailApp.sendEmail(AESE_ALERT_EMAIL,
      pending.length===1?'AESE: un aviso de Clupik no se ha podido interpretar':'AESE: '+pending.length+' avisos de Clupik no se han podido interpretar',
      'Estos avisos de Clupik no se han podido interpretar y el calendario NO se ha modificado por ellos:\n'+shown.join('\n')+
      (pending.length>shown.length?'\n- … y '+(pending.length-shown.length)+' más':'')+'\n\n'+
      'Pueden contener un cambio real de un partido: ábrelos en Gmail y, si lo es, compruébalo en ActaWP.\n'+
      'El sistema los vuelve a leer durante 72 horas por si el calendario llega a conocer la fecha oficial; pasado ese plazo los aparta para que no frenen el resto de avisos. No habrá más correos sobre ellos.\n'+
      'https://script.google.com/home/projects/1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A/executions');
    pending.forEach(item=>props.setProperty('AESE_ALERT_aviso_'+item.id,String(nowMs)));
  } catch(error) { console.log('Alert delivery failed: '+error.message); }
}

// Un partido nuevo llega a Clupik sin fecha ni piscina: el sistema no puede completarlo solo (la fecha solo está en
// ActaWP). Se avisa por correo, un solo mensaje por tanda, para completarlo a mano. La cola se guarda al leer el aviso
// y se vacía al enviar el correo, de modo que ningún aviso se pierde si la ejecución termina antes de tiempo.
function aeseQueueNewMatch_(notice) {
  const props=PropertiesService.getScriptProperties(), id=actaWPIdentity_(notice);
  if(Number(props.getProperty('AESE_ALERT_nuevo_'+id)||0)) return;
  let queue=[];
  try { queue=JSON.parse(props.getProperty('AESE_NEW_MATCH_QUEUE')||'[]'); } catch(_) {}
  if(!Array.isArray(queue)) queue=[];
  if(queue.some(item=>item.id===id)) return;
  queue.push({id,category:notice.category||'',round:notice.round_name||'',home:notice.home_team||'',away:notice.away_team||''});
  props.setProperty('AESE_NEW_MATCH_QUEUE',JSON.stringify(queue.slice(-100)));
}

function aeseFlushNewMatches_() {
  const props=PropertiesService.getScriptProperties();
  let queue=[];
  try { queue=JSON.parse(props.getProperty('AESE_NEW_MATCH_QUEUE')||'[]'); } catch(_) {}
  if(!Array.isArray(queue) || !queue.length) return;
  const shown=queue.slice(0,30).map(item=>'- '+(item.category||'Categoría sin identificar')+(item.round?' · '+item.round:'')+': '+item.home+' vs '+item.away);
  try {
    MailApp.sendEmail(AESE_ALERT_EMAIL,
      queue.length===1?'AESE: partido nuevo en Clupik, sin fecha ni piscina':'AESE: '+queue.length+' partidos nuevos en Clupik, sin fecha ni piscina',
      shown.join('\n')+(queue.length>shown.length?'\n- … y '+(queue.length-shown.length)+' más':'')+'\n\n'+
      'Clupik avisa de estos partidos sin fecha ni piscina; la fecha solo está en la página del partido en ActaWP. '+
      'No aparecerán en el calendario hasta que se completen: revisar y añadirlos a mano si hace falta.');
    queue.forEach(item=>props.setProperty('AESE_ALERT_nuevo_'+item.id,String(Date.now())));
    props.deleteProperty('AESE_NEW_MATCH_QUEUE');
  } catch(error) { console.log('Alert delivery failed: '+error.message); }
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

// ---- Aviso inmediato a los .ics de las familias ---------------------------
// El Google Calendar se actualiza en este mismo ciclo, pero los .ics los regenera el workflow «Clupik
// overlay» de GitHub, y GitHub ejecuta los workflows programados solo cada pocas horas (el 29/10 hubo
// tres pasadas entre las 22:53 y las 09:24). Cuando se guarda un aviso nuevo se marca «pendiente» y, si
// existe un token de GitHub en las propiedades del script, se pide al workflow que se ejecute ya
// (workflow_dispatch, la API oficial). Es un acelerador opcional y nunca un requisito:
//  - sin token no hace nada y el workflow programado sigue haciendo su trabajo;
//  - un fallo aquí jamás detiene ni hace fallar el ciclo del Calendar;
//  - mientras no se consiga avisar, la marca se conserva y se reintenta en cada ciclo;
//  - el token no sale nunca en registros ni en correos.
// Token: «fine-grained», solo este repositorio, permiso «Actions: Read and write», en la propiedad
// AESE_GITHUB_TOKEN (docs/dispatch-github.md).
const AESE_FEEDS_DIRTY = 'AESE_FEEDS_DIRTY';
const AESE_GITHUB_TOKEN = 'AESE_GITHUB_TOKEN';
const AESE_DISPATCH_URL = 'https://api.github.com/repos/Algar78/aese-waterpolo/actions/workflows/clupik-overlay.yml/dispatches';
const AESE_DISPATCH_TRANSIENT_MS = 2*3600000;     // un fallo pasajero (red, 5xx) no avisa hasta durar más de 2 h
const AESE_TOKEN_WARNING_MS = 14*86400000;        // aviso previo a la caducidad del token

function aeseMarkFeedsDirty_(props) {
  // Se conserva la marca más antigua: mide cuánto lleva esperando el primer aviso sin entregar.
  if(!Number(props.getProperty(AESE_FEEDS_DIRTY)||0)) props.setProperty(AESE_FEEDS_DIRTY,String(Date.now()));
}

function aeseTokenExpiry_(response) {
  // GitHub informa de la caducidad de los tokens «fine-grained» en una cabecera: «2026-11-30 12:00:00 UTC».
  try {
    const headers=response.getAllHeaders ? response.getAllHeaders() : {};
    const name=Object.keys(headers).find(k=>k.toLowerCase()==='github-authentication-token-expiration');
    if(!name) return null;
    const stamp=Date.parse(String(headers[name]).trim().replace(' UTC','Z').replace(' ','T'));
    return Number.isFinite(stamp)?stamp:null;
  } catch(_) { return null; }
}

// Devuelve 'clean' (nada pendiente), 'no-token', 'dispatched' o 'failed'. Nunca lanza.
function aeseRefreshFeeds_() {
  try {
    const props=PropertiesService.getScriptProperties(), now=Date.now();
    const dirty=Number(props.getProperty(AESE_FEEDS_DIRTY)||0);
    if(!dirty) return 'clean';
    const token=props.getProperty(AESE_GITHUB_TOKEN);
    if(!token) { props.deleteProperty(AESE_FEEDS_DIRTY); return 'no-token'; }
    const tail='\nEl Google Calendar no se ve afectado. Los .ics de las familias se seguirán actualizando con el ciclo programado de GitHub (cada pocas horas) '+
      'o ejecutando a mano «Clupik overlay» en https://github.com/Algar78/aese-waterpolo/actions/workflows/clupik-overlay.yml.';
    let response, code;
    try {
      response=UrlFetchApp.fetch(AESE_DISPATCH_URL,{method:'post',contentType:'application/json',payload:JSON.stringify({ref:'main'}),muteHttpExceptions:true,
        headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
      code=response.getResponseCode();
    } catch(error) { code=0; }
    if(code===204) {
      if(Number(props.getProperty(AESE_FEEDS_DIRTY)||0)===dirty) props.deleteProperty(AESE_FEEDS_DIRTY);
      props.setProperty('AESE_FEEDS_LAST_DISPATCH',new Date(now).toISOString());
      Logger.log('Familias: aviso enviado a GitHub');
      const expiry=aeseTokenExpiry_(response);
      if(expiry!==null && expiry-now<AESE_TOKEN_WARNING_MS)
        aeseAlert_('github_token_caduca','El token de GitHub que avisa a los .ics de las familias '+(expiry<=now?'ha caducado':'caduca el '+
          Utilities.formatDate(new Date(expiry),'Europe/Madrid','dd/MM/yyyy'))+'. Hay que crear otro igual y sustituirlo en la propiedad AESE_GITHUB_TOKEN '+
          '(docs/dispatch-github.md). Mientras tanto los .ics se actualizan solo con el ciclo programado de GitHub.',3*86400000,'AESE: el token de GitHub está a punto de caducar','');
      return 'dispatched';
    }
    // 401/403/404/422: el token no vale (caducado, revocado, sin permiso) o el workflow no existe. No se arregla solo.
    // Red, 429 y 5xx suelen ser pasajeros: solo avisan si llevan más de 2 h sin conseguirse.
    const persistent=code===401||code===403||code===404||code===422;
    Logger.log('Familias: GitHub respondió '+code+'; se reintentará');
    if(persistent) aeseAlert_('github_aviso','GitHub rechaza el aviso a los .ics de las familias (respuesta '+code+'): el token ha caducado, ha sido revocado o no tiene permiso «Actions: Read and write» sobre el repositorio.',24*3600000,
      'AESE: no se puede avisar a GitHub de los cambios de Clupik',tail);
    else if(now-dirty>AESE_DISPATCH_TRANSIENT_MS) aeseAlert_('github_aviso','Llevo más de 2 horas sin poder avisar a GitHub de un cambio de Clupik (respuesta '+(code||'sin conexión')+').',24*3600000,
      'AESE: GitHub no responde a los avisos de Clupik',tail);
    return 'failed';
  } catch(error) {
    console.log('Familias: aviso a GitHub no completado: '+error.message);
    return 'failed';
  }
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
  // «automated_attempts»: false declara que nadie intenta leer ActaWP por sistema (lectura automática sin
  // autorización); entonces la antigüedad del último intento no es un fallo y solo vigila la frescura.
  // Solo un false explícito lo apaga: una política ausente o inservible mantiene la vigilancia completa.
  const automatedAttempts=p.automated_attempts!==false;
  if(!(fresh>0 && outdated>fresh)) return {freshHours:AESE_FRESH_HOURS,outdatedHours:AESE_OUTDATED_HOURS,reminderMs:AESE_FRESHNESS_REMINDER_MS,automatedAttempts:true};
  return {freshHours:fresh,outdatedHours:outdated,reminderMs:(reminder>0?reminder:outdated)*3600000,automatedAttempts};
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
  const lastTry=(f.policy.automatedAttempts && failures>0 && errors)?' El último intento de lectura falló ('+errors+'; '+failures+' seguidos).':'';
  if(f.state==='outdated') {
    aeseAlert_('frescura_obsoleta','Los datos oficiales de ActaWP no se actualizan desde hace '+days+' días '+
      '(última lectura completa: '+when+', hora de Madrid).'+lastTry+'\n'+
      'El calendario sigue funcionando con los avisos oficiales de Clupik, pero un cambio que no llegue por correo no se reflejará.\n'+
      'Para confirmarlo contra la fuente oficial, sube las páginas guardadas: https://github.com/Algar78/aese-waterpolo/tree/main/data/manual',
      f.policy.reminderMs,'AESE: datos oficiales sin actualizar desde hace '+days+' días','');
  } else if(f.state==='unknown') {
    aeseAlert_('frescura_desconocida','No se puede saber cuándo se leyeron por última vez los datos oficiales: el paquete publicado no incluye last_complete_export_at.',
      24*3600000,'AESE: no se puede comprobar la frescura de los datos','');
  } else if(f.state==='fresh' && previous==='outdated') {
    aeseAlert_('frescura_recuperada','Los datos oficiales de ActaWP vuelven a estar al día (última lectura completa: '+when+').',
      3600000,'AESE: datos oficiales de nuevo al día','');
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
  // Aunque este ciclo haya fallado a medias, los avisos ya guardados no esperan al siguiente.
  aeseRefreshFeeds_();
  aeseFlushNewMatches_();
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
  // No exigir una vuelta completa cada seis horas: la lectura oficial es manual.
  // La antigüedad del último snapshot válido se vigila con aeseCheckFreshness_.
  try {
  const attempt=fetchActaWPJSON_('https://algar78.github.io/aese-waterpolo/data/actawp_last_attempt.json');
  const attempted=Date.parse(attempt.attempted_at||'');
  const bundle=fetchActaWPJSON_(ACTAWP_BUNDLE_URL);
  // Sin lectura automática de ActaWP no hay intentos que vigilar (data/freshness_policy.json, automated_attempts):
  // el último registro puede tener días y no es un fallo. La edad de los datos la vigila aeseCheckFreshness_.
  if(aeseFreshnessPolicy_(bundle.status || {}).automatedAttempts && (!attempt.complete || !Number.isFinite(attempted) || Date.now()-attempted>8*3600000))
    aeseAlert_('fuente','Exportación ActaWP incompleta o sin intento en 8 horas: '+JSON.stringify(attempt.errors||[]),24*3600000);
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
