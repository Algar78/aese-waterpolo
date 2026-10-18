import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const fixtures=['banyoles','mediterrani'].map(n=>read('tests/fixtures/'+n+'.html'));
const snapshot=JSON.parse(read('data/actawp_matches.json'));
const venues=JSON.parse(read('data/venues.json'));
function harness(){
  const properties=new Map(),events=[],mail=[],logs=[];
  const props={deleteProperty:k=>properties.delete(k),getProperty:k=>properties.get(k)||null,getProperties:()=>Object.fromEntries(properties),deleteProperty:k=>properties.delete(k),setProperty:(k,v)=>properties.set(k,v)};
  const calendar={getEvents:()=>events,getEventById:id=>events.find(e=>e.getId()===id),createEvent:(title,start,end,opts)=>{
    const v={title,start,end,description:opts.description,location:opts.location};
    const e={getId:()=>String(events.indexOf(e)),getTitle:()=>v.title,getStartTime:()=>v.start,getEndTime:()=>v.end,getDescription:()=>v.description,getLocation:()=>v.location,
      setTitle:x=>v.title=x,setTime:(s,e)=>{v.start=s;v.end=e},setDescription:x=>v.description=x,setLocation:x=>v.location=x};events.push(e);return e;
  }};
  const formatDate=(d,z,pattern)=>{
    const p=new Intl.DateTimeFormat('sv-SE',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(d).replace(' ','T');
    if(pattern==='HH:mm')return p.slice(11,16);
    if(pattern.endsWith('XXX')){const offset=(Date.parse(p+'Z')-d.getTime())/60000;return p+(offset===120?'+02:00':'+01:00');}
    return pattern.endsWith('HH:mm')?p.slice(0,16):p;
  };
  const c=vm.createContext({Date,console:{log:x=>logs.push(x)},Logger:{log:x=>logs.push(x)},Utilities:{formatDate},
    PropertiesService:{getScriptProperties:()=>props},CalendarApp:{getCalendarById:()=>calendar},
    MailApp:{sendEmail:(...x)=>mail.push(x)},LockService:{getScriptLock:()=>({tryLock(){return true},waitLock(){},releaseLock(){}})},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({schema_version:1,matches:snapshot,status:JSON.parse(read('data/actawp_export_status.json')),venues})})}});
  for(const file of ['calendar_offline_bundle.gs','actawp_calendar_sync.gs','clupik_calendar_sync.gs','calendar_reliability.gs','clupik_coverage_audit.gs'])vm.runInContext(read(file),c);
  vm.runInContext('ACTAWP_VENUES = '+JSON.stringify(venues),c);
  const msg=(i=0,subject='Modificado un partido de Jornada 1',at='2026-10-16T06:33:09Z',html=fixtures[i])=>({getBody:()=>html,getSubject:()=>subject,getDate:()=>new Date(at),getId:()=>at,getFrom:()=> 'FCN <no-reply@clupik.com>'});
  return {c,events,properties,calendar,msg,mail,logs};
}
test('dos avisos reales: enlaces redirigidos, equipos, categoría y UTC correctos',()=>{
  const h=harness();
  const a=h.c.parseClupikNotice_(h.msg()),b=h.c.parseClupikNotice_(h.msg(1));
  assert.equal(a.match_id,145574486);assert.equal(a.start,'2026-10-24T13:00:00+02:00');assert.equal(a.home_team,'C.N. BANYOLES');
  assert.equal(b.match_id,145608988);assert.equal(b.start,'2026-11-22T09:00:00+01:00');assert.match(b.category,/MIXTO B/);
  assert.equal(Date.parse(a.start),Date.parse('2026-10-24T11:00:00Z'));
  assert.equal(Date.parse(b.start),Date.parse('2026-11-22T08:00:00Z'));
  assert.ok(!a.url.includes('track'));
});
test('nuevo partido, repetición, reprogramación y snapshot antiguo conservan un solo ID',()=>{
  const h=harness(),m=h.msg();
  assert.equal(h.c.procesarMensajeAESE_(m,h.calendar),'created');const id=h.events[0].getId();
  assert.equal(h.c.procesarMensajeAESE_(m,h.calendar),'unchanged');
  const changed=h.msg(0,'Modificado un partido','2026-10-17T10:00:00Z',fixtures[0].replace('13:00','14:00'));
  assert.equal(h.c.procesarMensajeAESE_(changed,h.calendar),'updated');
  h.c.syncActaWPToCalendar();assert.equal(h.events.find(e=>e.getId()===id).getStartTime().toISOString(),'2026-10-24T12:00:00.000Z');
  assert.equal(h.c.procesarMensajeAESE_(m,h.calendar),'older');
  assert.equal(h.events.filter(e=>e.getDescription().includes('1339808:145574486')).length,1);
});
test('cancelación y aplazamiento explícitos no eliminan ni duplican',()=>{
  const h=harness();h.c.procesarMensajeAESE_(h.msg(),h.calendar);
  h.c.procesarMensajeAESE_(h.msg(0,'Partido cancelado','2026-10-17T10:00:00Z'),h.calendar);
  assert.match(h.events[0].getTitle(),/CANCELADO/);
  h.c.procesarMensajeAESE_(h.msg(0,'Partido aplazado','2026-10-18T10:00:00Z'),h.calendar);
  assert.match(h.events[0].getTitle(),/APLAZADO/);assert.equal(h.events.length,1);
});
test('la fuente debe confirmar un aviso antes de poder avanzar sin otro correo',()=>{
  const h=harness();h.c.procesarMensajeAESE_(h.msg(),h.calendar);
  const original=snapshot.find(m=>m.match_id===145574486);
  const notice=JSON.parse(h.properties.get('AESE_NOTICE_1339808:145574486'));
  const stale={...original,start:'2026-10-03T17:00:00+02:00'};
  vm.runInContext("ACTAWP_SNAPSHOT_TIME='2026-10-17T10:00:00Z'",h.c);
  assert.equal(h.c.applyClupikNotice_(stale).start,notice.start);
  h.c.applyClupikNotice_({...original,...notice});
  vm.runInContext("ACTAWP_SNAPSHOT_TIME='2026-10-18T10:00:00Z'",h.c);
  assert.equal(h.c.applyClupikNotice_({...original,start:'2026-10-25T14:00:00+01:00'}).start,'2026-10-25T14:00:00+01:00');
});
test('duplicados exactos bloquean escrituras y conservan evidencia',()=>{
  const h=harness();h.c.procesarMensajeAESE_(h.msg(),h.calendar);h.events.push(h.events[0]);
  assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(),h.calendar),/duplicada/);
});
test('partido nuevo ausente del snapshot se crea una vez y se reprograma por identidad',()=>{
  const h=harness(),html=fixtures[0].replaceAll('145574486','199999999');
  const first=h.msg(0,'Nuevo partido','2026-10-16T10:00:00Z',html);
  assert.equal(h.c.procesarMensajeAESE_(first,h.calendar),'created');
  h.c.procesarMensajeAESE_(first,h.calendar);
  h.c.procesarMensajeAESE_(h.msg(0,'Modificado un partido','2026-10-17T10:00:00Z',html.replace('13:00','15:00')),h.calendar);
  assert.equal(h.events.length,1);assert.equal(h.events[0].getStartTime().toISOString(),'2026-10-24T13:00:00.000Z');
});
test('identidad estricta y fecha ambigua/imposible no crean eventos',()=>{
  const h=harness();
  const ambiguous=fixtures[0].replace('id="calendar"','id="unknown"').replace('10/24/2026','04/09/2027');
  assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(0,'Partido',undefined,ambiguous),h.calendar),/ambigua/);
  assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(0,'Partido',undefined,fixtures[0].replace('10/24/2026','02/30/2027')),h.calendar),/inválida/);
  assert.equal(h.c.parseClupikNotice_(h.msg(0,'Partido',undefined,fixtures[0].replace('10/24/2026','04/09/2027'))).start,'2027-04-09T13:00:00+02:00');
  assert.throws(()=>h.c.clupikIdentity_('<a href="https://evil.test/tournament/1/match/2/results">x</a>'),/Identidad/);
  assert.equal(h.events.length,0);
});
test('horario Madrid independiente del proceso: invierno, verano y cambios estacionales',()=>{
  const h=harness();
  assert.equal(h.c.clupikMadridDate_(2026,11,22,9,0).toISOString(),'2026-11-22T08:00:00.000Z');
  for(const args of [[2026,3,29,2,30],[2026,10,25,2,30],[2026,2,30,12,0]])assert.throws(()=>h.c.clupikMadridDate_(...args),/inválida|ambigua/);
});
test('fallos conservan checkpoint; ciclo continúa ActaWP y alerta sin marcar éxito',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  h.properties.set('AESE_CLUPIK_DONE_old','2020-01-01T00:00:00Z');
  h.c.GmailApp={search:()=>[{getMessages:()=>[h.msg(0,'Partido',new Date(Date.now()-1000).toISOString(),'<b>roto</b>')]}]};
  let synced=false;h.c.syncActaWPToCalendar=()=>{synced=true;return {status:'complete'}};
  assert.throws(()=>h.c.runAESECalendarSync(),/Clupik incompleto/);
  assert.equal(synced,true);assert.equal(h.mail.length,1);
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');assert.equal(h.properties.has('AESE_LAST_SUCCESS'),false);
  assert.equal(h.properties.has('AESE_CLUPIK_DONE_old'),false);
});
test('alertas se agrupan durante seis horas; recuperación del trigger ausente',()=>{
  const h=harness();h.c.aeseAlert_('test','fallo');h.c.aeseAlert_('test','fallo');assert.equal(h.mail.length,1);
  let installed=false, recovered=false;
  h.properties.set('AESE_LAST_SUCCESS',new Date().toISOString());
  h.c.fetchActaWPJSON_=()=>({complete:true,attempted_at:new Date().toISOString()});
  h.c.ScriptApp={getProjectTriggers:()=>[],newTrigger:()=>({timeBased(){return this},everyMinutes(){return this},create(){installed=true}})};
  h.c.checkAESECalendarHealth();assert.equal(installed,true);
  h.properties.set('AESE_LAST_SUCCESS','2020-01-01');h.c.runAESECalendarSync=()=>recovered=true;h.c.checkAESECalendarHealth();assert.equal(recovered,true);
});
test('exportación correcta con paquete retrasado alerta sobre publicación',()=>{
  const h=harness();h.properties.set('ACTAWP_LAST_SYNC',new Date().toISOString());h.properties.set('AESE_LAST_SUCCESS',new Date().toISOString());
  const recent=new Date(Date.now()-3600000).toISOString();
  h.c.fetchActaWPJSON_=url=>url.endsWith('actawp_last_attempt.json')?{complete:true,attempted_at:recent}:{status:{attempted_at:'2020-01-01T00:00:00Z'}};
  h.c.ScriptApp={getProjectTriggers:()=>[{getHandlerFunction:()=> 'runAESECalendarSync'}]};
  h.c.checkAESECalendarHealth();
  // The stub bundle has no last_complete_export_at, so a freshness notice may accompany it.
  assert.equal(h.mail.filter(m=>/publicacion/.test(m[1])).length,1);
});

