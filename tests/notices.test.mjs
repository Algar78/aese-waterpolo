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
  for(const file of ['calendar_offline_bundle.gs','actawp_calendar_sync.gs','clupik_calendar_sync.gs','calendar_reliability.gs'])vm.runInContext(read(file),c);
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
  h.c.GmailApp={search:()=>[{getMessages:()=>[h.msg(0,'Partido',new Date(Date.now()-1000).toISOString(),'<b>roto</b>')]}]};
  let synced=false;h.c.syncActaWPToCalendar=()=>{synced=true;return {status:'complete'}};
  assert.throws(()=>h.c.runAESECalendarSync(),/Clupik incompleto/);
  assert.equal(synced,true);assert.equal(h.mail.length,1);
  assert.equal(h.properties.get('ULTIMA_EJECUCION'),'2026-10-15T10:00:00Z');assert.equal(h.properties.has('AESE_LAST_SUCCESS'),false);
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
  h.c.checkAESECalendarHealth();assert.equal(h.mail.length,1);assert.match(h.mail[0][1],/publicacion/);
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
