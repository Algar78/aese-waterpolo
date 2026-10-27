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
  h.c.GmailApp={search:()=>[{getMessages:()=>[h.msg(0,'Partido',new Date(Date.now()-1000).toISOString())]}]};
  h.calendar.createEvent=()=>{throw new Error('Calendar no disponible')};   // fallo transitorio, no un aviso ilegible
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
test('aviso ilegible: un solo correo que lo nombra, no cuenta como fallo del ciclo, se retiene 72 h y después se aparta sin frenar los demás',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  const recent=()=>new Date(Date.now()-1000).toISOString();
  const roto=h.msg(0,'Partido aplazado por obras',recent(),'<b>roto</b>');
  const bueno=h.msg(1,'Modificado un partido',new Date(Date.now()-500).toISOString());
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[roto,bueno]}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  // Primera vez: el ciclo termina bien (no hay error cada 15 minutos), la ventana sigue abierta y llega UN correo que dice cuál es el aviso.
  h.c.runAESECalendarSync();
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.ok(h.properties.has('AESE_CLUPIK_BAD_'+roto.getId()));
  assert.ok(h.properties.get('AESE_CLUPIK_LAST_SUCCESS'));assert.equal(h.properties.get('AESE_LAST_ERROR'),'');
  assert.equal(h.events.length,1);                                         // el aviso legible sí se procesó
  assert.equal(h.mail.length,1);
  assert.match(h.mail[0][1],/no se ha podido interpretar/);assert.match(h.mail[0][2],/Partido aplazado por obras/);
  assert.match(h.mail[0][2],/72 horas/);assert.match(h.mail[0][2],/No habrá más correos/);
  // Cada 15 minutos durante las 72 h: ni errores ni más correos ni eventos duplicados ni nuevo trabajo con el aviso legible.
  h.properties.set('AESE_CLUPIK_BAD_'+roto.getId(),String(Date.now()-71*3600000));
  for(let i=0;i<3;i++)h.c.runAESECalendarSync();
  assert.equal(h.mail.length,1);assert.equal(h.events.length,1);
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  // Pasadas 73 h: se aparta sin otro correo, y el checkpoint avanza.
  h.properties.set('AESE_CLUPIK_BAD_'+roto.getId(),String(Date.now()-73*3600000));
  h.c.runAESECalendarSync();
  assert.notEqual(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.ok(h.properties.get('AESE_CLUPIK_DONE_'+roto.getId()));
  h.c.runAESECalendarSync();
  assert.equal(h.mail.length,1);
});
test('avisos ilegibles: varios a la vez dan un solo correo y, si el envío falla, se reintenta sin duplicar',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  const rotos=[0,1,2].map(i=>h.msg(0,'Partido roto '+i,new Date(Date.now()-1000-i).toISOString(),'<b>roto '+i+'</b>'));
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>rotos}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  const send=h.c.MailApp.sendEmail;let fail=true;
  h.c.MailApp.sendEmail=(...x)=>{if(fail)throw Error('mail quota');return send(...x)};
  h.c.runAESECalendarSync();assert.equal(h.mail.length,0);                  // no se pudo enviar: no cuenta como avisado
  fail=false;h.c.runAESECalendarSync();
  assert.equal(h.mail.length,1);assert.match(h.mail[0][1],/3 avisos/);
  for(let i=0;i<3;i++)assert.match(h.mail[0][2],new RegExp('Partido roto '+i));
  h.c.runAESECalendarSync();assert.equal(h.mail.length,1);
});
test('con un aviso retenido no se reprocesan los demás en cada ciclo: sus marcas se conservan mientras la ventana siga abierta',()=>{
  const h=harness();h.properties.set('ULTIMA_EJECUCION',new Date(Date.now()-60*3600000).toISOString());   // ventana abierta desde hace 60 h (+48 h de solape)
  const viejo=h.msg(1,'Modificado un partido',new Date(Date.now()-100*3600000).toISOString());
  const roto=h.msg(0,'Partido roto',new Date(Date.now()-1000).toISOString(),'<b>roto</b>');
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[viejo,roto]}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  h.properties.set('AESE_CLUPIK_DONE_'+viejo.getId(),new Date(Date.now()-100*3600000).toISOString());
  h.c.runAESECalendarSync();
  assert.ok(h.properties.has('AESE_CLUPIK_DONE_'+viejo.getId()));          // el límite de 49 h lo habría borrado
  assert.equal(h.events.length,0);                                         // y no se ha vuelto a procesar
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
test('diagnóstico de avisos ilegibles: agrupa por tipo y mes, enseña la estructura sin enlaces ni correos y no escribe nada',()=>{
  const h=harness();
  const sinFecha='<div>Hola Pedro</div><div>LLIGA CATALANA</div><div>SANTA EULALIA</div><div>Jornada 4</div><div>escribe a socio@example.com</div>'+
    '<div>https://clupik.com/x?token=SECRETO</div><a href="https://actawp.natacio.cat/ca/tournament/1339808/match/145574486/results">ver</a>';
  const a=h.msg(0,'Nuevo partido en Jornada 4','2026-01-10T10:00:00Z',sinFecha), b=h.msg(0,'Nuevo partido en Jornada 5','2026-10-12T10:00:00Z',sinFecha);
  const bueno=h.msg(0,'Modificado un partido','2026-10-13T10:00:00Z');
  const info=h.msg(0,'Nuevo resultado en jornada 2','2026-10-14T10:00:00Z','<p>x</p>');
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[a,bueno,b,info]}]:[]};
  const before={props:JSON.stringify(h.properties),events:h.events.length,mail:h.mail.length};
  const r=h.c.aeseClupikUnreadable_();
  assert.equal(r.handled,3);                                   // el asunto «resultado» no se procesa y no se cuenta
  assert.equal(r.groups.length,1);
  assert.equal(r.groups[0].count,2);
  assert.equal(JSON.stringify(r.groups[0].months),JSON.stringify({'2026-01':1,'2026-10':1}));
  assert.equal(r.groups[0].sample.identity,'1339808:145574486');
  assert.equal(r.groups[0].sample.hasTime,false);assert.equal(r.groups[0].sample.hasDate,false);
  assert.match(r.text,/LLIGA CATALANA/);assert.match(r.text,/hora: NO · fecha: NO/);
  assert.doesNotMatch(r.text,/socio@example\.com|SECRETO|https?:/);   // sin direcciones ni enlaces
  assert.equal(JSON.stringify(h.properties),before.props);assert.equal(h.events.length,before.events);assert.equal(h.mail.length,before.mail);
  assert.equal(h.c.aeseClupikUnreadable_({budgetMs:-1}).partial,true);
});
test('diagnóstico del formato de fechas: separa fechas seguras de ambiguas y las compara con el paquete oficial',()=>{
  const h=harness();
  const conFecha=(fecha)=>fixtures[0].replace(/\d{2}\/\d{2}\/\d{4}/,fecha);
  const fecha0=(fixtures[0].match(/\d{2}\/\d{2}\/\d{4}/)||[])[0];
  assert.ok(fecha0,'el fixture debe traer una fecha dd/dd/aaaa');
  const [a0,b0]=fecha0.split('/').map(Number);
  const mails=[
    h.msg(0,'Modificado un partido','2026-04-01T10:00:00Z',conFecha('25/04/2026')),
    h.msg(0,'Modificado un partido','2026-10-02T10:00:00Z',conFecha('04/25/2026')),
    h.msg(0,'Modificado un partido','2026-10-03T10:00:00Z',conFecha('05/11/2026')),
    h.msg(0,'Nuevo resultado en jornada 2','2026-10-04T10:00:00Z',conFecha('06/07/2026')),  // asunto ignorado
    h.msg(0,'Nuevo partido en jornada 3','2026-10-05T10:00:00Z','<div>sin fecha</div>')
  ];
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>mails}]:[]};
  const before={props:JSON.stringify(h.properties),events:h.events.length,mail:h.mail.length};
  const r=h.c.aeseClupikDateFormats_();
  assert.equal(r.withDate,3);assert.equal(r.withoutDate,1);
  assert.equal(JSON.stringify(r.months['2026-04']),JSON.stringify({'DD/MM seguro':1}));
  assert.equal(JSON.stringify(r.months['2026-10']),JSON.stringify({'MM/DD seguro':1,'ambiguo':1}));
  assert.equal(JSON.stringify(r.tournaments['1339808']),JSON.stringify({'DD/MM seguro':1,'MM/DD seguro':1,'ambiguo':1}));
  assert.match(r.text,/1339808: DD\/MM 1 · MM\/DD 1 · ambiguos 1 · MEZCLA/);
  assert.match(r.text,/DD\/MM seguro: del 2026-04-01 al 2026-04-01/);
  assert.match(r.text,/MM\/DD seguro: del 2026-10-02 al 2026-10-02/);
  assert.equal(JSON.stringify(h.properties),before.props);assert.equal(h.events.length,before.events);assert.equal(h.mail.length,before.mail);
  assert.equal(h.c.aeseClupikDateFormats_({budgetMs:-1}).partial,true);
});
test('diagnóstico de qué distingue los formatos de fecha: muestra el contexto sin enlaces ni correos y no escribe nada',()=>{
  const h=harness();
  const conFecha=(fecha)=>fixtures[0].replace(/\d{2}\/\d{2}\/\d{4}/,fecha).replace('<body','<body data-x="http://x.example/secreto"');
  const a=h.msg(0,'Modificado un partido','2026-04-01T10:00:00Z',conFecha('25/04/2026')), b=h.msg(0,'Modificado un partido','2026-10-02T10:00:00Z',conFecha('04/25/2026'));
  const amb=h.msg(0,'Modificado un partido','2026-10-03T10:00:00Z',conFecha('05/11/2026'));
  [a,b,amb].forEach(m=>{m.getRawContent=()=> 'Message-ID: <abc123@mail.clupik.example>\r\nX-Mailer: Demo 1.0\r\nTo: privado@example.com\r\nContent-Language: es\r\n\r\ncuerpo';});
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[a,b,amb]}]:[]};
  const before={props:JSON.stringify(h.properties),events:h.events.length,mail:h.mail.length};
  const r=h.c.aeseClupikDateDetail_();
  assert.equal(r.samples.length,2);                                         // el ambiguo no es muestra
  assert.equal(JSON.stringify(r.samples.map(s=>s.kind).sort()),JSON.stringify(['DD/MM seguro','MM/DD seguro']));
  assert.match(r.text,/Message-ID: <…@mail\.clupik\.example>/);assert.match(r.text,/Content-Language: es/);
  assert.doesNotMatch(r.text,/privado@example\.com|secreto|https?:/);
  assert.equal(JSON.stringify(h.properties),before.props);assert.equal(h.events.length,before.events);assert.equal(h.mail.length,before.mail);
  assert.equal(h.c.aeseClupikDateDetail_({budgetMs:-1}).partial,true);
});