test('Clupik funciona sin ninguna petición remota y repite sin duplicar',()=>{
  const h=harness();
  const message=h.msg(0,'Modificado un partido',new Date(Date.now()-10000).toISOString());
  h.c.GmailApp={search:()=>[{getMessages:()=>[message]}]};
  h.c.UrlFetchApp.fetch=()=>{throw Error('remote down')};
  assert.equal(h.c.procesarPartidosAESE().status,'complete');
  assert.equal(h.c.procesarPartidosAESE().status,'complete');
  assert.equal(h.events.length,1);
});

test('bloqueo ocupado no actualiza el latido de éxito',()=>{
  const h=harness();
  h.c.LockService.getScriptLock=()=>({tryLock:()=>false});
  assert.throws(()=>h.c.runAESECalendarSync(),/locked/);
  assert.equal(h.properties.has('AESE_CLUPIK_LAST_SUCCESS'),false);
  assert.equal(h.properties.has('AESE_ACTAWP_LAST_SUCCESS'),false);
});

test('lote de correo limitado reanuda y no adelanta checkpoint',()=>{
  const h=harness();
  const messages=Array.from({length:25},(_,i)=>h.msg(0,'Partido',new Date(Date.now()-100000+i*1000).toISOString()));
  h.c.GmailApp={search:()=>[{getMessages:()=>messages}]};
  assert.equal(h.c.procesarPartidosAESE().status,'pending');
  assert.equal(h.properties.has('ULTIMA_EJECUCION'),false);
  assert.equal(h.c.procesarPartidosAESE().status,'pending');
  assert.equal(h.c.procesarPartidosAESE().status,'complete');
  assert.equal(h.events.length,1);
});

