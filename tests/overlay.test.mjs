// Los avisos de Clupik que Apps Script aplica al Google Calendar llegan también a los .ics de las familias.
// Lo que no se puede romper: los 9 enlaces y los UID siguen igual, un aviso nunca borra un partido, y sin
// avisos el resultado es byte a byte el de antes.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyOverlay, parseOverlay, generate, feed, eventState, uid, categories, canonicalCategory} from '../scripts/calendar-feeds.mjs';
import {mergeOverlay, plan, run, readSource, sourcePattern, STALE_SCAN_MS} from '../scripts/clupik-overlay.mjs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const snapshot = JSON.parse(read('data/actawp_matches.json'));
const status = JSON.parse(read('data/actawp_export_status.json'));
const venues = JSON.parse(read('data/venues.json'));
const fixtures = ['banyoles', 'mediterrani'].map(n => read('tests/fixtures/' + n + '.html'));
const doc = notices => ({schema_version: 1, notices});
const SNAP = Date.parse(status.last_complete_export_at);
const after = '2026-10-16T06:33:09Z', before = '2026-10-01T06:33:09Z';
const target = snapshot.find(m => m.match_id === 145574486);                       // Cadete Masculino
const noticeFor = (m, extra = {}) => ({tournament_id: m.tournament_id, match_id: m.match_id, category: m.category, home_team: m.home_team,
  away_team: m.away_team, venue: m.venue, round_name: 'Jornada 3', start: m.start, status: 'confirmed', received_at: after, ...extra});

// ---- Generador ------------------------------------------------------------
test('sin avisos el resultado es el del snapshot, partido a partido', () => {
  const out = applyOverlay(snapshot, status, doc([]));
  assert.deepEqual(out.matches, snapshot);
  assert.deepEqual([out.changed, out.added, out.discordant, out.skipped], [[], [], [], []]);
});

test('un aviso posterior a la última lectura cambia hora, sede y estado; el UID no cambia', () => {
  const moved = noticeFor(target, {start: '2026-10-24T15:00:00+02:00', status: 'tentative', venue: '163 - Terrassa C.N.'});
  const out = applyOverlay(snapshot, status, doc([moved]));
  const now = out.matches.find(m => m.match_id === target.match_id);
  assert.equal(now.start, '2026-10-24T15:00:00+02:00');assert.equal(now.status, 'tentative');assert.equal(now.venue, '163 - Terrassa C.N.');
  assert.equal(uid(now), uid(target));assert.equal(now.url, target.url);assert.equal(now.category, target.category);
  assert.equal(now.round_name, 'Jornada 3');
  assert.deepEqual(out.changed, ['1339808:145574486']);
  assert.equal(out.matches.length, snapshot.length);
  assert.equal(out.matches.filter(m => m !== now).every((m, i) => snapshot.includes(m)), true);   // el resto, intacto
});

test('un aviso que ya coincide con ActaWP no cambia nada', () => {
  const out = applyOverlay(snapshot, status, doc([noticeFor(target)]));
  assert.deepEqual(out.changed, []);assert.deepEqual(out.matches, snapshot);
});

test('un campo vacío del aviso no borra lo que ya se sabe', () => {
  const out = applyOverlay(snapshot, status, doc([noticeFor(target, {start: '2026-10-24T15:00:00+02:00', round_name: ''})]));
  assert.equal(out.matches.find(m => m.match_id === target.match_id).round_name, target.round_name);
});

test('misma regla que Apps Script cuando la lectura es posterior al aviso', () => {
  const differs = {start: '2026-10-24T15:00:00+02:00', received_at: before};
  // Posterior y distinta, sin confirmar: se mantiene el aviso y queda constancia para revisarlo.
  let out = applyOverlay(snapshot, status, doc([noticeFor(target, differs)]));
  assert.equal(out.matches.find(m => m.match_id === target.match_id).start, '2026-10-24T15:00:00+02:00');
  assert.deepEqual(out.discordant, ['1339808:145574486']);
  // Una lectura posterior ya la confirmó antes (acknowledged_snapshot) y luego ActaWP avanzó: manda ActaWP.
  out = applyOverlay(snapshot, status, doc([noticeFor(target, {...differs, acknowledged_snapshot: new Date(SNAP - 86400000).toISOString()})]));
  assert.equal(out.matches.find(m => m.match_id === target.match_id).start, target.start);
  assert.deepEqual([out.changed, out.discordant], [[], []]);
  // Posterior e igual: es lo mismo.
  out = applyOverlay(snapshot, status, doc([noticeFor(target, {received_at: before})]));
  assert.deepEqual(out.matches, snapshot);
});