// ---- Fechas día/mes y mes/día, y partidos nuevos sin fecha (auditoría del 18/10/2026) ----
const conFecha=(fecha)=>fixtures[0].replace('10/24/2026',fecha);
const link=fixtures[0].match(/<a [^>]*>[\s\S]*?<\/a>/)[0];
const sinFecha=(extra='')=>'<div>LLIGA CATALANA CADET MASCULI 26/27</div><div>Hola, has sido inscrito en un partido de Jornada 5</div><div>C.N. BANYOLES</div><div>&nbsp; Jornada 5 &nbsp;</div><div>:</div><div>A.E. SANTA EULÀLIA</div>'+extra+link;
test('fecha con un solo formato posible: se lee sin adivinar, sea día/mes o mes/día',()=>{
  const h=harness(),at='2026-10-16T08:00:00Z';
  const mmdd=h.c.parseClupikNotice_(h.msg(0,'Modificado un partido',at,conFecha('10/24/2026')));
  const ddmm=h.c.parseClupikNotice_(h.msg(0,'Modificado un partido',at,conFecha('24/10/2026')));
  assert.equal(mmdd.start,'2026-10-24T13:00:00+02:00');assert.equal(ddmm.start,'2026-10-24T13:00:00+02:00');
  assert.equal(ddmm.date_resolution,'formato');
  assert.equal(h.c.parseClupikNotice_(h.msg(0,'Modificado un partido',at,conFecha('10/10/2026'))).date_resolution,'igual');
  assert.throws(()=>h.c.parseClupikNotice_(h.msg(0,'Modificado un partido',at,conFecha('31/04/2026'))),/inválida/);   // 31 de abril no existe en ningún formato
});
test('fecha ambigua: la decide el dato oficial o un partido nuevo imposible de estar ya jugado; si no, no se publica',()=>{
  const h=harness(),at='2026-10-16T08:00:00Z';
  // Ventana: 11/05/2026 es el 11 de mayo (pasado) o el 5 de noviembre (próximo): solo la segunda es posible.
  const ventana=h.c.parseClupikNotice_(h.msg(0,'Modificado un partido',at,conFecha('11/05/2026')));
  assert.equal(ventana.start,'2026-11-05T13:00:00+01:00');assert.equal(ventana.date_resolution,'ventana');
  // 03/04/2027: 3 de abril o 4 de marzo, las dos posibles. Sin dato oficial, no se adivina.
  const ambiguo=h.msg(0,'Modificado un partido',at,conFecha('03/04/2027'));
  assert.throws(()=>h.c.parseClupikNotice_(ambiguo),/ambigua: «03\/04\/2027» puede ser 3\/4\/2027 o 4\/3\/2027/);
  // Con el partido ya conocido el 6 de marzo, la lectura 4 de marzo (a 2 días) frente a 3 de abril (a 28) es clara.
  const conRef=h.c.parseClupikNotice_(ambiguo,{reference:()=> '2027-03-06T10:00:00+01:00'});
  assert.equal(conRef.start,'2027-03-04T13:00:00+01:00');assert.equal(conRef.date_resolution,'referencia');
  // Una referencia que no distingue (las dos lecturas a distancias parecidas) tampoco decide.
  assert.throws(()=>h.c.parseClupikNotice_(ambiguo,{reference:()=> '2027-03-20T10:00:00+01:00'}),/ambigua/);
  // Una referencia muy lejana tampoco: un cambio de más de 120 días no se da por válido.
  assert.throws(()=>h.c.parseClupikNotice_(ambiguo,{reference:()=> '2026-09-01T10:00:00+02:00'}),/ambigua/);
  // La plantilla desconocida no usa la ventana, solo el dato oficial.
  const desconocida=h.msg(0,'Modificado un partido',at,conFecha('11/05/2026').replace('id="calendar"','id="unknown"'));
  assert.throws(()=>h.c.parseClupikNotice_(desconocida),/ambigua/);
  assert.equal(h.c.parseClupikNotice_(desconocida,{reference:()=> '2026-11-01T10:00:00+01:00'}).start,'2026-11-05T13:00:00+01:00');
});
test('un aviso ambiguo se resuelve con el evento que ya está en el calendario y no lo mueve de mes',()=>{
  const h=harness();
  h.c.procesarMensajeAESE_(h.msg(0,'Modificado un partido','2026-10-16T08:00:00Z',conFecha('03/22/2027')),h.calendar);   // 22 de marzo
  assert.equal(h.events.length,1);assert.equal(h.events[0].getStartTime().toISOString(),'2027-03-22T12:00:00.000Z');
  // 04/02/2027: 2 de abril (11 días después) o 4 de febrero (46 días antes): el evento decide.
  const result=h.c.procesarMensajeAESE_(h.msg(0,'Modificado un partido','2026-10-17T08:00:00Z',conFecha('04/02/2027')),h.calendar);
  assert.equal(h.events.length,1);
  assert.equal(h.events[0].getStartTime().toISOString(),'2027-04-02T11:00:00.000Z');                                   // 13:00 CEST
  // Si el evento no distingue, el aviso se queda sin publicar y el evento intacto.
  assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(0,'Modificado un partido','2026-10-18T08:00:00Z',conFecha('03/05/2027')),h.calendar),/ambigua/);   // 5 de marzo (28 días) o 3 de mayo (31 días)
  assert.equal(h.events[0].getStartTime().toISOString(),'2027-04-02T11:00:00.000Z');
});
test('partido nuevo sin fecha: no es un error, no crea evento ni bloquea, y avisa por correo una sola vez; modificado sin fecha sigue siéndolo',()=>{
  const h=harness();
  const nuevo=h.c.parseClupikNotice_(h.msg(0,'Nuevo partido en Jornada 5','2026-10-16T08:00:00Z',sinFecha()));
  assert.equal(nuevo.undated,true);assert.equal(nuevo.home_team,'C.N. BANYOLES');assert.equal(nuevo.away_team,'A.E. SANTA EULÀLIA');
  assert.equal(nuevo.tournament_id,1339808);assert.equal(nuevo.match_id,145574486);assert.match(nuevo.category,/CADETE MASCULINO/);
  assert.equal(h.c.procesarMensajeAESE_(h.msg(0,'Nuevo partido en Jornada 5','2026-10-16T08:00:00Z',sinFecha()),h.calendar),'undated');
  assert.equal(h.events.length,0);
  // Dentro del ciclo completo: se marca atendido, el punto de control avanza y se envía UN correo de aviso.
  h.properties.delete('AESE_NEW_MATCH_QUEUE');
  h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  const m=h.msg(0,'Nuevo partido en Jornada 5',new Date(Date.now()-1000).toISOString(),sinFecha());
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>[m]}]:[]};
  h.c.syncActaWPToCalendar=()=>({status:'complete'});
  h.c.runAESECalendarSync();
  assert.ok(h.properties.get('AESE_CLUPIK_DONE_'+m.getId()));assert.notEqual(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');
  assert.equal(h.mail.length,1);assert.equal(h.events.length,0);
  assert.match(String(h.mail[0][1]),/partido nuevo en Clupik, sin fecha ni piscina/);
  assert.match(String(h.mail[0][2]),/C\.N\. BANYOLES vs A\.E\. SANTA EULÀLIA/);assert.equal(h.properties.get('AESE_NEW_MATCH_QUEUE'),undefined);
  // El mismo aviso no vuelve a mandar correo, ni aunque se reprocese.
  h.properties.delete('AESE_CLUPIK_DONE_'+m.getId());h.properties.set('ULTIMA_EJECUCION','2026-10-15T10:00:00Z');
  h.c.runAESECalendarSync();
  assert.equal(h.mail.length,1);
  // «Modificado» sin fecha puede ser un partido que se queda sin fecha: eso sí requiere una persona.
  assert.throws(()=>h.c.parseClupikNotice_(h.msg(0,'Modificado un partido','2026-10-16T08:00:00Z',sinFecha())),/No se pudieron localizar/);
  // Y un aviso sin fecha de otro club no se acepta.
  assert.throws(()=>h.c.parseClupikNotice_(h.msg(0,'Nuevo partido','2026-10-16T08:00:00Z',sinFecha().replace('A.E. SANTA EULÀLIA','C.N. OTRO').replace('C.N. BANYOLES','C.N. UNO'))),/inválidos/);
});
test('la auditoría cuenta los partidos nuevos sin fecha y cómo se leyó cada fecha',()=>{
  const h=harness();
  const mails=[h.msg(0,'Nuevo partido en Jornada 5','2026-10-10T08:00:00Z',sinFecha()),h.msg(1,'Modificado un partido','2026-10-12T08:00:00Z',fixtures[1].replace('11/22/2026','22/11/2026')),
    h.msg(0,'Modificado un partido','2026-10-13T08:00:00Z',conFecha('11/05/2026'))];
  h.c.GmailApp={search:(q,o)=>o===0?[{getMessages:()=>mails}]:[]};
  const r=h.c.aeseClupikCoverage_();
  assert.equal(r.failures.length,0);assert.equal(r.undated,1);
  assert.equal(JSON.stringify(r.stillUndated),JSON.stringify([]));                    // el mismo partido tiene luego un aviso con fecha
  assert.equal(JSON.stringify(r.resolution),JSON.stringify({formato:1,ventana:1}));
  assert.equal(JSON.stringify(r.statuses),JSON.stringify({confirmed:2,tentative:0,cancelled:0}));
  assert.match(r.text,/partido nuevo sin fecha[^\n]*: 1 de 1 partidos/);assert.match(r.text,/formato 1 · ventana 1/);
});

