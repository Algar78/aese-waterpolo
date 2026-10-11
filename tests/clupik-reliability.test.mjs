import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../clupik_calendar_sync.gs',import.meta.url),'utf8');
function setup(managed=[], recovered={}) {
  const logs=[],calls=[];
  const context=vm.createContext({Date,Logger:{log:x=>logs.push(x)},loadActaWPSnapshot_:()=>managed,findActaWPEvent_:()=>recovered});
  vm.runInContext(code,context);
  const calendar={getEvents:()=>[],createEvent:()=>calls.push('create')};
  const message=(id='12',subject='Modificado un partido')=>({getSubject:()=>subject,getBody:()=>`<a href="https://leverade.com/tournament/100/match/${id}/results">Ver</a>`});
  return {context,calendar,message,calls,logs};
}
test('Clupik no recrea copia de partido administrado por ActaWP',()=>{
  const h=setup([{tournament_id:100,match_id:12,start:'2026-10-17T17:20:00+02:00'}]);
  h.context.procesarMensajeAESE_(h.message(),h.calendar);
  assert.deepEqual(h.calls,[]);assert.match(h.logs[0],/ActaWP/);
});
test('un partido administrado sin referencia y una cancelación exigen revisión',()=>{
  const m={tournament_id:100,match_id:12,start:'2026-10-17T17:20:00+02:00'};
  const h=setup([m],null);
  assert.throws(()=>h.context.procesarMensajeAESE_(h.message(),h.calendar),/sin evento vinculado/);
  assert.throws(()=>h.context.procesarMensajeAESE_(h.message('12','Partido cancelado'),h.calendar),/cancelación/);
  assert.deepEqual(h.calls,[]);
});
test('el paquete no disponible bloquea Clupik antes de cualquier escritura',()=>{
  const h=setup();h.context.loadActaWPSnapshot_=()=>{throw Error('HTTP 503')};
  assert.throws(()=>h.context.procesarMensajeAESE_(h.message(),h.calendar),/503/);
  assert.deepEqual(h.calls,[]);
});
test('mismo ID en otro torneo no se asume administrado',()=>{
  const h=setup([{tournament_id:101,match_id:12,start:'2026-10-17T17:20:00+02:00'}]);
  assert.throws(()=>h.context.procesarMensajeAESE_(h.message(),h.calendar),/datos principales/);
});
test('la limpieza Clupik conserva duplicados e identidad exacta',()=>{
  const h=setup();
  const blocks=['Federació Catalana de Natació LLIGA JUVENIL FEMENI','17:20','A.E. SANTA EULÀLIA','Jornada 1','17/10/2026','GEiEG','228 - Santa Eulàlia, AE','Ver'];
  const message={getBody:()=>blocks.map(x=>`<td>${x}</td>`).join('')+'<a href="https://leverade.com/tournament/100/match/12/results">Ver</a>',getSubject:()=>''};
  const event=()=>({getDescription:()=> 'CLUPIK_MATCH_ID:12\nhttps://leverade.com/tournament/100/match/12/results',deleteEvent:()=>h.calls.push('delete')});
  h.calendar.getEvents=()=>[event(),event()];
  assert.throws(()=>h.context.procesarMensajeAESE_(message,h.calendar),/duplicada/);
  assert.deepEqual(h.calls,[]);
});

test('fallo de un correo conserva checkpoint y libera el bloqueo compartido',()=>{
  const h=setup(), checkpoint='2026-10-01T10:00:00.000Z', writes=[];
  h.context.LockService={getScriptLock:()=>({waitLock:()=>writes.push('lock'),releaseLock:()=>writes.push('unlock')})};
  h.context.CalendarApp={getCalendarById:()=>h.calendar};
  h.context.PropertiesService={getScriptProperties:()=>({getProperty:()=>checkpoint,setProperty:()=>writes.push('checkpoint')})};
  h.context.Session={getScriptTimeZone:()=> 'Europe/Madrid'};
  h.context.Utilities={formatDate:()=> '2026/10/01'};
  h.context.GmailApp={search:()=>[{getMessages:()=>[{getDate:()=>new Date('2026-10-02T10:00:00Z'),getFrom:()=> 'no-reply@clupik.com',getSubject:()=> 'Partido'}]}]};
  h.context.procesarMensajeAESE_=()=>{throw Error('revisión pendiente')};
  assert.throws(()=>h.context.procesarPartidosAESE(),/conserva ULTIMA_EJECUCION/);
  assert.deepEqual(writes,['lock','unlock']);
});