test('un partido nuevo de un torneo que ya se publica se añade; los demás avisos se descartan con su motivo', () => {
  const fresh = noticeFor(target, {match_id: 199999999, home_team: 'C.N. NUEVO', start: '2026-12-05T10:00:00+01:00'});
  const out = applyOverlay(snapshot, status, doc([
    fresh,
    noticeFor(target, {match_id: 188888888, tournament_id: 1200000}),                  // otra temporada, aún guardado en Apps Script
    noticeFor(target, {match_id: 177777777, category: 'Juvenil Masculino'}),            // categoría que ese torneo no publica
    noticeFor(target, {match_id: 166666666, category: 'Categoría inventada'}),
    noticeFor(target, {match_id: 155555555, venue: 'Piscina sin verificar'}),
    noticeFor(target, {match_id: 144444444, start: '2026-12-05 10:00'})
  ]));
  assert.equal(out.matches.length, snapshot.length + 1);
  const added = out.matches.at(-1);
  assert.deepEqual([added.match_id, added.home_team, added.category], [199999999, 'C.N. NUEVO', 'Cadete Masculino']);
  assert.equal(added.url, 'https://actawp.natacio.cat/ca/tournament/1339808/match/199999999/results');
  assert.deepEqual(out.added, ['1339808:199999999']);
  assert.equal(out.skipped.length, 5);
  assert.equal(out.counts['Cadete Masculino'], snapshot.filter(m => m.category === 'Cadete Masculino').length + 1);
});

test('la categoría de Clupik en mayúsculas y con o sin tildes se lee como la categoría canónica; un nombre desconocido se sigue rechazando', () => {
  for (const name of Object.keys(categories)) {
    assert.equal(canonicalCategory(name), name);
    assert.equal(canonicalCategory(name.toLocaleUpperCase('es')), name);
    assert.equal(canonicalCategory(' ' + name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ /g, '  ') + ' '), name);
  }
  assert.equal(canonicalCategory('ALEVÍN MIXTO A'), 'Alevín Mixto A');
  assert.equal(canonicalCategory('Categoría inventada'), 'Categoría inventada');
  const out = parseOverlay(doc([noticeFor(target, {category: 'CADETE MASCULINO'}), noticeFor(target, {match_id: 1, category: 'ALEVÍN MIXTO C'})]));
  assert.deepEqual(out.entries.map(e => e.category), ['Cadete Masculino', 'ALEVÍN MIXTO C']);
});