// ---- Sin lectura automática de ActaWP no hay intentos que vigilar (20/10/2026) -------------------------------
// El 20/10 llegó un correo «incidencia de sincronización — fuente» con los 429 del último intento (18/10): la
// lectura automática está desactivada a propósito, así que nunca habrá otro intento y el aviso se repetiría
// cada 24 h sin que nada fallase, además de prometer «se reintentará automáticamente».
const oldFailedAttempt={complete:false,attempted_at:'2026-10-18T10:35:28Z',errors:['Absoluto Masculino: HTTP 429'],error_classes:['rate_limited'],consecutive_failures:30};
const manualPolicy={fresh_hours:336,outdated_hours:720,reminder_hours:720,automated_attempts:false};
const fuente=h=>h.mail.filter(m=>/— fuente/.test(m[1]));
test('sin lectura automática declarada, un último intento antiguo y fallido no genera aviso ni promete reintentos',()=>{
  const h=harness();
  health(h,{lastComplete:hoursAgo(24*20),attempt:oldFailedAttempt,policy:manualPolicy});health(h,{lastComplete:hoursAgo(24*20),attempt:oldFailedAttempt,policy:manualPolicy});
  assert.equal(h.mail.length,0);assert.equal(h.properties.get('AESE_FRESHNESS_STATE'),'stale');   // sigue midiéndose la edad de los datos
});
test('con lectura automática declarada (o sin política), el último intento antiguo y fallido sigue avisando',()=>{
  for(const policy of [{...manualPolicy,automated_attempts:true},{fresh_hours:336,outdated_hours:720,reminder_hours:720},undefined,{fresh_hours:100,outdated_hours:50,automated_attempts:false}]) {
    const h=harness();health(h,{lastComplete:hoursAgo(24*10),attempt:oldFailedAttempt,policy});
    assert.equal(fuente(h).length,1,JSON.stringify(policy));
    assert.match(String(fuente(h)[0][2]),/429/);
  }
});
test('el aviso de datos obsoletos sin lectura automática no culpa a un intento viejo ni promete reintentos, y dice qué hacer',()=>{
  const h=harness();
  health(h,{lastComplete:hoursAgo(24*31),attempt:oldFailedAttempt,policy:manualPolicy});
  const mails=h.mail.filter(m=>/sin actualizar/.test(m[1]));
  assert.equal(mails.length,1);assert.equal(fuente(h).length,0);
  assert.doesNotMatch(String(mails[0][2]),/rate_limited|429|reintentar/);
  assert.match(String(mails[0][2]),/Clupik/);assert.match(String(mails[0][2]),/data\/manual/);
  health(h,{lastComplete:hoursAgo(24*31),attempt:oldFailedAttempt,policy:manualPolicy});
  assert.equal(h.mail.filter(m=>/sin actualizar/.test(m[1])).length,1);                      // un solo correo al mes
});
test('un fallo al leer el paquete publicado sigue avisando aunque no haya lectura automática',()=>{
  const h=harness();h.properties.set('AESE_LAST_SUCCESS',new Date().toISOString());h.properties.set('ACTAWP_LAST_SYNC',new Date().toISOString());
  h.c.fetchActaWPJSON_=()=>{throw Error('Pages caído')};
  h.c.ScriptApp={getProjectTriggers:()=>[{getHandlerFunction:()=> 'runAESECalendarSync'}]};
  h.c.checkAESECalendarHealth();
  assert.equal(fuente(h).length,1);assert.match(String(fuente(h)[0][2]),/Pages caído/);
});