test('error de correo de alerta no impide conciliación secundaria',()=>{
  const h=harness();let secondary=false;
  h.c.MailApp.sendEmail=()=>{throw Error('mail quota')};
  h.c.procesarPartidosAESE=()=>{throw Error('primary down')};
  h.c.syncActaWPToCalendar=()=>{secondary=true;return {status:'complete'}};
  assert.throws(()=>h.c.runAESECalendarSync(),/primary down/);
  assert.equal(secondary,true);
});

test('avisos con igual fecha se ordenan por ID sin perder una modificación',()=>{
  const h=harness(),first=h.msg(),second=h.msg(0,'Modificado un partido',undefined,fixtures[0].replace('13:00','14:00'));
  first.getId=()=> 'a';second.getId=()=> 'b';
  h.c.procesarMensajeAESE_(first,h.calendar);
  h.c.procesarMensajeAESE_(second,h.calendar);
  assert.equal(h.events[0].getStartTime().toISOString(),'2026-10-24T12:00:00.000Z');
  assert.equal(h.c.procesarMensajeAESE_(first,h.calendar),'older');
});

test('replay de aviso ya confirmado no revierte un avance posterior de ActaWP',()=>{
  const h=harness(),m=h.msg();h.c.procesarMensajeAESE_(m,h.calendar);
  const key='AESE_NOTICE_1339808:145574486',notice=JSON.parse(h.properties.get(key));
  notice.acknowledged_snapshot='2026-10-17T12:00:00Z';h.properties.set(key,JSON.stringify(notice));
  assert.equal(h.c.procesarMensajeAESE_(m,h.calendar),'acknowledged');
});