// Incidente del 28/10/2026: Clupik modificó la fecha de un partido de la 2.ª fase que no está en el snapshot. El aviso llegó con la
// categoría en mayúsculas, el generador lo descartó, el partido «desapareció» y «Clupik overlay» falló en cada pasada.
test('generate(): un partido nuevo ya publicado se actualiza con un aviso que trae la categoría en mayúsculas, sin bloquear los .ics', () => {
  const nuevo = {match_id: 199999999, home_team: 'C.N. NUEVO', start: '2026-12-05T10:00:00+01:00'};
  const dir = tempRepo(doc([noticeFor(target, nuevo)]));
  try {
    generate(root(dir));
    const first = readFileSync(join(dir, 'calendars/cadete-masculino.ics'), 'utf8');
    assert.ok(first.includes('DTSTART:20261205T090000Z') && first.includes('SEQUENCE:0'));
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([noticeFor(target, {...nuevo, category: 'CADETE MASCULINO', start: '2027-01-09T16:00:00+01:00', received_at: '2026-10-28T08:33:12.000Z'})])));
    const manifest = generate(root(dir));
    assert.deepEqual(manifest.clupik_overlay.skipped, []);
    assert.equal(manifest.total, snapshot.length + 1);
    const text = readFileSync(join(dir, 'calendars/cadete-masculino.ics'), 'utf8');
    const event = text.split('BEGIN:VEVENT').find(t => t.includes('UID:actawp-1339808-199999999@aese-waterpolo'));
    assert.ok(event.includes('DTSTART:20270109T150000Z') && !event.includes('DTSTART:20261205'));
    assert.ok(event.includes('SEQUENCE:1'));
    assert.ok(text.includes('X-WR-CALNAME:AESE · Cadete Masculino'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('un aviso defectuoso no impide aplicar los demás; nunca desaparece un partido', () => {
  const other = snapshot.find(m => m.match_id === 145608988);
  const out = applyOverlay(snapshot, status, doc([noticeFor(target, {venue: 'Piscina sin verificar'}), noticeFor(other, {start: '2026-11-22T10:00:00+01:00'}), 'basura', null]));
  assert.equal(out.matches.find(m => m.match_id === other.match_id).start, '2026-11-22T10:00:00+01:00');
  assert.equal(out.matches.find(m => m.match_id === target.match_id).venue, target.venue);
  assert.equal(out.skipped.length, 3);
  assert.deepEqual(snapshot.map(uid).filter(id => !out.matches.map(uid).includes(id)), []);
});

test('un documento que no es el esperado se rechaza entero (se conservan los feeds)', () => {
  for (const bad of [null, {}, {schema_version: 2, notices: []}, {schema_version: 1, notices: 'x'}]) assert.throws(() => applyOverlay(snapshot, status, bad), /inválida/);
});

test('el feed refleja el cambio con la misma identidad y sube SEQUENCE', () => {
  const old = eventState(snapshot, {}, '20261010T000000Z');
  const out = applyOverlay(snapshot, status, doc([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})]));
  const state = eventState(out.matches, old, '20261020T090000Z');
  const text = feed('Cadete Masculino', out.matches, state).replace(/\r\n /g, '');
  const event = text.split('BEGIN:VEVENT').find(e => e.includes(uid(target)));
  assert.match(event, /DTSTART:20261024T130000Z/);assert.match(event, /SEQUENCE:1\r\n/);assert.match(event, /LAST-MODIFIED:20261020T090000Z/);
  const same = text.split('BEGIN:VEVENT').find(e => e.includes(uid(snapshot.find(m => m.category === 'Cadete Masculino' && m !== target))));
  assert.match(same, /SEQUENCE:0\r\n/);
});

// Los .ics de calendars/ ya incluyen los avisos reales que el workflow ha ido guardando en data/clupik_overlay.json.
// Si estas pruebas partieran de ellos, el primer cambio real de Clupik (un partido movido, cancelado o nuevo) las haría
// fallar y el workflow se negaría a publicarlo. Por eso cada prueba parte de una línea base limpia: los 9 .ics y el
// estado salen del snapshot y de un documento de avisos vacío, y después se aplica el documento de la prueba.
function tempRepo(overlay) {
  const dir = mkdtempSync(join(tmpdir(), 'aese-overlay-'));
  cpSync(new URL('../data', import.meta.url), join(dir, 'data'), {recursive: true});
  rmSync(join(dir, 'data/clupik_overlay_source.json'), {force: true});          // cada prueba decide si hay origen configurado
  writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([])));
  const log = console.log; console.log = () => {};
  try { generate(new URL('file://' + dir + '/')); } finally { console.log = log; }
  // El workflow real ya habrá rellenado data/clupik_overlay.json: cada prueba parte de un documento propio.
  writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(overlay === undefined ? doc([]) : overlay));
  return dir;
}
// El estado publicado tal cual está en el repositorio (con sus avisos reales), para comprobar que regenerarlo no cambia nada.
function tempRepoPublished() {
  const dir = mkdtempSync(join(tmpdir(), 'aese-overlay-'));
  for (const sub of ['data', 'calendars']) cpSync(new URL('../' + sub, import.meta.url), join(dir, sub), {recursive: true});
  rmSync(join(dir, 'data/clupik_overlay_source.json'), {force: true});
  return dir;
}
const root = dir => new URL('file://' + dir + '/');
const slugs = Object.values(categories);

