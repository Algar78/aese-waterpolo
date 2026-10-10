import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, cpSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {categories, eventState, feed, uid, generate} from '../scripts/calendar-feeds.mjs';
import {mapsURL, venues} from '../scripts/venues.mjs';
const matches=JSON.parse(readFileSync(new URL('../data/actawp_matches.json',import.meta.url)));
const unfold=s=>s.replace(/\r\n /g,'');
test('80 partidos y nueve feeds incluyen Maps con sede verificada; UID y URL originales',()=>{
  for(const name of Object.keys(categories)) {
    const text=unfold(feed(name,matches));
    for(const m of matches.filter(m=>m.category===name)) {
      assert.ok(venues[m.venue]?.source);
      const event=text.split('BEGIN:VEVENT').find(t=>t.includes('UID:'+uid(m)+'\r\n'));
      assert.ok(event.includes('Google Maps: '+mapsURL(m.venue)));
      assert.ok(event.includes('\r\nURL:'+m.url+'\r\n'));
      const url=new URL(mapsURL(m.venue)); assert.equal(url.searchParams.get('api'),'1');
      assert.equal(url.searchParams.get('query'),venues[m.venue].query);
    }
  }
  assert.throws(()=>mapsURL('Sede inventada'),/verificar/);
});
test('fecha y sede actualizadas, aplazamiento y cancelación explícitos mantienen identidad',()=>{
  const m=matches[0], initial=eventState([m]);
  for(const edit of [{start:'2027-06-01T12:00:00+02:00'},{venue:matches.find(x=>x.venue!==m.venue).venue},{status:'tentative'},{status:'cancelled'}]) {
    const changed={...m,...edit}, next=eventState([changed],initial,'20261011T000000Z');
    assert.equal(next[uid(m)].sequence,1);
    const text=unfold(feed(m.category,[changed],next));
    assert.ok(text.includes('UID:'+uid(m))); assert.ok(text.includes('URL:'+m.url));
    if(edit.status) assert.ok(text.includes('STATUS:'+edit.status.toUpperCase()));
  }
});
test('desaparición de un partido bloquea feeds sin escribir ni eliminar eventos',()=>{
  assert.throws(()=>eventState(matches.slice(1),eventState(matches)),/desaparecido/);
});
test('generación repetida no cambia revisiones ni contenido',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aese-feeds-'));
  try {
    cpSync(new URL('../data/',import.meta.url),join(dir,'data'),{recursive:true});
    cpSync(new URL('../calendars/',import.meta.url),join(dir,'calendars'),{recursive:true});
    const root=pathToFileURL(dir+'/'); generate(root);
    const before=readFileSync(join(dir,'calendars/event-state.json'),'utf8');
    const feeds=Object.values(categories).map(s=>readFileSync(join(dir,'calendars',s+'.ics'),'utf8'));
    generate(root); assert.equal(readFileSync(join(dir,'calendars/event-state.json'),'utf8'),before);
    Object.values(categories).forEach((s,i)=>assert.equal(readFileSync(join(dir,'calendars',s+'.ics'),'utf8'),feeds[i]));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