// ---- Frescura de los datos oficiales --------------------------------------
const hoursAgo=h=>new Date(Date.now()-h*3600000).toISOString();
function health(h,{lastComplete,attempt={},published=hoursAgo(0.1),policy}={}){
  h.properties.set('AESE_LAST_SUCCESS',new Date().toISOString());h.properties.set('ACTAWP_LAST_SYNC',new Date().toISOString());
  h.c.fetchActaWPJSON_=url=>url.endsWith('actawp_last_attempt.json')
    ?{complete:false,attempted_at:hoursAgo(1),errors:['x'],...attempt}
    :{status:{attempted_at:published,last_complete_export_at:lastComplete,freshness_policy:policy}};
  h.c.ScriptApp={getProjectTriggers:()=>[{getHandlerFunction:()=> 'runAESECalendarSync'}]};
  h.c.checkAESECalendarHealth();
}
test('frescura: umbrales fresh/stale/outdated/unknown',()=>{
  const h=harness(),now=Date.parse('2026-10-18T10:00:00Z'),at=hours=>new Date(now-hours*3600000).toISOString();
  const state=v=>h.c.aeseFreshness_({last_complete_export_at:v},now).state;
  assert.equal(state(at(1)),'fresh');assert.equal(state(at(12)),'fresh');
  assert.equal(state(at(12.1)),'stale');assert.equal(state(at(48)),'stale');
  assert.equal(state(at(48.1)),'outdated');assert.equal(state(at(24*8)),'outdated');
  for(const bad of [undefined,'','no es fecha',null])assert.equal(state(bad),'unknown');
  assert.equal(h.c.aeseFreshness_({},now).ageHours,null);
});
test('frescura: datos oficiales de ocho días avisan una vez, con edad y causa, y se repiten solo cada 48 h',()=>{
  const h=harness();
  const attempt={error_classes:['rate_limited'],consecutive_failures:28};
  health(h,{lastComplete:hoursAgo(24*7.7),attempt});health(h,{lastComplete:hoursAgo(24*7.7),attempt});health(h,{lastComplete:hoursAgo(24*7.7),attempt});
  const mails=h.mail.filter(m=>/sin actualizar/.test(m[1]));
  assert.equal(mails.length,1);
  assert.match(mails[0][1],/7\.7 días/);assert.match(mails[0][2],/rate_limited/);assert.match(mails[0][2],/28/);assert.match(mails[0][2],/Clupik/);
  assert.equal(h.properties.get('AESE_FRESHNESS_STATE'),'outdated');
  // 49 h later the reminder is allowed again.
  h.properties.set('AESE_ALERT_frescura_obsoleta',String(Date.now()-49*3600000));
  health(h,{lastComplete:hoursAgo(24*7.7),attempt});
  assert.equal(h.mail.filter(m=>/sin actualizar/.test(m[1])).length,2);
});
test('frescura: una vuelta perdida (stale) no genera correo; el estado queda registrado',()=>{
  const h=harness();health(h,{lastComplete:hoursAgo(20),attempt:{complete:true}});
  assert.equal(h.mail.length,0);assert.equal(h.properties.get('AESE_FRESHNESS_STATE'),'stale');
  assert.ok(Number(h.properties.get('AESE_FRESHNESS_AGE_HOURS'))>19);
});
test('frescura: la política publicada en el paquete sustituye a los umbrales por defecto',()=>{
  const h=harness(),now=Date.parse('2026-10-18T10:00:00Z'),at=hours=>new Date(now-hours*3600000).toISOString();
  const policy={fresh_hours:192,outdated_hours:360,reminder_hours:168};
  const state=(v,p=policy)=>h.c.aeseFreshness_({last_complete_export_at:v,freshness_policy:p},now).state;
  assert.equal(state(at(100)),'fresh');assert.equal(state(at(192)),'fresh');
  assert.equal(state(at(193)),'stale');assert.equal(state(at(360)),'stale');assert.equal(state(at(361)),'outdated');
  // Una política inservible nunca relaja la vigilancia: se vuelve a los valores por defecto (60 h > 48 h).
  for(const bad of [{fresh_hours:100,outdated_hours:50},{fresh_hours:'x'},{},null,{fresh_hours:-1,outdated_hours:10}])
    assert.equal(state(at(60),bad),'outdated');
  assert.equal(h.c.aeseFreshness_({last_complete_export_at:at(1),freshness_policy:policy},now).policy.reminderMs,168*3600000);
  assert.equal(h.c.aeseFreshness_({last_complete_export_at:at(1),freshness_policy:{fresh_hours:10,outdated_hours:20}},now).policy.reminderMs,20*3600000);
});
test('frescura con lectura semanal: 5 días no avisa; 16 días avisan una vez y recuerdan a los 7 días',()=>{
  const h=harness(),policy={fresh_hours:192,outdated_hours:360,reminder_hours:168};
  const alerts=()=>h.mail.filter(m=>/sin actualizar/.test(m[1])).length;
  health(h,{lastComplete:hoursAgo(24*5),policy});
  assert.equal(alerts(),0);
  health(h,{lastComplete:hoursAgo(24*16),policy});health(h,{lastComplete:hoursAgo(24*16),policy});
  assert.equal(alerts(),1);
  assert.match(String(h.mail.find(m=>/sin actualizar/.test(m[1]))[2]),/data\/manual/);   // dice qué hacer
  h.properties.set('AESE_ALERT_frescura_obsoleta',String(Date.now()-6*24*3600000));
  health(h,{lastComplete:hoursAgo(24*16),policy});
  assert.equal(alerts(),1);                                                               // aún no toca recordar
  h.properties.set('AESE_ALERT_frescura_obsoleta',String(Date.now()-8*24*3600000));
  health(h,{lastComplete:hoursAgo(24*16),policy});
  assert.equal(alerts(),2);
});
test('frescura: la recuperación se notifica una sola vez',()=>{
  const h=harness();
  health(h,{lastComplete:hoursAgo(100)});
  health(h,{lastComplete:hoursAgo(1),attempt:{complete:true}});health(h,{lastComplete:hoursAgo(1),attempt:{complete:true}});
  assert.equal(h.mail.filter(m=>/de nuevo al día/.test(m[1])).length,1);
  assert.equal(h.properties.get('AESE_FRESHNESS_STATE'),'fresh');
});
test('frescura: paquete sin last_complete_export_at se reporta como desconocido, no como correcto',()=>{
  const h=harness();health(h,{lastComplete:undefined});
  assert.equal(h.mail.filter(m=>/no se puede comprobar/.test(m[1])).length,1);
  assert.equal(h.properties.get('AESE_FRESHNESS_STATE'),'unknown');
});
test('el instante del snapshot es el de la última lectura completa, no el del último intento',()=>{
  const h=harness();
  h.c.fetchActaWPJSON_=()=>({schema_version:1,matches:snapshot,venues,
    status:{...JSON.parse(read('data/actawp_export_status.json')),attempted_at:'2026-10-18T04:00:00Z',last_complete_export_at:'2026-10-10T16:25:53Z'}});
  h.c.loadActaWPSnapshot_();
  assert.equal(vm.runInContext('ACTAWP_SNAPSHOT_TIME',h.c),'2026-10-10T16:25:53Z');
});
test('el estado publicado del repositorio declara cuándo se leyó ActaWP por última vez',()=>{
  const status=JSON.parse(read('data/actawp_export_status.json'));
  assert.ok(Number.isFinite(Date.parse(status.last_complete_export_at)),'falta last_complete_export_at');
  const bundle=JSON.parse(read('calendars/general-calendar.json'));
  assert.equal(bundle.status.last_complete_export_at,status.last_complete_export_at);
});

