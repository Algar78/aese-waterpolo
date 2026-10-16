import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../clupik_calendar_sync.gs',import.meta.url),'utf8');
function setup(managed=[], recovered={}) {
  const logs=[],calls=[];
  const context=vm.createContext({Date,Utilities:{formatDate:(date,zone)=>new Intl.DateTimeFormat('sv-SE',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T')},Logger:{log:x=>logs.push(x)},loadActaWPSnapshot_:()=>managed,findActaWPEvent_:()=>recovered});
  vm.runInContext(code,context);
  const calendar={getEvents:()=>[],createEvent:()=>calls.push('create')};
  const message=(id='12',subject='Modificado un partido')=>({getSubject:()=>subject,getBody:()=>`<a href="https://leverade.com/tournament/100/match/${id}/results">Ver</a>`});
  return {context,calendar,message,calls,logs};
}
test('Clupik Madrid es independiente de la zona del proceso y respeta invierno/verano',()=>{
  const h=setup();
  for(const [args,expected] of [
    [[2026,11,15,17,20],'2026-11-15T16:20:00.000Z'],
    [[2026,10,17,17,20],'2026-10-17T15:20:00.000Z'],
    [[2026,3,29,3,30],'2026-03-29T01:30:00.000Z']
  ]) assert.equal(h.context.clupikMadridDate_(...args).toISOString(),expected);
  for(const args of [[2026,3,29,2,30],[2026,10,25,2,30],[2026,2,30,12,0],[2026,11,15,24,0]])
    assert.throws(()=>h.context.clupikMadridDate_(...args),/inválida|ambigua/);
});

