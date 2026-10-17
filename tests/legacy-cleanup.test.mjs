import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../calendar_verification.gs',import.meta.url),'utf8');
function setup(){
  const rows=[],deleted=[],props=new Map();
  function event(id,start,description){const e={getId:()=>id,getStartTime:()=>new Date(start),getEndTime:()=>new Date(Date.parse(start)+3600000),getDescription:()=>description,getTitle:()=> 'AESE',getLocation:()=> 'Pool',deleteEvent:()=>{deleted.push(id);rows.splice(rows.indexOf(e),1)}};rows.push(e);return e;}
  const original=event('original','2027-04-09T18:45:00Z','ACTAWP_MATCH_ID:1339806:145574474');
  event('621guj4p2e4c3e2b0bq1elmf84@google.com','2027-09-04T18:45:00Z','CLUPIK_MATCH_ID:145574474\nhttps://leverade.com/tournament/1339806/match/145574474/results');
  const c=vm.createContext({console:{log(){}},Date,ACTAWP_CALENDAR_ID:'calendar',
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    CalendarApp:{getCalendarById:()=>({getEvents:()=>rows})},
    PropertiesService:{getScriptProperties:()=>({setProperty:(k,v)=>props.set(k,v)})},
    ownsActaWPEvent_:(e,m)=>e.getDescription()==='ACTAWP_MATCH_ID:'+m.tournament_id+':'+m.match_id});
  vm.runInContext(code,c);return {c,rows,deleted,props,original};
}
test('preview no borra; limpieza conserva original, guarda copia y es idempotente',()=>{
  const h=setup();assert.equal(h.c.previewAESELegacyDuplicates(),1);assert.equal(h.deleted.length,0);
  assert.equal(h.c.repairAESELegacyDuplicates(),1);assert.equal(h.rows.length,1);assert.equal(h.rows[0],h.original);
  assert.equal(JSON.parse(h.props.get('AESE_LEGACY_BACKUP_1339806:145574474')).original,'original');
  assert.equal(h.c.repairAESELegacyDuplicates(),0);
});
test('sin original verificado no se borra ningún duplicado',()=>{
  const h=setup();h.rows.splice(0,1);assert.throws(()=>h.c.repairAESELegacyDuplicates(),/precondition/);assert.equal(h.deleted.length,0);
});
test('fecha cambiada del candidato bloquea reparación',()=>{
  const h=setup();h.rows[1].getStartTime=()=>new Date('2027-09-05T18:45:00Z');
  assert.throws(()=>h.c.repairAESELegacyDuplicates(),/precondition/);assert.equal(h.deleted.length,0);
});
