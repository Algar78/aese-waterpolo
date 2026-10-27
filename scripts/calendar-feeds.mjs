import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mapsURL, verifiedMapsURL } from './venues.mjs';

export const baseURL = 'https://algar78.github.io/aese-waterpolo/';
export const categories = {
  'Absoluto Masculino': 'absoluto-masculino',
  'Alevín Mixto A': 'alevin-mixto-a',
  'Alevín Mixto B': 'alevin-mixto-b',
  'Cadete Masculino': 'cadete-masculino',
  'Infantil Mixto A': 'infantil-mixto-a',
  'Infantil Mixto B': 'infantil-mixto-b',
  'Juvenil Femenino': 'juvenil-femenino',
  '1a Div Fem Absoluta B': 'absoluta-femenina-b',
  'Juvenil Masculino': 'juvenil-masculino'
};
export const escapeICS = value => String(value).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
export function fold(line) {
  let result = '', chunk = '';
  for (const char of line) {
    if (Buffer.byteLength(chunk + char) > 75) { result += chunk + '\r\n'; chunk = ' '; }
    chunk += char;
  }
  return result + chunk;
}
export const utc = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export const uid = match => `actawp-${match.tournament_id}-${match.match_id}@aese-waterpolo`;
// Lo que debe cumplir cada partido para publicarse; lo comparten el snapshot y los avisos de Clupik.
// `strictVenue`: el snapshot de ActaWP exige sede verificada; un aviso de Clupik no la exige (se publica sin enlace de Maps).
function validateMatch(match, ids, counts, strictVenue = true) {
  if (!(match.category in categories)) throw Error('Categoría desconocida');
  if (!Number.isSafeInteger(match.match_id) || !Number.isSafeInteger(match.tournament_id) || ids.has(uid(match))) throw Error('Identidad inválida o duplicada');
  ids.add(uid(match));
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(match.start) || !Number.isFinite(Date.parse(match.start))) throw Error('Fecha sin zona horaria válida');
  const parts = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(match.start)).replace(' ', 'T');
  if (parts !== match.start.slice(0,19)) throw Error('Hora incompatible con Europe/Madrid');
  for (const key of ['home_team','away_team','venue','round_name','url']) if (typeof match[key] !== 'string' || /[\r\n]/.test(match.url)) throw Error('Campos inválidos');
  if (!match.url.startsWith('https://actawp.natacio.cat/')) throw Error('URL no válida');
  counts[match.category]++;
  if (!['confirmed','tentative','cancelled'].includes(match.status || 'confirmed')) throw Error('Estado desconocido');
  if (strictVenue) mapsURL(match.venue);
}
export function validate(matches, status) {
  if (!status.complete || status.errors.length || status.categories_expected.length !== 9) throw Error('Snapshot incompleto: se conservan los feeds publicados');
  const counts = Object.fromEntries(Object.keys(categories).map(name => [name, 0]));
  const ids = new Set();
  for (const match of matches) validateMatch(match, ids, counts);
  if (matches.length !== status.total_matches_found || Object.keys(categories).some(name => !counts[name] || counts[name] !== status.counts[name] || !status.categories_expected.includes(name))) throw Error('Conteos del snapshot no coinciden');
  return counts;
}

