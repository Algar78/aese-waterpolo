// What people who already subscribed rely on. If one of these fails, a change
// would reach them as a broken or duplicated calendar: do not "fix" the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync, existsSync} from 'node:fs';
import {applyOverlay} from '../scripts/calendar-feeds.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const json=p=>JSON.parse(read(p));
const matches=json('data/actawp_matches.json'), index=json('calendars/index.json'), bundle=json('calendars/general-calendar.json');
// Lo que publican los .ics: el snapshot de ActaWP más los avisos de Clupik (data/clupik_overlay.json).
const effective=applyOverlay(matches,bundle.status,json('data/clupik_overlay.json')).matches;
const BASE='https://algar78.github.io/aese-waterpolo/';
// Written down on 2026-10-18 from what was published then. Adding to this is fine; changing or removing is not.
const FEEDS={'Absoluto Masculino':'absoluto-masculino','Alevín Mixto A':'alevin-mixto-a','Alevín Mixto B':'alevin-mixto-b','Cadete Masculino':'cadete-masculino',
  'Infantil Mixto A':'infantil-mixto-a','Infantil Mixto B':'infantil-mixto-b','Juvenil Femenino':'juvenil-femenino','1a Div Fem Absoluta B':'absoluta-femenina-b','Juvenil Masculino':'juvenil-masculino'};

test('las 9 direcciones de suscripción siguen existiendo y no cambian',()=>{
  assert.equal(index.categories.length,9);
  for(const [name,slug] of Object.entries(FEEDS)) {
    const entry=index.categories.find(c=>c.name===name);
    assert.ok(entry,name);assert.equal(entry.slug,slug);assert.equal(entry.url,BASE+'calendars/'+slug+'.ics');
    assert.ok(existsSync(new URL('../calendars/'+slug+'.ics',import.meta.url)),slug+'.ics');
    assert.equal(entry.count,effective.filter(m=>m.category===name).length);
  }
  for(const key of ['source','snapshot_sha256','total','timeZone','categories']) assert.ok(key in index,'index.json perdió '+key);
  assert.equal(index.timeZone,'Europe/Madrid');
  assert.deepEqual(Object.keys(bundle).slice(0,4),['schema_version','matches','status','venues']);   // formato que lee Apps Script
  assert.equal(bundle.schema_version,1);
});
test('cada evento de cada .ics conserva su UID y su cabecera; no hay UID repetidos ni huérfanos',()=>{
  const uids=[];
  for(const [name,slug] of Object.entries(FEEDS)) {
    const text=read('calendars/'+slug+'.ics').replace(/\r\n /g,'');
    assert.match(text,/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/AESE Waterpolo\/\/Calendarios familias\/\/ES\r\n/);
    assert.ok(text.includes('X-WR-CALNAME:AESE · '+name));
    assert.ok(text.includes('X-WR-TIMEZONE:Europe/Madrid'));
    for(const m of text.matchAll(/^UID:(.+)$/gm)) uids.push(m[1]);
  }
  assert.equal(uids.length,effective.length);assert.equal(new Set(uids).size,uids.length);
  assert.deepEqual([...uids].sort(),effective.map(m=>`actawp-${m.tournament_id}-${m.match_id}@aese-waterpolo`).sort());
  // Los avisos de Clupik nunca quitan un partido que ya estaba: todos los del snapshot siguen.
  for(const m of matches) assert.ok(uids.includes(`actawp-${m.tournament_id}-${m.match_id}@aese-waterpolo`));
});
test('los campos nuevos del paquete publicado son solo añadidos',()=>{
  const status=bundle.status;
  for(const key of ['complete','errors','categories_expected','counts','total_matches_found','snapshot_sha256']) assert.ok(key in status,'status perdió '+key);
  assert.equal(status.complete,true);assert.deepEqual(status.errors,[]);
  for(const m of matches) for(const key of ['tournament_id','match_id','category','start','home_team','away_team','venue','round_name','url']) assert.ok(key in m,key);
});

