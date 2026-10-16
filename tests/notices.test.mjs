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
  const props={getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>properties.set(k,v)};
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
    MailApp:{sendEmail:(...x)=>mail.push(x)},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({schema_version:1,matches:snapshot,status:JSON.parse(read('data/actawp_export_status.json')),venues})})}});
  for(const file of ['actawp_calendar_sync.gs','clupik_calendar_sync.gs','calendar_reliability.gs'])vm.runInContext(read(file),c);
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
test('duplicados exactos bloquean escrituras y conservan evidencia',()=>{
  const h=harness();h.c.procesarMensajeAESE_(h.msg(),h.calendar);h.events.push(h.events[0]);
  assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(),h.calendar),/duplicada/);
});
test('identidad estricta y fecha ambigua/imposible no crean eventos',()=>{
  const h=harness();
  for(const date of ['04/09/2027','02/30/2027'])assert.throws(()=>h.c.procesarMensajeAESE_(h.msg(0,'Partido',undefined,fixtures[0].replace('10/24/2026',date)),h.calendar),/ambigua|inválida/);
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
  let synced=false;h.c.syncActaWPToCalendar=()=>{synced=true};
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
