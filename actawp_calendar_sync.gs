/**
 * AESE Waterpolo — ActaWP -> Google Calendar
 *
 * This is intentionally separate from the existing Clupik -> Gmail automation.
 * It reads the last successful ActaWP JSON snapshot published by GitHub and
 * reconciles events in the existing AESE Waterpolo-Partidos calendar.
 */

const ACTAWP_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/Algar78/aese-waterpolo/main/data/actawp_matches.json';

const ACTAWP_CALENDAR_ID =
  '68af70845551fc729e20ff0ff1ca9f69bbbadade7031e6b90ace51fbcd279c7f@group.calendar.google.com';

const ACTAWP_PROPERTY_PREFIX = 'ACTAWP_EVENT_';
const ACTAWP_SYNC_PROPERTY = 'ACTAWP_LAST_SYNC';
const ACTAWP_MARKER = 'ACTAWP_MATCH_ID:';
const DEFAULT_DURATION_MINUTES = 90;
let ACTAWP_VENUES = {};
let ACTAWP_EVENT_CACHE = null;

function fetchActaWPJSON_(url) {
  const response = UrlFetchApp.fetch(url, {muteHttpExceptions:true, headers:{'Cache-Control':'no-cache'}});
  if (response.getResponseCode() !== 200) throw new Error('ActaWP HTTP ' + response.getResponseCode());
  return JSON.parse(response.getContentText());
}

function loadActaWPSnapshot_() {
  // Todos los archivos pertenecen al mismo commit, incluso si main avanza.
  const commit = fetchActaWPJSON_('https://api.github.com/repos/Algar78/aese-waterpolo/commits/main');
  if (!/^[a-f0-9]{40}$/.test(commit.sha || '')) throw new Error('Commit inválido');
  const root = 'https://raw.githubusercontent.com/Algar78/aese-waterpolo/' + commit.sha + '/data/';
  const matches = fetchActaWPJSON_(root + 'actawp_matches.json');
  const status = fetchActaWPJSON_(root + 'actawp_export_status.json');
  ACTAWP_VENUES = fetchActaWPJSON_(root + 'venues.json');
  validateActaWPSnapshot_(matches, status);
  return matches;
}

function validateActaWPSnapshot_(matches, status) {
  if (!Array.isArray(matches) || !matches.length || !status.complete ||
      !Array.isArray(status.errors) || status.errors.length || status.categories_expected.length !== 9 ||
      matches.length !== status.total_matches_found) throw new Error('Snapshot incompleto; no se modifica el calendario');
  const ids = new Set(), counts = {};
  matches.forEach(m => {
    const id = actaWPIdentity_(m);
    if (!Number.isSafeInteger(m.match_id) || !Number.isSafeInteger(m.tournament_id) || ids.has(id) ||
        !status.categories_expected.includes(m.category) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(m.start) || isNaN(new Date(m.start).getTime()) ||
        Utilities.formatDate(new Date(m.start), 'Europe/Madrid', "yyyy-MM-dd'T'HH:mm:ss") !== m.start.slice(0,19) ||
        !/^https:\/\/actawp\.natacio\.cat\//.test(m.url) ||
        !['confirmed','tentative','cancelled'].includes(m.status || 'confirmed')) throw new Error('Partido inválido o duplicado: ' + id);
    ['home_team','away_team','venue','round_name'].forEach(k => { if (typeof m[k] !== 'string') throw new Error('Campo inválido: ' + k); });
    actaWPMapsURL_(m.venue);
    ids.add(id); counts[m.category] = (counts[m.category] || 0) + 1;
  });
  status.categories_expected.forEach(c => { if (!counts[c] || counts[c] !== status.counts[c]) throw new Error('Conteos inválidos'); });
}

function actaWPIdentity_(match) { return match.tournament_id + ':' + match.match_id; }
function actaWPMapsURL_(venue) {
  const entry = ACTAWP_VENUES[venue];
  if (!entry || !entry.query || !/^https:\/\//.test(entry.source)) throw new Error('Sede sin verificar: ' + venue);
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(entry.query);
}

function ownsActaWPEvent_(event, match) {
  const lines = (event.getDescription() || '').split(/\r?\n/);
  return lines.includes(ACTAWP_MARKER + actaWPIdentity_(match)) ||
    (lines.includes(ACTAWP_MARKER + match.match_id) && lines.includes('ActaWP: ' + match.url));
}

function syncActaWPToCalendar() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ACTAWP_EVENT_CACHE = {};
    const matches = loadActaWPSnapshot_();

    const calendar = CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
    if (!calendar) {
      throw new Error('No se encontró el calendario AESE Waterpolo-Partidos.');
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;

    matches.forEach(match => {
      const result = reconcileActaWPMatch_(calendar, match);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else unchanged++;
    });

    PropertiesService.getScriptProperties().setProperty(
      ACTAWP_SYNC_PROPERTY,
      new Date().toISOString()
    );

    console.log(
      'ActaWP sync OK — total=' + matches.length +
      ' created=' + created +
      ' updated=' + updated +
      ' unchanged=' + unchanged
    );
  } finally {
    ACTAWP_EVENT_CACHE = null;
    lock.releaseLock();
  }
}