function harness(published){
  const properties=new Map(),events=[],mail=[];
  const props={deleteProperty:k=>properties.delete(k),getProperty:k=>properties.get(k)||null,getProperties:()=>Object.fromEntries(properties),setProperty:(k,v)=>properties.set(k,v)};
  const calendar={getEvents:()=>events,getEventById:id=>events.find(e=>e.getId()===id),createEvent:(title,start,end,opts)=>{
    const v={title,start,end,description:opts.description,location:opts.location};
    const e={getId:()=>String(events.indexOf(e)),getTitle:()=>v.title,getStartTime:()=>v.start,getEndTime:()=>v.end,getDescription:()=>v.description,getLocation:()=>v.location,
      setTitle:x=>v.title=x,setTime:(s,e)=>{v.start=s;v.end=e},setDescription:x=>v.description=x,setLocation:x=>v.location=x};events.push(e);return e;}};
  const formatDate=(d,z,pattern)=>{
    const p=new Intl.DateTimeFormat('sv-SE',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(d).replace(' ','T');
    if(pattern==='HH:mm')return p.slice(11,16);
    if(pattern.endsWith('XXX')){const offset=(Date.parse(p+'Z')-d.getTime())/60000;return p+(offset===120?'+02:00':'+01:00');}
    return pattern.endsWith('HH:mm')?p.slice(0,16):p;};
  const c=vm.createContext({Date,console:{log(){}},Logger:{log(){}},Utilities:{formatDate},
    PropertiesService:{getScriptProperties:()=>props},CalendarApp:{getCalendarById:()=>calendar},
    MailApp:{sendEmail:(...x)=>mail.push(x)},LockService:{getScriptLock:()=>({tryLock(){return true},waitLock(){},releaseLock(){}})},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(published)})},GmailApp:{search:()=>[]}});
  for(const f of ['calendar_offline_bundle.gs','actawp_calendar_sync.gs','clupik_calendar_sync.gs','calendar_reliability.gs'])vm.runInContext(read(f),c);
  return {c,events,mail};
}
const sync=h=>{let r;for(let i=0;i<30;i++){r=h.c.syncActaWPToCalendar();if(r.status==='complete')break;}return r;};
const snapshotOf=h=>h.events.map(e=>[(e.getDescription().match(/ACTAWP_MATCH_ID:(\d+:\d+)/)||[])[1],e.getTitle(),e.getStartTime().toISOString(),e.getEndTime().toISOString(),e.getLocation(),e.getDescription()])
  .sort((a,b)=>String(a[0]).localeCompare(String(b[0])));

test('Apps Script: 80 eventos, uno por partido, con su marca de identidad, y repetir no duplica',()=>{
  const h=harness(bundle);assert.equal(sync(h).status,'complete');
  assert.equal(h.events.length,matches.length);
  const ids=h.events.map(e=>e.getDescription().match(/ACTAWP_MATCH_ID:(\d+:\d+)/)[1]);
  assert.deepEqual([...ids].sort(),matches.map(m=>`${m.tournament_id}:${m.match_id}`).sort());
  const before=snapshotOf(h);sync(h);sync(h);
  assert.equal(h.events.length,matches.length);assert.deepEqual(snapshotOf(h),before);
  assert.equal(h.events.every(e=>e.getEndTime()-e.getStartTime()===90*60000),true);
});
test('Apps Script nuevo con el paquete en el formato anterior (sin los campos añadidos) produce el mismo calendario',()=>{
  const previous=structuredClone(bundle);
  for(const key of ['last_complete_export_at','last_complete_export_provenance','freshness_policy','pending_matches','source']) delete previous.status[key];
  const a=harness(previous),b=harness(bundle);sync(a);sync(b);
  assert.deepEqual(snapshotOf(a),snapshotOf(b));
  assert.equal(a.mail.length,0);assert.equal(b.mail.length,0);
});
test('un evento que ya existe se actualiza en su sitio: mismo ID, ningún duplicado',()=>{
  const h=harness(bundle);sync(h);
  const target=h.events.find(e=>e.getDescription().includes('ACTAWP_MATCH_ID:1339808:145574486'));
  const id=target.getId(),original=target.getStartTime().toISOString();
  const moved=structuredClone(bundle);
  const m=moved.matches.find(x=>x.match_id===145574486);m.start='2026-10-24T14:30:00+02:00';
  h.c.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(moved)});
  sync(h);
  assert.equal(h.events.length,matches.length);
  const after=h.events.find(e=>e.getId()===id);
  assert.ok(after.getDescription().includes('ACTAWP_MATCH_ID:1339808:145574486'));
  assert.notEqual(after.getStartTime().toISOString(),original);
  assert.equal(after.getStartTime().toISOString(),'2026-10-24T12:30:00.000Z');
});
