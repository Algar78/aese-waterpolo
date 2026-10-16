/** Clupik notices are a durable, per-match overlay on the last good snapshot.
 * Never discard a notice merely because ActaWP already owns its identity.
 */
const AESE_ALERT_EMAIL = 'algarri1978@gmail.com';
const AESE_NOTICE_PREFIX = 'AESE_NOTICE_';
let AESE_SNAPSHOT_CACHE = null;

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
  if (a<=12 && b<=12 && a!==b) throw Error('Fecha Clupik ambigua; contrastar origen');
  const day=b>12?b:a, month=b>12?a:b;
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
    received_at:message.getDate().toISOString()});
}

function applyClupikNotice_(match) {
  const saved=PropertiesService.getScriptProperties().getProperty(AESE_NOTICE_PREFIX+actaWPIdentity_(match));
  if (!saved) return match;
  const notice=JSON.parse(saved);
  // Retain until reviewed: a stale snapshot must never roll back a newer email.
  return Object.assign({},match,notice,{category:match.category});
}

function reconcileClupikNotice_(message,calendar) {
  const notice=parseClupikNotice_(message), id=actaWPIdentity_(notice);
  const props=PropertiesService.getScriptProperties(), key=AESE_NOTICE_PREFIX+id;
  const saved=props.getProperty(key), old=saved?JSON.parse(saved):null;
  if (old && Date.parse(old.received_at)>Date.parse(notice.received_at)) return 'older';
  const source=(AESE_SNAPSHOT_CACHE || loadActaWPSnapshot_()).find(m=>actaWPIdentity_(m)===id);
  const match=Object.assign({},source||{},notice,{category:source?source.category:notice.category});
  // Persist before Calendar: if Calendar fails, the next ActaWP run repairs it.
  // Unknown venues fail safely before persisting or creating an event.
  actaWPMapsURL_(match.venue);
  props.setProperty(key,JSON.stringify(match));
  const result=reconcileActaWPMatch_(calendar,match);
  Logger.log('Clupik '+id+' '+result);
  return result;
}

function aeseAlert_(key,detail) {
  const props=PropertiesService.getScriptProperties(), now=Date.now();
  const previous=Number(props.getProperty('AESE_ALERT_'+key)||0);
  if(now-previous<6*3600000) return;
  MailApp.sendEmail(AESE_ALERT_EMAIL,'AESE: incidencia de sincronización — '+key,
    detail+'\nSe conservan las identidades y se reintentará automáticamente.\n'+
    'https://script.google.com/home/projects/1gyRPkwFnWnzlyufrKxLL7BpFFHZjLXlNY9lDL_zVzTD_Wpwd5PIIi10A/executions');
  props.setProperty('AESE_ALERT_'+key,String(now));
}

function runAESECalendarSync() {
  const props=PropertiesService.getScriptProperties();
  props.setProperty('AESE_LAST_ATTEMPT',new Date().toISOString());
  const failures=[];
  for (const task of [procesarPartidosAESE,syncActaWPToCalendar]) {
    try { task(); } catch(error) { failures.push(task.name+': '+error.message); }
  }
  if(failures.length) {
    const detail=failures.join('\n');
    props.setProperty('AESE_LAST_ERROR',detail);
    aeseAlert_('ejecucion',detail);
    throw Error(detail);
  }
  props.setProperty('AESE_LAST_SUCCESS',new Date().toISOString());
  props.setProperty('AESE_LAST_ERROR','');
  console.log('AESE ciclo completo OK');
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
  const props=PropertiesService.getScriptProperties(), last=Date.parse(props.getProperty('AESE_LAST_SUCCESS')||'');
  if(!Number.isFinite(last)||Date.now()-last>45*60000) {
    aeseAlert_('retraso','Sin ciclo completo correcto en 45 minutos. Se intenta recuperación.');
    runAESECalendarSync();
  }
  const attempt=fetchActaWPJSON_('https://algar78.github.io/aese-waterpolo/data/actawp_last_attempt.json');
  const attempted=Date.parse(attempt.attempted_at||'');
  if(!attempt.complete || !Number.isFinite(attempted) || Date.now()-attempted>8*3600000)
    aeseAlert_('fuente','Exportación ActaWP incompleta o sin intento en 8 horas: '+JSON.stringify(attempt.errors||[]));
  const handlers=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction());
  if(!handlers.includes('runAESECalendarSync')) {
    ScriptApp.newTrigger('runAESECalendarSync').timeBased().everyMinutes(15).create();
    aeseAlert_('activador','Se ha restaurado el activador de actualización ausente.');
  }
  console.log('AESE vigilancia completada');
}