// ---- Escenario pedido en la auditoría: ActaWP falla, pero llega un cambio oficial de Clupik ----
test('ActaWP responde 429 y llega un cambio oficial de Clupik: se aplica con el mismo ID y no se revierte',()=>{
  const h=harness();
  // Calendario completo previo: 80 eventos, uno por identidad.
  for(let i=0;i<20;i++){ if(h.c.syncActaWPToCalendar().status==='complete')break; }
  assert.equal(h.events.length,80);
  const target=h.events.find(e=>e.getDescription().includes('ACTAWP_MATCH_ID:1339808:145574486'));
  const id=target.getId(), before=target.getStartTime().toISOString();
  assert.equal(before,'2026-10-24T11:00:00.000Z'); // 13:00 CEST

  // ActaWP deja de responder (429 con espera larga); Gmail trae el aviso oficial 14:30.
  h.c.UrlFetchApp.fetch=()=>({getResponseCode:()=>429,getAllHeaders:()=>({'Retry-After':'600'}),getContentText:()=> 'Too Many Requests'});
  const notice=h.msg(0,'Modificado un partido de Jornada 1',new Date(Date.now()-10000).toISOString(),fixtures[0].replace('13:00','14:30'));
  h.c.GmailApp={search:()=>[{getMessages:()=>[notice]}]};

  h.c.runAESECalendarSync();  // no lanza: Clupik es la vía primaria y está sana
  const after=h.events.find(e=>e.getId()===id);
  assert.equal(h.events.length,80);                                     // sin duplicados ni desapariciones
  assert.equal(after.getStartTime().toISOString(),'2026-10-24T12:30:00.000Z'); // 14:30 CEST, mismo evento
  assert.match(after.getTitle(),/^14:30 /);
  assert.ok(h.properties.get('AESE_CLUPIK_LAST_SUCCESS'));
  assert.match(h.properties.get('AESE_ACTAWP_LAST_ERROR'),/429/);       // el fallo de la fuente queda a la vista
  assert.match(h.properties.get('AESE_LAST_ERROR'),/ActaWP/);

  // Repetir con ActaWP aún caído no revierte ni duplica.
  h.c.runAESECalendarSync();
  assert.equal(h.events.length,80);
  assert.equal(h.events.find(e=>e.getId()===id).getStartTime().toISOString(),'2026-10-24T12:30:00.000Z');

  // Vuelve ActaWP, pero con la página antigua (13:00): el aviso oficial prevalece y se pide revisión.
  h.c.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({schema_version:1,matches:snapshot,status:JSON.parse(read('data/actawp_export_status.json')),venues})});
  h.properties.delete('AESE_HTTP_WAIT_'+encodeURIComponent('https://algar78.github.io/aese-waterpolo/calendars/general-calendar.json'));
  for(let i=0;i<20;i++){ if(h.c.syncActaWPToCalendar().status==='complete')break; }
  assert.equal(h.events.length,80);
  assert.equal(h.events.find(e=>e.getId()===id).getStartTime().toISOString(),'2026-10-24T12:30:00.000Z');
});