// ---- Piscina sin verificar y partidos nuevos (27/10/2026) ---------------------------------------------------
const conSede=(fecha,sede)=>conFecha(fecha).replace('171 - Banyoles, CN',sede);
test('una piscina sin verificar no retrasa el partido: se publica con el nombre de la sede, sin Maps, y se avisa una vez por sede',()=>{
  const h=harness();
  const a=h.msg(0,'Modificado un partido','2026-10-16T08:00:00Z',conSede('10/24/2026','999 - Piscina Nueva'));
  const result=h.c.procesarMensajeAESE_(a,h.calendar);
  assert.notEqual(result,undefined);
  assert.equal(h.events.length,1);
  assert.equal(h.events[0].getLocation(),'999 - Piscina Nueva');
  assert.ok(!/Google Maps/.test(h.events[0].getDescription()));
  assert.match(h.events[0].getDescription(),/ACTAWP_MATCH_ID:/);
  const avisos=()=>h.mail.filter(x=>/piscina nueva sin enlace/.test(String(x[1])));
  assert.equal(avisos().length,1);assert.match(String(avisos()[0][2]),/999 - Piscina Nueva/);
  // Otro aviso con la misma sede no repite el correo.
  h.c.procesarMensajeAESE_(h.msg(1,'Modificado un partido','2026-10-17T08:00:00Z',conSede('10/24/2026','999 - Piscina Nueva').replace('Banyoles','Banyoles')),h.calendar);
  assert.equal(avisos().length,1);
  // Con la sede ya verificada, el mismo evento recupera el enlace de Maps en su sitio (mismo evento, sin duplicar).
  venues['999 - Piscina Nueva']={query:'Piscina Nueva, Calle 1, Girona',source:'https://example.org/sede'};   // el paquete publicado ya la trae
  try {
    h.c.procesarMensajeAESE_(h.msg(0,'Modificado un partido','2026-10-18T08:00:00Z',conSede('10/24/2026','999 - Piscina Nueva')),h.calendar);
    assert.equal(h.events.length,1);
    assert.ok(/Google Maps: https:\/\/www\.google\.com\/maps\/search/.test(h.events[0].getDescription()));
  } finally { delete venues['999 - Piscina Nueva']; }
});
test('el snapshot de ActaWP sigue exigiendo sede verificada, pero un partido de Clupik con sede nueva no es un error',()=>{
  const h=harness();
  assert.throws(()=>h.c.actaWPMapsURL_('Sede inventada'),/Sede sin verificar/);
  assert.equal(h.c.actaWPVenueVerified_('Sede inventada'),false);
  assert.equal(h.c.actaWPVenueVerified_('171 - Banyoles, CN'),true);
  const match={tournament_id:1,match_id:2,category:'X',venue:'Sede inventada',url:'https://actawp.natacio.cat/x',status:'confirmed'};
  assert.ok(!/Google Maps/.test(h.c.buildActaWPDescription_(match)));
  assert.match(h.c.buildActaWPDescription_({...match,venue:'171 - Banyoles, CN'}),/Google Maps: https:\/\/www\.google\.com\/maps\/search/);
});
test('varios partidos nuevos sin fecha llegan en un solo correo, y si el correo falla se reintenta sin perder ninguno',()=>{
  const h=harness();
  for(const [i,id] of [[0,'a'],[1,'b'],[2,'c']]) {
    const msg=h.msg(0,'Nuevo partido en Jornada '+(i+4),'2026-10-1'+(i+1)+'T08:00:00Z',sinFecha().replace('145574486','14557448'+(i+6)));
    h.c.procesarMensajeAESE_(msg,h.calendar);
  }
  const cola=JSON.parse(h.properties.get('AESE_NEW_MATCH_QUEUE'));
  assert.equal(cola.length,3);
  const send=h.c.MailApp.sendEmail;let fail=true;
  h.c.MailApp.sendEmail=(...x)=>{if(fail)throw Error('mail quota');return send(...x)};
  h.c.aeseFlushNewMatches_();
  assert.equal(h.mail.length,0);assert.equal(JSON.parse(h.properties.get('AESE_NEW_MATCH_QUEUE')).length,3);
  fail=false;h.c.aeseFlushNewMatches_();
  assert.equal(h.mail.length,1);assert.match(String(h.mail[0][1]),/3 partidos nuevos en Clupik/);
  assert.equal(h.properties.get('AESE_NEW_MATCH_QUEUE'),undefined);
  h.c.aeseFlushNewMatches_();assert.equal(h.mail.length,1);
});