function reconcileActaWPMatch_(calendar, match) {
  const id = actaWPIdentity_(match);
  const start = new Date(match.start);
  if (isNaN(start.getTime())) throw new Error('Fecha inválida para partido ' + id);

  const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000);
  const title = formatActaWPTitle_(match, start);
  const description = buildActaWPDescription_(match);
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = ACTAWP_PROPERTY_PREFIX + id;

  let event = null;
  const storedEventId = properties.getProperty(propertyKey) || properties.getProperty(ACTAWP_PROPERTY_PREFIX + match.match_id);
  if (storedEventId) {
    try {
      event = calendar.getEventById(storedEventId);
    } catch (e) { throw new Error('No se pudo consultar el evento guardado: ' + e); }
    if (event && !ownsActaWPEvent_(event, match)) throw new Error('Referencia a evento ajeno: ' + id);
  }

  const recovered = findActaWPEvent_(calendar, match, start);
  if (event && recovered && event.getId() !== recovered.getId()) throw new Error('Identidad duplicada: ' + id);
  if (!event) event = recovered;

  if (!event) {
    // No adoptar ni duplicar un evento Clupik por mera similitud.
    const candidates = calendar.getEvents(new Date(start.getTime()-86400000), new Date(start.getTime()+86400000));
    if (candidates.some(e => e.getStartTime().getTime() === start.getTime() &&
        e.getTitle().toUpperCase().includes(match.home_team.toUpperCase()) &&
        e.getTitle().toUpperCase().includes(match.away_team.toUpperCase()))) {
      throw new Error('Posible duplicado Clupik; vincular manualmente tras revisión: ' + id);
    }
    event = calendar.createEvent(title, start, end, {
      description: description,
      location: match.venue || '',
    });
    properties.setProperty(propertyKey, event.getId());
    return 'created';
  }

  let changed = false;
  if (event.getTitle() !== title) {
    event.setTitle(title);
    changed = true;
  }
  if (event.getStartTime().getTime() !== start.getTime() ||
      event.getEndTime().getTime() !== end.getTime()) {
    event.setTime(start, end);
    changed = true;
  }
  if ((event.getLocation() || '') !== (match.venue || '')) {
    event.setLocation(match.venue || '');
    changed = true;
  }
  if ((event.getDescription() || '') !== description) {
    event.setDescription(description);
    changed = true;
  }

  properties.setProperty(propertyKey, event.getId());
  return changed ? 'updated' : 'unchanged';
}

function findActaWPEvent_(calendar, match, start) {
  // Buscar toda la temporada permite recuperar referencias tras aplazamientos largos.
  const year = start.getUTCFullYear() - (start.getUTCMonth() < 7 ? 1 : 0);
  const from = new Date(Date.UTC(Math.min(year, 2026), 7, 1));
  const to = new Date(Date.UTC(year+1, 7, 1));
  const events = ACTAWP_EVENT_CACHE ? (ACTAWP_EVENT_CACHE[year] ||
    (ACTAWP_EVENT_CACHE[year] = calendar.getEvents(from, to))) : calendar.getEvents(from, to);
  const owned = events.filter(e => ownsActaWPEvent_(e, match));
  if (owned.length > 1) throw new Error('Identidad duplicada; no se modifica ni elimina: ' + actaWPIdentity_(match));
  return owned[0] || null;
}

function formatActaWPTitle_(match, start) {
  const hhmm = Utilities.formatDate(start, 'Europe/Madrid', 'HH:mm');
  const state = match.status === 'cancelled' ? ' [CANCELADO]' : match.status === 'tentative' ? ' [APLAZADO / POR CONFIRMAR]' : '';
  return hhmm + ' ' + match.home_team + ' vs ' + match.away_team + ' — ' + match.category + state;
}

function buildActaWPDescription_(match) {
  return [
    ACTAWP_MARKER + actaWPIdentity_(match),
    'Categoría: ' + (match.category || ''),
    'Jornada: ' + (match.round_name || ''),
    'Piscina: ' + (match.venue || ''),
    'ActaWP: ' + (match.url || ''),
    'Estado: ' + (match.status || 'confirmed'),
    'Google Maps: ' + actaWPMapsURL_(match.venue),
    '',
    'Evento sincronizado automáticamente desde ActaWP.'
  ].join('\n');
}

function installActaWPSyncTrigger() {
  const functionName = 'syncActaWPToCalendar';
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyMinutes(15)
    .create();
}

function checkActaWPConfig() {
  const calendar = CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
  console.log('Calendar: ' + (calendar ? calendar.getName() : 'NOT FOUND'));
  console.log('Last sync: ' +
    (PropertiesService.getScriptProperties().getProperty(ACTAWP_SYNC_PROPERTY) || 'never'));
}

/** Maps se puede añadir a eventos existentes de Clupik sin adoptar su identidad. */
function previewGeneralCalendarMaps() { return generalCalendarMaps_(false); }
function updateGeneralCalendarMaps() { return generalCalendarMaps_(true); }
function generalCalendarMaps_(apply) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const matches = loadActaWPSnapshot_();
    const dates = matches.map(m => new Date(m.start).getTime());
    const calendar = CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
    if (!calendar) throw new Error('Calendario no encontrado');
    const events = calendar.getEvents(new Date(Math.min.apply(null,dates)-30*86400000), new Date(Math.max.apply(null,dates)+30*86400000));
    const plan = [], skipped = [];
    events.forEach(event => {
      const venue = event.getLocation() || '';
      if (!ACTAWP_VENUES[venue]) { skipped.push(event.getId()); return; }
      const description = mapsDescription_(event.getDescription() || '', venue);
      if (description !== (event.getDescription() || '')) {
        plan.push({id:event.getId(), title:event.getTitle(), maps:actaWPMapsURL_(venue)});
        if (apply) event.setDescription(description);
      }
    });
    console.log(JSON.stringify({apply:apply, changes:plan, skipped:skipped}));
    return {changes:plan, skipped:skipped};
  } finally { lock.releaseLock(); }
}
function mapsDescription_(description, venue) {
  const clean = description.replace(/\n?\[AESE_MAPS\][\s\S]*?\[\/AESE_MAPS\]/g,'');
  return clean + '\n[AESE_MAPS]\nGoogle Maps: ' + actaWPMapsURL_(venue) + '\n[/AESE_MAPS]';
}