test('auditoría de cobertura de Clupik: agrupa asuntos, separa lo que no se procesa y no escribe nada',()=>{
  const h=harness();
  const at=(d)=>'2026-10-'+d+'T08:00:00Z';
  const ok1=h.msg(0,'Modificado un partido de Jornada 1',at('10')), ok2=h.msg(0,'Modificado un partido de Jornada 2',at('12'),fixtures[0].replace('13:00','14:00'));
  const nuevo=h.msg(1,'Nuevo partido',at('14')), cancelado=h.msg(0,'Partido cancelado',at('15'));
  const info=h.msg(0,'Bienvenido a Clupik',at('11'),'<p>Hola</p>');                       // asunto que el sistema ignora
  const roto=h.msg(0,'Modificado un partido de Jornada 3',at('13'),'<div>sin datos</div>'); // se procesaría, pero no se entiende
  const ajeno=Object.assign(h.msg(0,'Modificado un partido',at('16')),{getFrom:()=> 'otro@example.com'});
  const mails=[ok1,info,ok2,roto,nuevo,cancelado,ajeno];
  const queries=[];
  h.c.GmailApp={search:(q,o)=>{queries.push(q);return o===0?[{getMessages:()=>mails}]:[]}};
  const before={props:JSON.stringify(h.properties),events:h.events.length,mail:h.mail.length};
  const r=h.c.aeseClupikCoverage_();
  assert.equal(r.total,6);                                   // el remitente ajeno no cuenta
  assert.match(queries[0],/from:no-reply@clupik\.com/);
  const g=Object.fromEntries(r.groups.map(x=>[x.pattern,x]));
  assert.equal(g['modificado un partido de jornada #'].count,3);
  assert.equal(g['modificado un partido de jornada #'].failed,1);
  assert.equal(g['bienvenido a clupik'].handled,false);
  assert.equal(r.failures.length,1);assert.match(r.failures[0].error,/Identidad Clupik ausente/);
  assert.equal(JSON.stringify(r.statuses),JSON.stringify({confirmed:3,tentative:0,cancelled:1}));
  assert.match(r.text,/NO los procesa/);assert.match(r.text,/NO se pueden interpretar 1/);
  // Solo lee: nada en propiedades, calendario ni correo.
  assert.equal(JSON.stringify(h.properties),before.props);assert.equal(h.events.length,before.events);assert.equal(h.mail.length,before.mail);
});
test('auditoría de cobertura: partidos desconocidos y fechas distintas frente al paquete publicado',()=>{
  const h=harness();
  const nuevo=h.msg(0,'Nuevo partido','2026-10-16T10:00:00Z',fixtures[0].replaceAll('145574486','199999999'));
  const movido=h.msg(1,'Modificado un partido','2026-10-17T10:00:00Z',fixtures[1].replace('09:00','10:30'));
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[nuevo,movido]}]:[]};
  const r=h.c.aeseClupikCoverage_();
  assert.equal(JSON.stringify(r.unknown),JSON.stringify(['1339808:199999999']));
  assert.equal(JSON.stringify(r.differing),JSON.stringify(['1339810:145608988']));
  assert.match(r.reference,/GitHub Pages/);
  assert.match(r.text,/posibles partidos nuevos\): 1/);
});
test('auditoría de cobertura: sin paquete publicado usa la copia del script y no compara fechas; informe parcial si se acaba el tiempo',()=>{
  const h=harness();
  h.c.UrlFetchApp.fetch=()=>({getResponseCode:()=>500,getContentText:()=> 'error'});
  const m=h.msg(1,'Modificado un partido','2026-10-17T10:00:00Z',fixtures[1].replace('09:00','10:30'));
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[m]}]:[]};
  const r=h.c.aeseClupikCoverage_();
  assert.match(r.reference,/copia incluida/);assert.equal(r.differing.length,0);
  assert.match(r.text,/No se comparan fechas/);
  const parcial=h.c.aeseClupikCoverage_({budgetMs:-1});
  assert.equal(parcial.partial,true);assert.match(parcial.text,/INFORME PARCIAL/);
});
test('auditoría por correo usa la dirección de alertas existente y nada más',()=>{
  const h=harness();h.c.GmailApp={search:()=>[]};
  h.c.auditClupikCoverageEmail();
  assert.equal(h.mail.length,1);assert.equal(h.mail[0][0],vm.runInContext('AESE_ALERT_EMAIL',h.c));
  assert.match(h.mail[0][2],/Correos de Clupik encontrados: 0/);
});
test('aviso ilegible: se identifica, bloquea 72 h y después se aparta con un solo correo sin frenar los demás',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  const recent=()=>new Date(Date.now()-1000).toISOString();
  const roto=h.msg(0,'Partido aplazado por obras',recent(),'<b>roto</b>');
  const bueno=h.msg(1,'Modificado un partido',new Date(Date.now()-500).toISOString());
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[roto,bueno]}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  // Primera vez: como hasta ahora (error, checkpoint intacto), pero el error dice cuál es el aviso.
  assert.throws(()=>h.c.runAESECalendarSync(),/avisos ilegibles.*Partido aplazado por obras/);
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.ok(h.properties.has('AESE_CLUPIK_BAD_'+roto.getId()));
  assert.equal(h.events.length,1);                                         // el aviso legible sí se procesó
  // Pasadas 71 h: sigue igual.
  h.properties.set('AESE_CLUPIK_BAD_'+roto.getId(),String(Date.now()-71*3600000));
  assert.throws(()=>h.c.runAESECalendarSync(),/Clupik incompleto/);
  // Pasadas 73 h: se aparta, el ciclo termina bien y el checkpoint avanza.
  h.properties.set('AESE_CLUPIK_BAD_'+roto.getId(),String(Date.now()-73*3600000));
  const mailsBefore=h.mail.length;
  h.c.runAESECalendarSync();
  assert.notEqual(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.ok(h.properties.get('AESE_CLUPIK_DONE_'+roto.getId()));
  const apartado=h.mail.slice(mailsBefore).filter(m=>/apartado/.test(m[1]));
  assert.equal(apartado.length,1);
  assert.match(apartado[0][2],/Partido aplazado por obras/);assert.doesNotMatch(apartado[0][2],/se reintentará/);
  // Y no vuelve a avisar ni a bloquear.
  h.c.runAESECalendarSync();
  assert.equal(h.mail.slice(mailsBefore).filter(m=>/apartado/.test(m[1])).length,1);
});
test('aviso ilegible apartado es distinto de un fallo transitorio: un error de Calendar nunca se aparta',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  const m=h.msg(0,'Modificado un partido',new Date(Date.now()-1000).toISOString());
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[m]}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  h.calendar.createEvent=()=>{throw new Error('Calendar no disponible')};
  h.properties.set('AESE_CLUPIK_BAD_'+m.getId(),String(Date.now()-100*3600000));   // aunque tuviera marca antigua
  assert.throws(()=>h.c.runAESECalendarSync(),/Clupik incompleto/);
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.equal(h.properties.has('AESE_CLUPIK_DONE_'+m.getId()),false);
});
