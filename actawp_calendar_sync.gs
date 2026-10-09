/**
 * AESE Waterpolo — ActaWP -> Google Calendar
 *
 * This is intentionally separate from the existing Clupik -> Gmail automation.
 * It reads the last successful ActaWP JSON snapshot published by GitHub and
 * reconciles events in the existing AESE Waterpolo-Partidos calendar.
 */

const ACTAWP_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/Algar78/aese-waterpolo/actawp-calendar-sync/data/actawp_matches.json';

const ACTAWP_CALENDAR_ID =
  '68af70845551fc729e20ff0ff1ca9f69bbbadade7031e6b90ace51fbcd279c7f@group.calendar.google.com';

const ACTAWP_PROPERTY_PREFIX = 'ACTAWP_EVENT_';
const ACTAWP_SYNC_PROPERTY = 'ACTAWP_LAST_SYNC';
const ACTAWP_MARKER = 'ACTAWP_MATCH_ID:';
const DEFAULT_DURATION_MINUTES = 90;

/** Main entry point. Run this once manually after pasting into Apps Script. */
function syncActaWPToCalendar() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const response = UrlFetchApp.fetch(ACTAWP_SNAPSHOT_URL, {
      muteHttpExceptions: true,
      headers: { 'Cache-Control': 'no-cache' },
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      throw new Error('ActaWP snapshot HTTP ' + code);
    }

    const matches = JSON.parse(response.getContentText());
    if (!Array.isArray(matches) || matches.length === 0) {
      throw new Error('ActaWP snapshot vacío o inválido; no se modifica el calendario.');
    }

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
    lock.releaseLock();
  }
}

function reconcileActaWPMatch_(calendar, match) {
  const id = String(match.match_id);
  const start = new Date(match.start);
  if (isNaN(start.getTime())) throw new Error('Fecha inválida para partido ' + id);

  const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60000);
  const title = formatActaWPTitle_(match, start);
  const description = buildActaWPDescription_(match);
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = ACTAWP_PROPERTY_PREFIX + id;

  let event = null;
  const storedEventId = properties.getProperty(propertyKey);
  if (storedEventId) {
    try {
      event = calendar.getEventById(storedEventId);
    } catch (e) {
      event = null;
    }
  }

  // Recovery path if Script Properties were lost or the event was recreated.
  if (!event) {
    event = findActaWPEvent_(calendar, id, start);
  }

  if (!event) {
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

function findActaWPEvent_(calendar, matchId, start) {
  const from = new Date(start.getTime() - 7 * 86400000);
  const to = new Date(start.getTime() + 7 * 86400000);
  const events = calendar.getEvents(from, to);
  const marker = ACTAWP_MARKER + matchId;

  for (const event of events) {
    if ((event.getDescription() || '').indexOf(marker) !== -1) {
      return event;
    }
  }
  return null;
}

function formatActaWPTitle_(match, start) {
  const hhmm = Utilities.formatDate(start, 'Europe/Madrid', 'HH:mm');
  return hhmm + ' ' + match.home_team + ' vs ' + match.away_team + ' — ' + match.category;
}

function buildActaWPDescription_(match) {
  const lines = [
    ACTAWP_MARKER + match.match_id,
    'Categoría: ' + (match.category || ''),
    'Jornada: ' + (match.round_name || ''),
    'Piscina: ' + (match.venue || ''),
    'ActaWP: ' + (match.url || ''),
    '',
    'Evento sincronizado automáticamente desde ActaWP.'
  ];
  return lines.join('\n');
}

/** Creates the recurring trigger used in production. Safe to run repeatedly. */
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

/** Diagnostic: prints current sync timestamp and configured calendar. */
function checkActaWPConfig() {
  const calendar = CalendarApp.getCalendarById(ACTAWP_CALENDAR_ID);
  console.log('Calendar: ' + (calendar ? calendar.getName() : 'NOT FOUND'));
  console.log('Last sync: ' +
    (PropertiesService.getScriptProperties().getProperty(ACTAWP_SYNC_PROPERTY) || 'never'));
}
