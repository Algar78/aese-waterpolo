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
import {applyOverlay, parseOverlay, generate, feed, eventState, uid, categories, canonicalCategory, validate, readMemory} from '../scripts/calendar-feeds.mjs';
import {mergeOverlay, plan, run, readSource, sourcePattern, STALE_SCAN_MS, attentionAlert, report} from '../scripts/clupik-overlay.mjs';

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
  // La sede sin verificar (155555555) no retrasa el partido: entra igual, y solo falta el enlace de Maps.
  assert.equal(out.matches.length, snapshot.length + 2);
  const added = out.matches.at(-2);
  assert.deepEqual([added.match_id, added.home_team, added.category], [199999999, 'C.N. NUEVO', 'Cadete Masculino']);
  assert.equal(added.url, 'https://actawp.natacio.cat/ca/tournament/1339808/match/199999999/results');
  assert.deepEqual(out.added, ['1339808:199999999', '1339808:155555555']);
  assert.equal(out.matches.at(-1).venue, 'Piscina sin verificar');
  assert.equal(out.skipped.length, 4);
  assert.equal(out.counts['Cadete Masculino'], snapshot.filter(m => m.category === 'Cadete Masculino').length + 2);
});

test('una sede sin verificar se publica con su nombre y sin enlace de Maps; al verificarla, el evento se actualiza', () => {
  const nueva = noticeFor(target, {match_id: 155555555, venue: 'Piscina sin verificar', start: '2026-12-05T10:00:00+01:00'});
  const out = applyOverlay(snapshot, status, doc([nueva]));
  const m = out.matches.find(x => x.match_id === 155555555);
  const state = eventState(out.matches);
  const text = feed('Cadete Masculino', out.matches, state).replace(/\r\n /g, '');
  const event = text.split('BEGIN:VEVENT').find(t => t.includes('UID:' + uid(m) + '\r\n'));
  assert.ok(event.includes('\r\nLOCATION:Piscina sin verificar\r\n'));
  assert.ok(event.includes('\r\nDTSTART:20261205T090000Z\r\n'));
  assert.ok(!event.includes('Google Maps'));
  // Los partidos con sede verificada siguen con su enlace y su versión: el cambio no toca ningún evento existente.
  assert.equal(text.split('BEGIN:VEVENT').filter(t => t.includes('Google Maps: ')).length, out.matches.filter(x => x.category === 'Cadete Masculino').length - 1);
  assert.deepEqual(eventState(snapshot), eventState(out.matches.filter(x => snapshot.includes(x))));
  // Un partido del snapshot que cambia a una sede nueva se actualiza (antes se quedaba con la sede antigua).
  const moved = applyOverlay(snapshot, status, doc([noticeFor(target, {venue: 'Piscina sin verificar'})]));
  assert.equal(moved.matches.find(x => x.match_id === target.match_id).venue, 'Piscina sin verificar');
  assert.deepEqual(moved.changed, [target.tournament_id + ':' + target.match_id]);
  // El snapshot de ActaWP sigue exigiendo sede verificada.
  assert.throws(() => validate(snapshot.map((m, i) => i === 0 ? {...m, venue: 'Piscina sin verificar'} : m), status), /Sede pendiente de verificar/);
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
  const out = applyOverlay(snapshot, status, doc([noticeFor(target, {home_team: ''}), noticeFor(other, {start: '2026-11-22T10:00:00+01:00'}), 'basura', null]));
  assert.equal(out.matches.find(m => m.match_id === other.match_id).start, '2026-11-22T10:00:00+01:00');
  assert.equal(out.matches.find(m => m.match_id === target.match_id).home_team, target.home_team);
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
    assert.equal(readFileSync(join(dir, 'calendars/clupik-published.json'), 'utf8'), read('calendars/clupik-published.json'));
    assert.equal(readFileSync(join(dir, 'calendars/index.json'), 'utf8'), read('calendars/index.json'));
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
  // «Parada» = Apps Script lleva más de 6 h sin terminar una lectura del correo. Se avisa (con un workflow en rojo, que GitHub
  // envía por correo) en la primera pasada en que se ve y después como mucho cada 6 h, a la hora que GitHub lance la pasada:
  // cuándo se avisó por última vez queda anotado en el fichero (`stale_alerted_at`), no en una ventana horaria.
  const at = iso => Date.parse(iso);
  const stoppedAt = (iso, current = checked) => plan({current, fetched: fetched([], {clupik_last_success: new Date(at(iso) - STALE_SCAN_MS - 60000).toISOString()}, at(iso)), now: at(iso)});
  const first = stoppedAt('2026-10-20T12:41:00Z');                                                // una hora «rara», fuera de cualquier ventana fija
  assert.deepEqual([first.stale, first.alert, first.write, first.document.stale_alerted_at], [true, true, true, '2026-10-20T12:41:00.000Z']);
  const second = stoppedAt('2026-10-20T15:52:00Z', first.document);                               // GitHub vuelve 3 h después: ya se avisó
  assert.deepEqual([second.stale, second.alert, second.write, second.document.stale_alerted_at], [true, false, false, '2026-10-20T12:41:00.000Z']);
  const almost = stoppedAt('2026-10-20T18:40:00Z', first.document);                               // 5 h 59 min después: todavía no
  assert.deepEqual([almost.alert, almost.write], [false, false]);
  const again = stoppedAt('2026-10-20T18:41:00Z', first.document);                                // 6 h después: recordatorio, y se anota
  assert.deepEqual([again.alert, again.write, again.document.stale_alerted_at], [true, true, '2026-10-20T18:41:00.000Z']);
  const never = plan({current: checked, fetched: fetched([], {clupik_last_success: null}, at('2026-10-20T18:07:00Z')), now: at('2026-10-20T18:07:00Z')});
  assert.deepEqual([never.stale, never.alert], [true, true]);
  const fine = plan({current: checked, fetched: fetched([], {}, at('2026-10-20T18:07:00Z')), now: at('2026-10-20T18:07:00Z')});
  assert.deepEqual([fine.stale, fine.alert, fine.write, 'stale_alerted_at' in fine.document], [false, false, false, false]);
  // Cuando Apps Script se recupera, la marca se borra (una escritura) y el siguiente problema vuelve a avisar en seguida.
  const healed = plan({current: again.document, fetched: fetched([], {}, at('2026-10-20T19:07:00Z')), now: at('2026-10-20T19:07:00Z')});
  assert.deepEqual([healed.stale, healed.alert, healed.write, 'stale_alerted_at' in healed.document], [false, false, true, false]);
  const relapse = stoppedAt('2026-10-21T03:20:00Z', healed.document);
  assert.deepEqual([relapse.alert, relapse.document.stale_alerted_at], [true, '2026-10-21T03:20:00.000Z']);
  // Una marca ilegible o del futuro no silencia el aviso.
  for (const broken of ['no es una fecha', '2030-01-01T00:00:00.000Z', 42]) {
    const p2 = stoppedAt('2026-10-20T12:41:00Z', {...checked, stale_alerted_at: broken});
    assert.deepEqual([p2.alert, p2.write, p2.document.stale_alerted_at], [true, true, '2026-10-20T12:41:00.000Z']);
  }
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
    // Apps Script parado: la primera pasada avisa y deja anotado cuándo; la siguiente (3 h después) no repite; a las 6 h, recordatorio.
    const stoppedAt = at => async () => ({ok: true, status: 200, text: async () => JSON.stringify(fetched([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})], {clupik_last_success: new Date(at - STALE_SCAN_MS - 60000).toISOString()}, at))});
    const saved1 = () => JSON.parse(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8'));
    const t1 = NOW + 7 * 3600000 + 13 * 60000;                                                           // una hora cualquiera, no «en punto»
    const s1 = await run({root: root(dir), now: t1, log: x => lines.push(x), fetchImpl: stoppedAt(t1)});
    assert.deepEqual([s1.stale, s1.alert], [true, true]);assert.equal(saved1().stale_alerted_at, new Date(t1).toISOString());
    const s2 = await run({root: root(dir), now: t1 + 3 * 3600000, log: x => lines.push(x), fetchImpl: stoppedAt(t1 + 3 * 3600000)});
    assert.deepEqual([s2.stale, s2.alert], [true, false]);assert.equal(saved1().stale_alerted_at, new Date(t1).toISOString());
    const s3 = await run({root: root(dir), now: t1 + 6 * 3600000, log: x => lines.push(x), fetchImpl: stoppedAt(t1 + 6 * 3600000)});
    assert.deepEqual([s3.stale, s3.alert], [true, true]);assert.equal(saved1().stale_alerted_at, new Date(t1 + 6 * 3600000).toISOString());
    const t4 = t1 + 7 * 3600000;                                                                          // Apps Script se recupera: se borra la marca
    const s4 = await run({root: root(dir), now: t4, log: x => lines.push(x), fetchImpl: async () => ({ok: true, status: 200, text: async () => JSON.stringify(fetched([noticeFor(target, {start: '2026-10-24T15:00:00+02:00'})], {}, t4))})});
    assert.deepEqual([s4.stale, s4.alert], [false, false]);assert.equal('stale_alerted_at' in saved1(), false);
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
  assert.ok(yml.includes("steps.read.outputs.regenerate == 'true'"));
  assert.ok(JSON.parse(read('data/clupik_overlay.json')).notices.every(n => n.match_id));
});

