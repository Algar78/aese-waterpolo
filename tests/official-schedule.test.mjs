import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {applyOverlay,uid} from '../scripts/calendar-feeds.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('la vista oficial contiene las mismas identidades, horas y piscinas que los nueve feeds',()=>{
 const snapshot=JSON.parse(read('data/actawp_matches.json'));
 const effective=applyOverlay(snapshot,JSON.parse(read('data/actawp_export_status.json')),JSON.parse(read('data/clupik_overlay.json'))).matches;
 const published=JSON.parse(read('calendars/matches.json'));
 assert.equal(published.total,effective.length);
 assert.deepEqual(new Map(published.matches.map(({round_verified,...m})=>[uid(m),m])),new Map(effective.map(m=>[uid(m),m])));
 const manifest=JSON.parse(read('calendars/index.json'));
 for(const c of manifest.categories){
  const text=read('calendars/'+c.slug+'.ics').replace(/\r\n /g,'');
  const rows=published.matches.filter(m=>m.category===c.name);
  assert.equal(rows.length,c.count);
  for(const m of rows) assert.ok(text.includes('UID:'+uid(m)+'\r\n'));
 }
});
test('la entrada de calendario abre los partidos oficiales y se conserva el acceso a partidos guardados',()=>{
 const page=read('index.html');
 assert.match(page,/location.href='mi-calendario.html'.*PARTIDOS \/ CALENDARIO/);
 assert.match(page,/showMatches\(\).*PARTIDOS GUARDADOS/);
 assert.match(read('official-schedule.js'),/cache:'no-store'/);
 assert.match(read('official-schedule.js'),/setInterval/);
 assert.match(read('sw.js'),/pathname.includes\('\/calendars\/'\)/);
});
