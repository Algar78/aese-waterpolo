import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {categories,validate,feed,uid,utc,escapeICS,fold,eventState} from '../scripts/calendar-feeds.mjs';
const matches = JSON.parse(readFileSync(new URL('../data/actawp_matches.json',import.meta.url)));
const status = JSON.parse(readFileSync(new URL('../data/actawp_export_status.json',import.meta.url)));
const unfold = text => text.replace(/\r\n /g,'');
test('9 feeds y conteos del snapshot completo',()=>{
  const counts=validate(matches,status); assert.equal(Object.keys(counts).length,9);
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),matches.length);
  for(const name of Object.keys(categories)) {
    const text=feed(name,matches); assert.equal((text.match(/BEGIN:VEVENT/g)||[]).length,counts[name]);
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n')); assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.ok(text.includes('X-WR-TIMEZONE:Europe/Madrid'));
    for(const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line)<=75);
    assert.equal((unfold(text).match(/^DTSTART:\d{8}T\d{6}Z$/gm)||[]).length,counts[name]);
  }
});
test('UID únicos, deterministas y estables al cambiar horario/equipos',()=>{
  assert.equal(new Set(matches.map(uid)).size,matches.length);
  const m=matches[0]; assert.equal(uid(m),uid({...m,start:'2027-01-01T12:00:00+01:00',home_team:'Otro nombre'}));
  assert.equal(feed(m.category,matches),feed(m.category,[...matches].reverse()));
});
test('horarios de control del 10 octubre 2026',()=>{
  for(const [category,local,expected] of [['Alevín Mixto A','12:15','20261010T101500Z'],['Juvenil Masculino','17:20','20261010T152000Z']]) {
    const m=matches.find(m=>m.category===category&&m.start.startsWith(`2026-10-10T${local}`)); assert.ok(m,category); assert.equal(utc(m.start),expected);
    assert.ok(unfold(feed(category,matches)).includes(`UID:${uid(m)}\r\nDTSTAMP:20261010T000000Z\r\nDTSTART:${expected}`));
  }
});
test('Europe/Madrid invierno y verano, rechazar offset incorrecto',()=>{
  assert.equal(utc('2027-01-10T12:15:00+01:00'),'20270110T111500Z');
  assert.equal(utc('2026-10-10T12:15:00+02:00'),'20261010T101500Z');
  const copy=structuredClone(matches); copy[0].start='2026-09-26T16:00:00+01:00'; assert.throws(()=>validate(copy,status),/Madrid/);
});
test('escapes ICS y plegado UTF-8 sin romper caracteres',()=>{
  assert.equal(escapeICS('A\\B;C,D\r\nE'),'A\\\\B\\;C\\,D\\nE');
  const value='SUMMARY:'+ 'À🎉'.repeat(60); assert.equal(unfold(fold(value)),value);
  for(const line of fold(value).split('\r\n')) assert.ok(Buffer.byteLength(line)<=75);
  const m={...matches[0],venue:'Piscina, A; B\\C\nentrada'}; assert.ok(unfold(feed(m.category,[m])).includes('LOCATION:Piscina\\, A\\; B\\\\C\\nentrada'));
});
test('snapshot parcial o inconsistente no se publica',()=>{
  assert.throws(()=>validate(matches,{...status,complete:false}));
  assert.throws(()=>validate(matches.slice(1),status));
  assert.throws(()=>validate([...matches,matches[0]],status));
});
test('cambios incrementan SEQUENCE manteniendo UID; generación sin cambios estable',()=>{
  const initial=eventState(matches,{},'20261010T070000Z');
  assert.deepEqual(eventState(matches,initial,'20261010T080000Z'),initial);
  const edited=structuredClone(matches); edited[0].venue='Piscina nueva';
  const next=eventState(edited,initial,'20261010T080000Z');
  assert.equal(next[uid(edited[0])].sequence,1); assert.equal(next[uid(edited[0])].stamp,'20261010T080000Z');
  assert.deepEqual(next[uid(edited[1])],initial[uid(edited[1])]);
});
test('regresión del primer snapshot: 80 partidos',()=>{
  // El control histórico se verifica cuando el snapshot conserva el hash inicial.
  const manifest=JSON.parse(readFileSync(new URL('../calendars/index.json',import.meta.url)));
  if(manifest.snapshot_sha256==='228e8fe83cc1acf87a275f7868e73448be387e419a5ed442ab8c573a83d776aa') assert.equal(manifest.total,80);
});
test('workflow_run genera desde main publicado, sin depender del push de GITHUB_TOKEN',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/calendar-feeds.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_run:/);
  assert.match(workflow,/workflows: \['ActaWP export'\]/);
  assert.match(workflow,/ref: \$\{\{ github.event_name == 'workflow_run' && 'main' \|\| github.ref \}\}/);
  assert.match(workflow,/github.event.workflow_run.conclusion == 'success'/);
});
