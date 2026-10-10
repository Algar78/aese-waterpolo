import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../actawp_calendar_sync.gs',import.meta.url),'utf8');
const matches=JSON.parse(readFileSync(new URL('../data/actawp_matches.json',import.meta.url)));
const status=JSON.parse(readFileSync(new URL('../data/actawp_export_status.json',import.meta.url)));
const venues=JSON.parse(readFileSync(new URL('../data/venues.json',import.meta.url)));
function harness() {
  const properties=new Map(), events=[], calls=[];
  let lookupError=false, createError=false, propertyError=false;
  function event(m, description='ACTAWP_MATCH_ID:'+m.tournament_id+':'+m.match_id) {
    const value={id:'event-'+events.length,title:'old',start:new Date(m.start),end:new Date(new Date(m.start).getTime()+90*60000),location:m.venue,description};
    const e={getId:()=>value.id,getTitle:()=>value.title,getStartTime:()=>value.start,getEndTime:()=>value.end,getLocation:()=>value.location,getDescription:()=>value.description,
      setTitle:v=>{value.title=v;calls.push('title')},setTime:(s,e)=>{value.start=s;value.end=e;calls.push('time')},setLocation:v=>{value.location=v;calls.push('location')},setDescription:v=>{value.description=v;calls.push('description')},value};
    events.push(e);return e;
  }
  const calendar={getName:()=> 'AESE',getEventById:id=>{if(lookupError)throw Error('quota');return events.find(e=>e.getId()===id)||null},
    getEvents:(from,to)=>events.filter(e=>e.getStartTime()>=from&&e.getStartTime()<to),
    createEvent:(title,start,end,options)=>{if(createError)throw Error('quota');calls.push('create');const e=event({...matches[0],start:start.toISOString(),venue:options.location},options.description);e.value.title=title;e.value.end=end;return e;}};
  const props={getProperty:k=>properties.get(k)||null,setProperty:(k,v)=>{if(propertyError)throw Error('property quota');properties.set(k,v)}};
  const context=vm.createContext({console:{log:()=>{}},Date,Set,Map,Number,JSON,Math,encodeURIComponent,
    CalendarApp:{getCalendarById:()=>calendar},PropertiesService:{getScriptProperties:()=>props},
    LockService:{getScriptLock:()=>({waitLock:()=>calls.push('lock'),releaseLock:()=>calls.push('unlock')})},
    Utilities:{formatDate:(date,zone,pattern)=>{const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T');return pattern==='HH:mm'?parts.slice(11,16):parts;}},
    UrlFetchApp:{fetch:url=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(url.endsWith('/commits/main')?{sha:'a'.repeat(40)}:url.endsWith('venues.json')?venues:url.endsWith('actawp_export_status.json')?status:matches)})}});
  vm.runInContext(code,context);vm.runInContext('ACTAWP_VENUES = '+JSON.stringify(venues),context);
  return {context,properties,events,calls,event,calendar,failLookup:()=>lookupError=true,failCreate:()=>createError=true,failProperty:()=>propertyError=true,restore:()=>{lookupError=createError=propertyError=false}};
}
test('referencia antigua migra a torneo:partido; fecha y sede cambian sin duplicar',()=>{
  const h=harness(), m=matches[0], e=h.event(m,'ACTAWP_MATCH_ID:'+m.match_id+'\nActaWP: '+m.url);
  h.properties.set('ACTAWP_EVENT_'+m.match_id,e.getId());
  const changed={...m,start:'2027-02-01T12:00:00+01:00',venue:matches.find(x=>x.venue!==m.venue).venue};
  assert.equal(h.context.reconcileActaWPMatch_(h.calendar,changed),'updated');
  assert.equal(h.events.length,1);assert.equal(e.getStartTime().toISOString(),'2027-02-01T11:00:00.000Z');
  assert.equal(h.properties.get('ACTAWP_EVENT_'+m.tournament_id+':'+m.match_id),e.getId());
  assert.ok(e.getDescription().includes('Google Maps: https://www.google.com/maps/search/?api=1&query='));
  assert.equal(h.context.reconcileActaWPMatch_(h.calendar,changed),'unchanged');
});
test('referencia perdida y cambio de fecha >7 días recupera el evento de temporada',()=>{
  const h=harness(),m=matches[0];h.event(m);
  h.context.reconcileActaWPMatch_(h.calendar,{...m,start:'2027-04-01T12:00:00+02:00'});
  assert.equal(h.events.length,1);assert.ok(h.calls.includes('time'));
});
test('aplazamiento a la siguiente temporada recupera identidad sin referencia',()=>{
  const h=harness(),m=matches[0];h.event(m);
  h.context.reconcileActaWPMatch_(h.calendar,{...m,start:'2027-10-01T12:00:00+02:00'});
  assert.equal(h.events.length,1);
});
test('marcador exacto no confunde 12 con 123 y exige fuente para marcador antiguo',()=>{
  const h=harness(),m={...matches[0],match_id:12};
  assert.equal(h.context.ownsActaWPEvent_(h.event(m,'ACTAWP_MATCH_ID:'+m.tournament_id+':123'),m),false);
  assert.equal(h.context.ownsActaWPEvent_(h.event(m,'ACTAWP_MATCH_ID:12'),m),false);
});
test('dos eventos con identidad idéntica bloquean cambios sin borrar ninguno',()=>{
  const h=harness(),m=matches[0];const first=h.event(m);h.event(m);
  h.properties.set('ACTAWP_EVENT_'+m.tournament_id+':'+m.match_id,first.getId());
  assert.throws(()=>h.context.reconcileActaWPMatch_(h.calendar,m),/duplicada/);
  assert.equal(h.events.length,2);assert.equal(h.calls.length,0);
});
test('un posible evento Clupik no se adopta, duplica ni elimina',()=>{
  const h=harness(),m=matches[0],e=h.event(m,'Correo Clupik original');e.value.title=m.home_team+' vs '+m.away_team;
  assert.throws(()=>h.context.reconcileActaWPMatch_(h.calendar,m),/Clupik/);
  assert.equal(e.getDescription(),'Correo Clupik original');assert.equal(h.events.length,1);
});
test('error getEventById no provoca creación; referencia ajena no se modifica',()=>{
  const h=harness(),m=matches[0],e=h.event(m,'Evento legítimo');
  h.properties.set('ACTAWP_EVENT_'+m.tournament_id+':'+m.match_id,e.getId());h.failLookup();
  assert.throws(()=>h.context.reconcileActaWPMatch_(h.calendar,m),/consultar/);h.restore();
  assert.throws(()=>h.context.reconcileActaWPMatch_(h.calendar,m),/ajeno/);assert.equal(h.calls.length,0);
});
test('fallo después de crear y antes de guardar referencia se recupera sin duplicar',()=>{
  const h=harness(),m=matches[0];h.failProperty();
  assert.throws(()=>h.context.reconcileActaWPMatch_(h.calendar,m),/quota/);assert.equal(h.events.length,1);
  h.restore();h.context.reconcileActaWPMatch_(h.calendar,m);assert.equal(h.events.length,1);
});
test('snapshot parcial/duplicado/fecha inválida se rechaza antes de cualquier escritura',()=>{
  const h=harness();
  for(const [rows,s] of [[matches.slice(1),status],[[...matches,matches[0]],status],[matches,{...status,complete:false}]]) {
    assert.throws(()=>h.context.validateActaWPSnapshot_(rows,s));assert.equal(h.calls.length,0);
  }
  const rows=structuredClone(matches);rows[0].start='2026-10-10T12:00:00+01:00';
  assert.throws(()=>h.context.validateActaWPSnapshot_(rows,status));
});
test('cancelación y aplazamiento explícitos conservan evento e identidad',()=>{
  for(const state of ['cancelled','tentative']) {
    const h=harness(),m={...matches[0],status:state};const e=h.event(m);
    h.context.reconcileActaWPMatch_(h.calendar,m);assert.equal(h.events.length,1);
    assert.ok(e.getTitle().includes(state==='cancelled'?'CANCELADO':'APLAZADO'));
  }
});
test('fallo parcial de ejecución no marca éxito y libera el bloqueo',()=>{
  const h=harness();h.failCreate();assert.throws(()=>h.context.syncActaWPToCalendar(),/quota/);
  assert.equal(h.properties.has('ACTAWP_LAST_SYNC'),false);assert.equal(h.calls.at(-1),'unlock');
});
test('Maps general conserva texto, eventos Clupik y duplicados; preview no escribe',()=>{
  const h=harness(),m=matches[0],a=h.event(m,'Texto legítimo'),b=h.event(m,'Clupik');
  const preview=h.context.previewGeneralCalendarMaps();assert.equal(preview.changes.length,2);assert.equal(a.getDescription(),'Texto legítimo');
  const result=h.context.updateGeneralCalendarMaps();assert.equal(result.changes.length,2);assert.equal(h.events.length,2);
  assert.ok(a.getDescription().startsWith('Texto legítimo'));assert.ok(b.getDescription().startsWith('Clupik'));
  assert.equal(h.context.updateGeneralCalendarMaps().changes.length,0);
});