// ---- Avisos de Clupik sobre el snapshot de ActaWP ---------------------------
// Apps Script ya aplica los avisos de Clupik al Google Calendar (applyClupikNotice_).
// Aquí se aplica la misma regla a los .ics, para que los dos canales digan lo mismo:
//  - un aviso recibido DESPUÉS de la última lectura completa de ActaWP manda sobre ella;
//  - si la lectura es posterior al aviso y coincide con él, manda la lectura (es lo mismo);
//  - si es posterior y no coincide, se conserva el aviso hasta que una lectura lo
//    confirme, y se deja constancia (`discordant`) para que alguien lo revise;
//  - un aviso nunca borra un partido: solo cambia fecha, equipos, sede o estado, o
//    añade un partido nuevo de un torneo que ya está en el snapshot.
const noticeKeys = ['tournament_id','match_id','category','home_team','away_team','venue','round_name','start','status','received_at'];
const agreeKeys = ['start','venue','home_team','away_team'];
export function parseOverlay(document) {
  if (!document || typeof document !== 'object' || document.schema_version !== 1 || !Array.isArray(document.notices)) throw Error('Superposición de Clupik inválida: se conservan los feeds');
  const entries = [], rejected = [], seen = new Set();
  for (const raw of document.notices) {
    try {
      if (!raw || typeof raw !== 'object') throw Error('no es un objeto');
      if (!Number.isSafeInteger(raw.tournament_id) || !Number.isSafeInteger(raw.match_id)) throw Error('identidad inválida');
      const id = uid(raw);
      if (seen.has(id)) throw Error('repetido');
      for (const key of ['category','home_team','away_team','venue','start','status','received_at']) if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 200 || /[\u0000-\u001f]/.test(raw[key])) throw Error('campo '+key+' inválido');
      if (typeof (raw.round_name ?? '') !== 'string' || (raw.round_name ?? '').length > 200 || /[\u0000-\u001f]/.test(raw.round_name ?? '')) throw Error('campo round_name inválido');
      if (!Number.isFinite(Date.parse(raw.received_at))) throw Error('received_at inválido');
      if (raw.acknowledged_snapshot !== undefined && !Number.isFinite(Date.parse(raw.acknowledged_snapshot))) throw Error('acknowledged_snapshot inválido');
      seen.add(id);
      const entry = Object.fromEntries(noticeKeys.map(key => [key, raw[key] ?? '']));
      if (raw.acknowledged_snapshot !== undefined) entry.acknowledged_snapshot = raw.acknowledged_snapshot;
      entries.push(entry);
    } catch (error) { rejected.push({identity: raw && raw.tournament_id !== undefined ? `${raw.tournament_id}:${raw.match_id}` : '?', reason: error.message}); }
  }
  return {entries, rejected};
}
export function applyOverlay(matches, status, overlay) {
  const {entries, rejected} = parseOverlay(overlay);
  const snapshotTime = Date.parse(status.last_complete_export_at || status.attempted_at || '');
  const byUid = new Map(matches.map(m => [uid(m), m]));
  const known = new Map();                       // torneo -> categorías que ya publica el snapshot
  for (const m of matches) known.set(m.tournament_id, (known.get(m.tournament_id) ?? new Set()).add(m.category));
  const replaced = new Map(), changed = [], added = [], discordant = [], skipped = [...rejected];
  const take = (id, match) => {                  // el partido resultante debe cumplir lo mismo que cualquiera del snapshot
    validateMatch(match, new Set(), Object.fromEntries(Object.keys(categories).map(name => [name, 0])), false);
    return match;
  };
  for (const notice of entries) {
    const id = uid(notice), identity = `${notice.tournament_id}:${notice.match_id}`;
    try {
      const base = byUid.get(id);
      if (base) {
        const received = Date.parse(notice.received_at);
        const agrees = agreeKeys.every(key => base[key] === notice[key]) && (base.status || 'confirmed') === notice.status;
        let disagrees = false;
        if (Number.isFinite(snapshotTime) && snapshotTime > received) {
          if (agrees) continue;
          if (notice.acknowledged_snapshot && snapshotTime >= Date.parse(notice.acknowledged_snapshot)) continue;
          disagrees = true;
        } else if (agrees) continue;
        // Un campo vacío del aviso no borra lo que ya se sabe del partido.
        const merged = take(id, {...base, home_team: notice.home_team, away_team: notice.away_team, venue: notice.venue, start: notice.start, status: notice.status, round_name: notice.round_name || base.round_name});
        replaced.set(id, merged); changed.push(identity);
        if (disagrees) discordant.push(identity);
      } else {
        // Solo partidos nuevos de torneos y categorías que el snapshot ya publica: un aviso de otra
        // temporada, que sigue guardado en Apps Script, no puede colar partidos antiguos en los .ics.
        if (!known.get(notice.tournament_id)?.has(notice.category)) throw Error('torneo o categoría que el snapshot no publica');
        added.push(take(id, {category: notice.category, tournament_id: notice.tournament_id, match_id: notice.match_id, home_team: notice.home_team, away_team: notice.away_team,
          start: notice.start, venue: notice.venue, round_name: notice.round_name, status: notice.status,
          url: `https://actawp.natacio.cat/ca/tournament/${notice.tournament_id}/match/${notice.match_id}/results`}));
      }
    } catch (error) { skipped.push({identity, reason: error.message}); }
  }
  const effective = [...matches.map(m => replaced.get(uid(m)) ?? m), ...added];
  const ids = new Set(), counts = Object.fromEntries(Object.keys(categories).map(name => [name, 0]));
  for (const match of effective) validateMatch(match, ids, counts, false);   // el snapshot ya se validó con sede verificada
  if (matches.some(m => !ids.has(uid(m)))) throw Error('La superposición habría quitado un partido: se conservan los feeds');
  return {matches: effective, counts, changed, added: added.map(m => `${m.tournament_id}:${m.match_id}`), discordant, skipped};
}
export function eventState(matches, previous = {}, now = '20261010T000000Z') {
  const current = new Set(matches.map(uid));
  if (Object.keys(previous).some(id => !current.has(id))) throw Error('Partido desaparecido sin cancelación explícita: se conservan los feeds');
  return Object.fromEntries(matches.map(m => {
    const id = uid(m);
    const hash = createHash('sha256').update(JSON.stringify([m.category,m.start,m.home_team,m.away_team,m.venue,m.url,m.status || 'confirmed',verifiedMapsURL(m.venue)])).digest('hex');
    const old = previous[id];
    return [id, old?.hash === hash ? old : {hash,sequence:old ? old.sequence+1 : 0,stamp:now}];
  }));
}
export function feed(name, matches, state = eventState(matches)) {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AESE Waterpolo//Calendarios familias//ES','CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${escapeICS('AESE · '+name)}`,'X-WR-TIMEZONE:Europe/Madrid','REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const m of matches.filter(m => m.category === name).sort((a,b) => a.match_id-b.match_id)) {
    // No se inventa una duración: el snapshot solo contiene la hora de inicio.
    const revision = state[uid(m)];
    lines.push('BEGIN:VEVENT',`UID:${uid(m)}`,`DTSTAMP:${revision.stamp}`,`DTSTART:${utc(m.start)}`,`SEQUENCE:${revision.sequence}`,`LAST-MODIFIED:${revision.stamp}`,`STATUS:${(m.status || 'confirmed').toUpperCase()}`,`SUMMARY:${escapeICS(`${name}: ${m.home_team} — ${m.away_team}`)}`,`LOCATION:${escapeICS(m.venue)}`,`DESCRIPTION:${escapeICS(`Horario Europe/Madrid. Fuente: ActaWP\n${m.url}\nEstado: ${m.status || 'confirmed'}${verifiedMapsURL(m.venue) ? `\nGoogle Maps: ${verifiedMapsURL(m.venue)}` : ''}`)}`,`URL:${m.url}`,'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n')+'\r\n';
}
export function generate(root = new URL('../', import.meta.url)) {
  const raw = readFileSync(new URL('data/actawp_matches.json',root));
  const snapshot = JSON.parse(raw);
  const status = JSON.parse(readFileSync(new URL('data/actawp_export_status.json',root)));
  if (status.snapshot_sha256 && status.snapshot_sha256 !== createHash('sha256').update(raw).digest('hex')) throw Error('Hash del snapshot no coincide: se conservan los feeds');
  validate(snapshot, status);
  // Avisos de Clupik que Apps Script ya aplica al Google Calendar (data/clupik_overlay.json, que rellena
  // scripts/clupik-overlay.mjs). Sin fichero o sin avisos, el resultado es exactamente el del snapshot.
  let document = {schema_version:1, notices:[]};
  try { document = JSON.parse(readFileSync(new URL('data/clupik_overlay.json',root))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const overlay = applyOverlay(snapshot, status, document);
  const matches = overlay.matches, counts = overlay.counts;
  let previous = {};
  try { previous = JSON.parse(readFileSync(new URL('calendars/event-state.json',root))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = eventState(matches, previous, utc(new Date()));
  const manifest = {source:'data/actawp_matches.json',snapshot_sha256:createHash('sha256').update(raw).digest('hex'),total:matches.length,timeZone:'Europe/Madrid',last_complete_export_at:status.last_complete_export_at ?? null,freshness_policy:status.freshness_policy ?? null,source_mode:status.source?.mode ?? null,pending_matches:(status.pending_matches ?? []).map(({category,match_id,teams,reason,url})=>({category,match_id,teams,reason,url})),categories:Object.entries(categories).map(([name,slug])=>({name,slug,count:counts[name],url:`${baseURL}calendars/${slug}.ics`})),
    clupik_overlay:{changed:overlay.changed,added:overlay.added,discordant:overlay.discordant,skipped:overlay.skipped}};
  // One validated document keeps Apps Script independent of GitHub's shared-IP API quota.
  // Apps Script aplica por su cuenta los avisos de Clupik, así que el paquete lleva solo el snapshot.
  const bundle = {schema_version:1, matches:snapshot, status, venues:JSON.parse(readFileSync(new URL('data/venues.json',root)))};
  for (const match of snapshot) {
    const entry = bundle.venues[match.venue];
    if (!entry?.query || !entry.source?.startsWith('https://')) throw Error('Sede del paquete sin verificar');
  }
  mkdirSync(new URL('calendars/',root),{recursive:true});
  for (const [name,slug] of Object.entries(categories)) writeFileSync(new URL(`calendars/${slug}.ics`,root),feed(name,matches,state));
  writeFileSync(new URL('calendars/event-state.json',root),JSON.stringify(state,null,2)+'\n');
  writeFileSync(new URL('calendars/index.json',root),JSON.stringify(manifest,null,2)+'\n');
  writeFileSync(new URL('calendars/general-calendar.json',root),JSON.stringify(bundle,null,2)+'\n');
  console.log(`Validados y generados: ${Object.keys(categories).length} feeds, ${matches.length} partidos`+
    (overlay.changed.length || overlay.added.length || overlay.skipped.length || overlay.discordant.length ? ` (avisos de Clupik: ${overlay.changed.length} cambiados, ${overlay.added.length} nuevos, ${overlay.discordant.length} sin confirmar por ActaWP, ${overlay.skipped.length} descartados)` : ''));
  for (const m of matches) if (!verifiedMapsURL(m.venue)) console.log(`::warning::Partido ${m.tournament_id}:${m.match_id} publicado sin enlace de Maps: sede sin verificar (${m.venue}). Comprobar la dirección y añadirla a data/venues.json`);
  for (const item of overlay.skipped) console.log(`::warning::Aviso de Clupik descartado (${item.identity}): ${item.reason}`);
  for (const identity of overlay.discordant) console.log(`::warning::El aviso de Clupik ${identity} no coincide con la última lectura de ActaWP: se mantiene el aviso`);
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) generate();