test('generate(): regenerar el estado publicado deja los 9 .ics y el estado idénticos byte a byte', () => {
  const dir = tempRepoPublished();
  try {
    const log = console.log; console.log = () => {};
    try { generate(root(dir)); } finally { console.log = log; }
    for (const slug of slugs) assert.equal(readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8'), read(`calendars/${slug}.ics`), slug);
    assert.equal(readFileSync(join(dir, 'calendars/event-state.json'), 'utf8'), read('calendars/event-state.json'));
    assert.equal(readFileSync(join(dir, 'calendars/general-calendar.json'), 'utf8'), read('calendars/general-calendar.json'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('generate(): sin avisos los 9 .ics salen del snapshot y una segunda pasada no cambia nada', () => {
  const dir = tempRepo(doc([]));
  try {
    const first = Object.fromEntries(slugs.map(slug => [slug, readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8')]));
    const state = readFileSync(join(dir, 'calendars/event-state.json'), 'utf8');
    const log = console.log; console.log = () => {};
    try { generate(root(dir)); } finally { console.log = log; }
    for (const slug of slugs) assert.equal(readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8'), first[slug], slug);
    assert.equal(readFileSync(join(dir, 'calendars/event-state.json'), 'utf8'), state);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('generate(): solo cambia el .ics de la categoría afectada; el paquete de Apps Script sigue siendo el snapshot', () => {
  const dir = tempRepo(doc([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})]));
  try {
    const before = Object.fromEntries(slugs.map(slug => [slug, readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8')]));
    const bundle = readFileSync(join(dir, 'calendars/general-calendar.json'), 'utf8');
    const manifest = generate(root(dir));
    const changed = slugs.filter(slug => readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8') !== before[slug]);
    assert.deepEqual(changed, ['cadete-masculino']);
    assert.deepEqual(manifest.clupik_overlay.changed, ['1339808:145574486']);
    assert.equal(manifest.total, snapshot.length);
    assert.equal(readFileSync(join(dir, 'calendars/general-calendar.json'), 'utf8'), bundle);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('generate(): un partido nuevo suma a total y a su categoría; los UID existentes no cambian', () => {
  const dir = tempRepo(doc([noticeFor(target, {match_id: 199999999, home_team: 'C.N. NUEVO', start: '2026-12-05T10:00:00+01:00'})]));
  try {
    const manifest = generate(root(dir));
    assert.equal(manifest.total, snapshot.length + 1);
    assert.equal(manifest.categories.find(c => c.slug === 'cadete-masculino').count, 3);
    const text = readFileSync(join(dir, 'calendars/cadete-masculino.ics'), 'utf8');
    for (const m of snapshot.filter(m => m.category === 'Cadete Masculino')) assert.ok(text.includes('UID:' + uid(m)));
    assert.ok(text.includes('UID:actawp-1339808-199999999@aese-waterpolo'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('generate(): sin fichero de avisos funciona igual', () => {
  const dir = tempRepo();
  try { rmSync(join(dir, 'data/clupik_overlay.json'), {force: true}); assert.equal(generate(root(dir)).total, snapshot.length); }
  finally { rmSync(dir, {recursive: true, force: true}); }
});

// El workflow «Clupik overlay» regenera los .ics y, justo después, pasa estas pruebas. El 23/10/2026 el primer cambio real
// de Clupik las hizo fallar (comparaban con los .ics anteriores) y los .ics dejaron de actualizarse. Esta prueba reproduce
// ese paso con un aviso real ya aplicado y exige que el generador y las pruebas de contrato sigan en verde.
test('con un aviso real ya aplicado, el generador y las pruebas de contrato siguen en verde', {skip: process.env.AESE_META === '1'}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'aese-meta-'));
  try {
    for (const sub of ['data', 'calendars', 'scripts', 'tests']) cpSync(new URL('../' + sub, import.meta.url), join(dir, sub), {recursive: true});
    rmSync(join(dir, 'data/clupik_overlay_source.json'), {force: true});
    const published = JSON.parse(read('data/clupik_overlay.json'));
    const moved = noticeFor(target, {start: '2026-10-24T15:09:00+02:00', received_at: new Date().toISOString()});
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify({...published, notices: [...published.notices.filter(n => n.match_id !== target.match_id), moved]}));
    execFileSync(process.execPath, ['scripts/calendar-feeds.mjs'], {cwd: dir, stdio: 'pipe'});
    execFileSync(process.execPath, ['--test', 'tests/overlay.test.mjs', 'tests/subscriber-contract.test.mjs', 'tests/calendar-feeds.test.mjs'], {cwd: dir, stdio: 'pipe', env: {...process.env, AESE_META: '1'}});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// ---- Apps Script: el punto de lectura ------------------------------------
function appsScript() {
  const properties = new Map(), events = [];
  const props = {deleteProperty: k => properties.delete(k), getProperty: k => properties.get(k) || null, getProperties: () => Object.fromEntries(properties), setProperty: (k, v) => properties.set(k, v)};
  const calendar = {getEvents: () => events, getEventById: id => events.find(e => e.getId() === id), createEvent: (title, start, end, opts) => {
    const v = {title, start, end, description: opts.description, location: opts.location};
    const e = {getId: () => String(events.indexOf(e)), getTitle: () => v.title, getStartTime: () => v.start, getEndTime: () => v.end, getDescription: () => v.description, getLocation: () => v.location,
      setTitle: x => v.title = x, setTime: (s, t) => { v.start = s; v.end = t; }, setDescription: x => v.description = x, setLocation: x => v.location = x};
    events.push(e);return e;
  }};
  const formatDate = (d, z, pattern) => {
    const p = new Intl.DateTimeFormat('sv-SE', {timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(d).replace(' ', 'T');
    if (pattern === 'HH:mm') return p.slice(11, 16);
    if (pattern.endsWith('XXX')) { const offset = (Date.parse(p + 'Z') - d.getTime()) / 60000; return p + (offset === 120 ? '+02:00' : '+01:00'); }
    return pattern.endsWith('HH:mm') ? p.slice(0, 16) : p;
  };
  const served = [];
  const c = vm.createContext({Date, console: {log() {}}, Logger: {log() {}}, Utilities: {formatDate},
    PropertiesService: {getScriptProperties: () => props}, CalendarApp: {getCalendarById: () => calendar},
    MailApp: {sendEmail() {}}, LockService: {getScriptLock: () => ({tryLock() { return true; }, waitLock() {}, releaseLock() {}})},
    ContentService: {MimeType: {JSON: 'JSON'}, createTextOutput: text => { const out = {text, mime: null, setMimeType(m) { out.mime = m; return out; }}; served.push(out); return out; }},
    UrlFetchApp: {fetch: () => ({getResponseCode: () => 200, getContentText: () => JSON.stringify({schema_version: 1, matches: snapshot, status, venues})})}});
  for (const file of ['calendar_offline_bundle.gs', 'actawp_calendar_sync.gs', 'clupik_calendar_sync.gs', 'calendar_reliability.gs', 'clupik_overlay_endpoint.gs']) vm.runInContext(read(file), c);
  vm.runInContext('ACTAWP_VENUES = ' + JSON.stringify(venues), c);
  const msg = (i, subject, at, html = fixtures[i]) => ({getBody: () => html, getSubject: () => subject, getDate: () => new Date(at), getId: () => at, getFrom: () => 'FCN <no-reply@clupik.com>'});
  return {c, calendar, properties, served, msg};
}

test('de un correo de Clupik al .ics: el aviso real llega al feed por el punto de lectura', () => {
  const h = appsScript();
  h.c.procesarMensajeAESE_(h.msg(0, 'Modificado un partido', '2026-10-17T10:00:00Z', fixtures[0].replace('13:00', '15:00')), h.calendar);
  h.properties.set('AESE_CLUPIK_LAST_SUCCESS', '2026-10-20T08:00:00.000Z');
  h.c.doGet();
  const out = h.served.at(-1);
  assert.equal(out.mime, 'JSON');
  const published = JSON.parse(out.text);
  assert.equal(published.schema_version, 1);assert.equal(published.clupik_last_success, '2026-10-20T08:00:00.000Z');
  assert.equal(published.notices.length, 1);
  const parsed = parseOverlay(published);
  assert.deepEqual(parsed.rejected, []);
  const effective = applyOverlay(snapshot, status, published);
  assert.equal(effective.matches.find(m => m.match_id === 145574486).start, '2026-10-24T15:00:00+02:00');
  assert.deepEqual(effective.changed, ['1339808:145574486']);
});

test('el punto de lectura solo publica datos del partido: nunca correos, remitentes ni identificadores de mensaje', () => {
  const h = appsScript();
  h.c.procesarMensajeAESE_(h.msg(0, 'Modificado un partido', '2026-10-17T10:00:00Z'), h.calendar);
  const key = [...h.properties.keys()].find(k => k.startsWith('AESE_NOTICE_'));
  const stored = JSON.parse(h.properties.get(key));
  assert.ok(stored.message_id && stored.url, 'el aviso guardado sí lleva más datos');
  h.properties.set('AESE_NOTICE_1:2', JSON.stringify({tournament_id: 1, match_id: 2, undated: true, home_team: 'A', away_team: 'B'}));                         // sin fecha
  h.properties.set('AESE_NOTICE_3:4', JSON.stringify({...stored, tournament_id: 9, match_id: 9}));                                                              // clave que no cuadra
  h.properties.set('AESE_NOTICE_5:6', JSON.stringify({...stored, tournament_id: 5, match_id: 6, home_team: 'línea 1\nlínea 2'}));                              // campo raro
  h.properties.set('AESE_NOTICE_7:8', '{no es json');
  h.properties.set('AESE_ALERT_algo', '123');h.properties.set('ULTIMA_EJECUCION', '2026-10-20T00:00:00Z');
  const text = h.c.aeseOverlayDocument_(h.c.PropertiesService.getScriptProperties(), Date.parse('2026-10-20T09:00:00Z'));
  const json = JSON.stringify(text);
  assert.equal(text.notices.length, 1);
  assert.deepEqual(Object.keys(text.notices[0]).sort(), ['away_team', 'category', 'home_team', 'match_id', 'received_at', 'round_name', 'start', 'status', 'tournament_id', 'venue'].sort());
  assert.doesNotMatch(json, /message_id|no-reply|@|clupik\.com|https?:|algarri|AESE_ALERT|ULTIMA_EJECUCION/i);
  assert.equal(text.generated_at, '2026-10-20T09:00:00.000Z');
});

test('el punto de lectura no escribe nada ni toca el Calendar', () => {
  const h = appsScript();
  h.c.procesarMensajeAESE_(h.msg(0, 'Modificado un partido', '2026-10-17T10:00:00Z'), h.calendar);
  const before = JSON.stringify([...h.properties]);
  h.calendar.createEvent = () => { throw Error('no debe escribir'); };
  h.c.doGet();
  assert.equal(JSON.stringify([...h.properties]), before);
});

// ---- Lectura desde GitHub ----------------------------------------------------
const URL_OK = 'https://script.google.com/macros/s/AKfycbxEXAMPLEEXAMPLEEXAMPLE0123/exec';
const NOW = Date.parse('2026-10-20T10:00:00Z');
const fetched = (notices, extra = {}, at = NOW) => ({schema_version: 1, generated_at: new Date(at - 60000).toISOString(), clupik_last_success: new Date(at - 600000).toISOString(), notices, ...extra});

test('la fusión solo añade o actualiza con un aviso más reciente: nunca borra', () => {
  const a = noticeFor(target, {start: '2026-10-24T15:00:00+02:00'});
  const other = snapshot.find(m => m.match_id === 145608988), b = noticeFor(other);
  const merged = mergeOverlay(doc([a, b]), fetched([]));
  assert.equal(merged.notices.length, 2);                                                        // Apps Script perdió los datos: seguimos con los guardados
  const newer = {...a, start: '2026-10-24T16:00:00+02:00', received_at: '2026-10-18T10:00:00Z'};
  assert.equal(mergeOverlay(doc([a, b]), fetched([newer])).notices.find(n => n.match_id === a.match_id).start, newer.start);
  const older = {...a, start: '2026-10-24T11:00:00+02:00', received_at: '2026-10-10T10:00:00Z'};
  assert.equal(mergeOverlay(doc([a, b]), fetched([older])).notices.find(n => n.match_id === a.match_id).start, a.start);
});

test('plan: respuesta antigua, lectura de correo parada y cuándo se escribe o se avisa', () => {
  const stored = doc([]);
  assert.throws(() => plan({current: stored, fetched: fetched([], {generated_at: new Date(NOW - 7200000).toISOString()}), now: NOW}), /no es reciente/);
  assert.throws(() => plan({current: stored, fetched: {...fetched([]), generated_at: undefined}, now: NOW}), /no es reciente/);
  let p = plan({current: stored, fetched: fetched([]), now: NOW});
  assert.deepEqual([p.changed, p.stale, p.alert, p.write], [false, false, false, true]);          // primera vez: deja constancia
  const checked = {...p.document};
  p = plan({current: checked, fetched: fetched([], {}, NOW + 1800000), now: NOW + 1800000});
  assert.deepEqual([p.changed, p.write], [false, false]);                                         // sin cambios no se reescribe nada
  p = plan({current: checked, fetched: fetched([], {}, NOW + 6 * 86400000), now: NOW + 6 * 86400000});
  assert.equal(p.write, true);                                                                    // como mucho cada 5 días, para mantener activo el workflow
  p = plan({current: checked, fetched: fetched([noticeFor(target)]), now: NOW});
  assert.deepEqual([p.changed, p.write], [true, true]);
  // «Parada» = Apps Script lleva más de 6 h sin terminar una lectura del correo. Solo se avisa (con un
  // workflow en rojo, que GitHub envía por correo) en la primera media hora de cada bloque de 6 h UTC.
  const at = iso => Date.parse(iso);
  const stopped = iso => plan({current: checked, fetched: fetched([], {clupik_last_success: new Date(at(iso) - STALE_SCAN_MS - 60000).toISOString()}, at(iso)), now: at(iso)});
  assert.deepEqual([stopped('2026-10-20T12:10:00Z').stale, stopped('2026-10-20T12:10:00Z').alert], [true, true]);
  assert.deepEqual([stopped('2026-10-20T12:40:00Z').stale, stopped('2026-10-20T12:40:00Z').alert], [true, false]);
  assert.deepEqual([stopped('2026-10-20T13:10:00Z').stale, stopped('2026-10-20T13:10:00Z').alert], [true, false]);
  const never = plan({current: checked, fetched: fetched([], {clupik_last_success: null}, at('2026-10-20T18:07:00Z')), now: at('2026-10-20T18:07:00Z')});
  assert.deepEqual([never.stale, never.alert], [true, true]);
  const fine = plan({current: checked, fetched: fetched([], {}, at('2026-10-20T18:07:00Z')), now: at('2026-10-20T18:07:00Z')});
  assert.deepEqual([fine.stale, fine.alert], [false, false]);
});

test('run(): sin fichero de origen no hace nada; con él escribe solo si hay algo que guardar', async () => {
  const dir = tempRepo();
  try {
    const lines = [];
    assert.equal((await run({root: root(dir), now: NOW, log: x => lines.push(x), fetchImpl: () => { throw Error('no debe pedir nada'); }})).configured, false);
    writeFileSync(join(dir, 'data/clupik_overlay_source.json'), JSON.stringify({url: URL_OK}));
    const calls = [];
    const fetchImpl = async url => { calls.push(url); return {ok: true, status: 200, text: async () => JSON.stringify(fetched([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})]))}; };
    const result = await run({root: root(dir), now: NOW, log: x => lines.push(x), fetchImpl});
    assert.deepEqual([result.configured, result.changed, result.alert], [true, true, false]);
    assert.deepEqual(calls, [URL_OK]);
    const saved = JSON.parse(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8'));
    assert.equal(saved.notices.length, 1);assert.equal(saved.checked_at, new Date(NOW).toISOString());
    const again = await run({root: root(dir), now: NOW + 1800000, log: x => lines.push(x), fetchImpl: async () => ({ok: true, status: 200, text: async () => JSON.stringify(fetched([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})], {}, NOW + 1800000))})});
    assert.equal(again.changed, false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8')).checked_at, new Date(NOW).toISOString());
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('run(): una respuesta mala no toca el fichero guardado', async () => {
  const dir = tempRepo(doc([noticeFor(target)]));
  try {
    writeFileSync(join(dir, 'data/clupik_overlay_source.json'), JSON.stringify({url: URL_OK}));
    const before = readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8');
    for (const body of ['<html>Inicia sesión</html>', 'no json', JSON.stringify({schema_version: 7, generated_at: new Date(NOW).toISOString(), notices: []}), JSON.stringify(fetched([], {generated_at: '2020-01-01T00:00:00Z'}))]) {
      await assert.rejects(run({root: root(dir), now: NOW, log() {}, fetchImpl: async () => ({ok: true, status: 200, text: async () => body})}));
      assert.equal(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8'), before);
    }
    let tries = 0;
    await assert.rejects(run({root: root(dir), now: NOW, log() {}, wait: async () => {}, fetchImpl: async () => { tries++; return {ok: false, status: 500, text: async () => 'error'}; }}), /tras 3 intentos: Apps Script respondió HTTP 500/);
    assert.equal(tries, 3);
    tries = 0;                                                                                 // un fallo pasajero se recupera sin avisar a nadie
    const flaky = await run({root: root(dir), now: NOW, log() {}, wait: async () => {}, fetchImpl: async () => (++tries < 3 ? {ok: false, status: 503, text: async () => 'busy'} : {ok: true, status: 200, text: async () => JSON.stringify(fetched([noticeFor(target)]))})});
    assert.equal(flaky.configured, true);assert.equal(tries, 3);
    writeFileSync(join(dir, 'data/clupik_overlay.json'), before);
    assert.equal(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8'), before);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('solo se acepta una aplicación web de script.google.com como origen', async () => {
  assert.ok(sourcePattern.test(URL_OK));
  for (const bad of ['http://script.google.com/macros/s/AKfycbxEXAMPLEEXAMPLEEXAMPLE0123/exec', 'https://evil.test/macros/s/AKfycbxEXAMPLEEXAMPLEEXAMPLE0123/exec',
    'https://script.google.com/macros/s/AKfycbxEXAMPLEEXAMPLEEXAMPLE0123/exec?x=1', 'https://script.google.com/macros/s/corto/exec', 'https://script.google.com.evil.test/macros/s/AKfycbxEXAMPLEEXAMPLEEXAMPLE0123/exec']) {
    const dir = tempRepo();
    try { writeFileSync(join(dir, 'data/clupik_overlay_source.json'), JSON.stringify({url: bad})); await assert.rejects(readSource(root(dir), () => { throw Error('no debe pedir nada'); }), /script\.google\.com/); }
    finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('el workflow comparte grupo con «Calendarios de familias», no fuerza el push y no se activa solo sin origen', () => {
  const yml = read('.github/workflows/clupik-overlay.yml'), feeds = read('.github/workflows/calendar-feeds.yml');
  assert.ok(feeds.includes('group: family-calendar-${{ github.ref }}'));
  assert.ok(yml.includes('group: family-calendar-refs/heads/main'));
  assert.ok(!/--force|-f origin/.test(yml));
  assert.ok(yml.includes("cron: '7,37 * * * *'"));
  assert.ok(yml.includes("steps.read.outputs.changed == 'true'"));
  assert.ok(JSON.parse(read('data/clupik_overlay.json')).notices.every(n => n.match_id));
});