test('el workflow regenera mientras haya algo pendiente, avisa después de publicar y publica también la copia de partidos', () => {
  const yml = read('.github/workflows/clupik-overlay.yml');
  const steps = yml.split('\n      - ').map(t => t.split('\n')[0]);
  const at = text => steps.findIndex(t => t.includes(text));
  assert.ok(at('Publicar si ha cambiado algo') >= 0 && at('Publicar si ha cambiado algo') < at('Avisar si hay avisos de Clupik que no se han podido aplicar'));   // primero se publica, luego se avisa
  assert.ok(yml.includes('run: node scripts/clupik-overlay.mjs --report'));
  assert.ok(yml.includes("git add data/clupik_overlay.json calendars/"));                               // incluye calendars/clupik-published.json
  assert.ok(yml.includes("if: ${{ !cancelled() && steps.read.outputs.alert == 'true' }}"));            // un aviso en rojo no oculta el otro
});

// ---- Un aviso que deja de valer no congela los .ics (28/10/2026) -------------------------------------
// Aquel día un aviso de un partido ya publicado dejó de ser válido, el partido «desapareció» y el generador se negó a publicar
// durante horas. Ahora el partido conserva su última versión, los demás avisos se aplican y el problema queda a la vista.
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const nuevo = {match_id: 199999999, home_team: 'C.N. NUEVO', start: '2026-12-05T10:00:00+01:00'};
const otro = snapshot.find(m => m.match_id === 145608988), otroSlug = categories[otro.category], otroId = `${otro.tournament_id}:${otro.match_id}`;   // Alevín Mixto B
const icsOf = (dir, slug) => readFileSync(join(dir, `calendars/${slug}.ics`), 'utf8');
const eventOf = (dir, slug, id) => icsOf(dir, slug).split('BEGIN:VEVENT').find(t => t.includes(`UID:${id}@aese-waterpolo`));
const T1 = new Date('2026-10-28T12:00:00Z'), T2 = new Date('2026-10-28T13:00:00Z'), T3 = new Date('2026-10-28T15:00:00Z');
const roto = {...nuevo, category: 'Categoría inventada', start: '2027-01-09T16:00:00+01:00', received_at: '2026-10-28T11:00:00.000Z'};

test('un aviso que deja de ser válido no congela los .ics: el partido conserva su última versión, los demás se actualizan y queda constancia', () => {
  const dir = tempRepo(doc([noticeFor(target, nuevo)]));
  try {
    quiet(() => generate(root(dir), new Date('2026-10-28T10:00:00Z')));
    const before = eventOf(dir, 'cadete-masculino', 'actawp-1339808-199999999');
    assert.ok(before.includes('DTSTART:20261205T090000Z') && before.includes('SEQUENCE:0'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'calendars/clupik-published.json'), 'utf8')).matches.map(m => m.match_id), [nuevo.match_id]);
    // Llega un aviso más reciente que no se puede aplicar y, a la vez, un cambio válido de otro partido.
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([noticeFor(target, roto), noticeFor(otro, {start: '2026-11-22T10:00:00+01:00'})])));
    const manifest = quiet(() => generate(root(dir), T1));
    assert.equal(eventOf(dir, 'cadete-masculino', 'actawp-1339808-199999999'), before);                  // ni fecha ni SEQUENCE ni marcas inventadas
    const moved = eventOf(dir, otroSlug, uid(otro).replace('@aese-waterpolo', ''));
    assert.ok(moved.includes('DTSTART:20261122T090000Z') && moved.includes('SEQUENCE:1'));               // el resto sigue su curso
    assert.equal(manifest.total, snapshot.length + 1);
    assert.deepEqual(manifest.clupik_overlay.retained, [{identity: '1339808:199999999', reason: 'categoría que el snapshot no publica en este torneo'}]);
    assert.deepEqual(manifest.clupik_overlay.attention, [{kind: 'partido-retenido', identity: '1339808:199999999', reason: 'categoría que el snapshot no publica en este torneo', first_seen: T1.toISOString()}]);
    assert.deepEqual(manifest.clupik_overlay.skipped.map(x => x.kind), ['no-valido']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'calendars/clupik-published.json'), 'utf8')).matches.map(m => m.start), [nuevo.start]);   // la copia sigue siendo la última publicada
    // Mientras siga sin resolverse, otra pasada no cambia ni los .ics ni la fecha en que se vio por primera vez.
    const files = Object.fromEntries(slugs.map(slug => [slug, icsOf(dir, slug)]));
    const again = quiet(() => generate(root(dir), T2));
    for (const slug of slugs) assert.equal(icsOf(dir, slug), files[slug], slug);
    assert.equal(again.clupik_overlay.attention[0].first_seen, T1.toISOString());
    // Se arregla solo: llega un aviso válido más reciente.
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([noticeFor(target, {...nuevo, start: '2027-01-09T16:00:00+01:00', received_at: '2026-10-28T14:00:00.000Z'}), noticeFor(otro, {start: '2026-11-22T10:00:00+01:00'})])));
    const healed = quiet(() => generate(root(dir), T3));
    assert.deepEqual([healed.clupik_overlay.retained, healed.clupik_overlay.attention, healed.clupik_overlay.skipped], [[], [], []]);
    const fixed = eventOf(dir, 'cadete-masculino', 'actawp-1339808-199999999');
    assert.ok(fixed.includes('DTSTART:20270109T150000Z') && fixed.includes('SEQUENCE:1'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('también se arregla solo cuando se corrige el código: el mismo aviso, ya válido, se aplica sin tocar los datos', () => {
  const dir = tempRepo(doc([noticeFor(target, nuevo)]));
  try {
    quiet(() => generate(root(dir), T1));
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([noticeFor(target, {...roto, category: 'CADETE  MASCULINO'})])));   // se lee como la categoría canónica
    const manifest = quiet(() => generate(root(dir), T2));
    assert.deepEqual([manifest.clupik_overlay.retained, manifest.clupik_overlay.attention], [[], []]);
    assert.ok(eventOf(dir, 'cadete-masculino', 'actawp-1339808-199999999').includes('DTSTART:20270109T150000Z'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('sin la copia de partidos publicados el generador sigue negándose a publicar un partido que desaparece (no se publica a ciegas)', () => {
  const dir = tempRepo(doc([noticeFor(target, nuevo)]));
  try {
    quiet(() => generate(root(dir), T1));
    const files = Object.fromEntries(slugs.map(slug => [slug, icsOf(dir, slug)]));
    rmSync(join(dir, 'calendars/clupik-published.json'));
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify(doc([noticeFor(target, roto)])));
    assert.throws(() => quiet(() => generate(root(dir), T2)), /Partido desaparecido/);
    for (const slug of slugs) assert.equal(icsOf(dir, slug), files[slug], slug);                         // y no toca lo publicado
    writeFileSync(join(dir, 'calendars/clupik-published.json'), '{no es json');                          // una copia ilegible no es peor que no tenerla
    assert.throws(() => quiet(() => generate(root(dir), T2)), /Partido desaparecido/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('un aviso no válido de un partido que aún no está publicado no entra en los .ics y pide atención; uno de otra temporada, no', () => {
  const dir = tempRepo(doc([noticeFor(target, {...nuevo, category: 'Categoría inventada'}), noticeFor(target, {match_id: 188888888, tournament_id: 1200000}), noticeFor(otro, {start: '2026-11-22T10:00:00+01:00'})]));
  try {
    const manifest = quiet(() => generate(root(dir), T1));
    assert.equal(manifest.total, snapshot.length);
    assert.deepEqual(manifest.clupik_overlay.skipped.map(x => [x.identity, x.kind]), [['1339808:199999999', 'no-valido'], ['1200000:188888888', 'fuera-de-alcance']]);
    assert.deepEqual(manifest.clupik_overlay.attention.map(x => [x.kind, x.identity]), [['aviso-no-valido', '1339808:199999999']]);
    assert.ok(eventOf(dir, otroSlug, uid(otro).replace('@aese-waterpolo', '')).includes('DTSTART:20261122T090000Z'));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('un aviso que el repositorio no puede leer se guarda aparte con la fecha en que se vio y llega a la lista de atención', () => {
  const malo = {...noticeFor(otro), home_team: ''};
  const dir = tempRepo(doc([]));
  try {
    writeFileSync(join(dir, 'data/clupik_overlay.json'), JSON.stringify({...doc([]), rejected: [{identity: otroId, reason: 'campo home_team inválido', first_seen: T1.toISOString()}]}));
    const manifest = quiet(() => generate(root(dir), T2));
    assert.deepEqual(manifest.clupik_overlay.attention, [{kind: 'aviso-ilegible', identity: otroId, reason: 'campo home_team inválido', first_seen: T1.toISOString()}]);
    // plan(): la primera vez se anota, después no cambia nada y, al llegar un aviso válido, desaparece.
    let p = plan({current: doc([]), fetched: fetched([malo]), now: NOW});
    assert.deepEqual(p.document.rejected, [{identity: otroId, reason: 'campo home_team inválido', first_seen: new Date(NOW).toISOString()}]);
    assert.deepEqual([p.rejectedChanged, p.write, p.changed], [true, true, false]);
    p = plan({current: {...p.document}, fetched: fetched([malo], {}, NOW + 1800000), now: NOW + 1800000});
    assert.deepEqual([p.rejectedChanged, p.write, p.document.rejected[0].first_seen], [false, false, new Date(NOW).toISOString()]);
    const fixedNotice = noticeFor(otro, {received_at: '2026-10-20T09:00:00Z'});
    p = plan({current: {...p.document}, fetched: fetched([fixedNotice], {}, NOW + 3600000), now: NOW + 3600000});
    assert.deepEqual([p.rejectedChanged, 'rejected' in p.document], [true, false]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('attentionAlert: avisa en la misma pasada en que aparece el problema y luego una vez al día; report() lo cuenta en el registro', () => {
  const item = {kind: 'aviso-no-valido', identity: '1339808:199999999', reason: 'categoría inventada', first_seen: '2026-10-28T12:00:00.000Z'};
  const at = iso => attentionAlert({attention: [item], now: Date.parse(iso)}).alert;
  assert.equal(at('2026-10-28T12:07:00Z'), true);                                                       // la pasada en que aparece
  assert.equal(at('2026-10-28T12:37:00Z'), false);                                                      // la siguiente no repite el correo
  assert.equal(at('2026-10-28T18:07:00Z'), false);
  assert.equal(at('2026-10-29T06:07:00Z'), true);                                                       // recordatorio diario
  assert.equal(at('2026-10-29T06:37:00Z'), false);
  for (const none of [[], undefined, null, 'x']) assert.equal(attentionAlert({attention: none, now: Date.parse('2026-10-29T06:07:00Z')}).alert, false);
  const dir = tempRepo(doc([]));
  try {
    const lines = [], at2 = iso => report({root: root(dir), now: Date.parse(iso), log: x => lines.push(x)});
    assert.equal(at2('2026-10-29T06:07:00Z').alert, false);assert.deepEqual(lines, []);                  // sin nada pendiente, silencio
    const index = JSON.parse(readFileSync(join(dir, 'calendars/index.json'), 'utf8'));
    index.clupik_overlay.attention = [item];
    writeFileSync(join(dir, 'calendars/index.json'), JSON.stringify(index));
    assert.equal(at2('2026-10-28T12:07:00Z').alert, true);
    assert.ok(lines.some(x => x.startsWith('::error::Clupik 1339808:199999999') && x.includes('NO está en los .ics')));
    assert.ok(lines.some(x => x.includes('docs/audit-2026-10-18.md §15')));
    lines.length = 0;
    assert.equal(at2('2026-10-28T12:37:00Z').alert, false);
    assert.ok(lines.length === 1 && lines[0].startsWith('::warning::'));                                 // visible, pero sin correo
    rmSync(join(dir, 'calendars/index.json'));
    assert.equal(at2('2026-10-28T12:07:00Z').alert, false);                                              // sin manifiesto no hay nada que decir
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('run(): con algo pendiente en el manifiesto se regenera aunque no haya avisos nuevos; sin nada pendiente, no', async () => {
  const dir = tempRepo(doc([noticeFor(target)]));
  try {
    writeFileSync(join(dir, 'data/clupik_overlay_source.json'), JSON.stringify({url: URL_OK}));
    const body = JSON.stringify(fetched([noticeFor(target)]));
    const fetchImpl = async () => ({ok: true, status: 200, text: async () => body});
    let result = await run({root: root(dir), now: NOW, log() {}, fetchImpl});
    assert.deepEqual([result.changed, result.regenerate], [false, false]);
    const index = JSON.parse(readFileSync(join(dir, 'calendars/index.json'), 'utf8'));
    index.clupik_overlay.attention = [{kind: 'aviso-no-valido', identity: '1:2', reason: 'x', first_seen: '2026-10-28T12:00:00.000Z'}];
    writeFileSync(join(dir, 'calendars/index.json'), JSON.stringify(index));
    result = await run({root: root(dir), now: NOW, log() {}, fetchImpl});
    assert.deepEqual([result.changed, result.regenerate], [false, true]);
    // Un aviso ilegible nuevo también obliga a regenerar para que llegue a la lista de atención.
    const bad = JSON.stringify(fetched([noticeFor(target), {...noticeFor(otro), home_team: ''}]));
    index.clupik_overlay.attention = [];
    writeFileSync(join(dir, 'calendars/index.json'), JSON.stringify(index));
    result = await run({root: root(dir), now: NOW, log() {}, fetchImpl: async () => ({ok: true, status: 200, text: async () => bad})});
    assert.deepEqual([result.changed, result.regenerate], [false, true]);
    assert.equal(JSON.parse(readFileSync(join(dir, 'data/clupik_overlay.json'), 'utf8')).rejected.length, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
