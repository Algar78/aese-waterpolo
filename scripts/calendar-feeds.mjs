import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mapsURL } from './venues.mjs';

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
export function validate(matches, status) {
  if (!status.complete || status.errors.length || status.categories_expected.length !== 9) throw Error('Snapshot incompleto: se conservan los feeds publicados');
  const counts = Object.fromEntries(Object.keys(categories).map(name => [name, 0]));
  const ids = new Set();
  for (const match of matches) {
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
    mapsURL(match.venue);
  }
  if (matches.length !== status.total_matches_found || Object.keys(categories).some(name => !counts[name] || counts[name] !== status.counts[name] || !status.categories_expected.includes(name))) throw Error('Conteos del snapshot no coinciden');
  return counts;
}
export function eventState(matches, previous = {}, now = '20261010T000000Z') {
  const current = new Set(matches.map(uid));
  if (Object.keys(previous).some(id => !current.has(id))) throw Error('Partido desaparecido sin cancelación explícita: se conservan los feeds');
  return Object.fromEntries(matches.map(m => {
    const id = uid(m);
    const hash = createHash('sha256').update(JSON.stringify([m.category,m.start,m.home_team,m.away_team,m.venue,m.round_name,m.url,m.status || 'confirmed',mapsURL(m.venue)])).digest('hex');
    const old = previous[id];
    return [id, old?.hash === hash ? old : {hash,sequence:old ? old.sequence+1 : 0,stamp:now}];
  }));
}
export function feed(name, matches, state = eventState(matches)) {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//AESE Waterpolo//Calendarios familias//ES','CALSCALE:GREGORIAN','METHOD:PUBLISH',`X-WR-CALNAME:${escapeICS('AESE · '+name)}`,'X-WR-TIMEZONE:Europe/Madrid','REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const m of matches.filter(m => m.category === name).sort((a,b) => a.match_id-b.match_id)) {
    // No se inventa una duración: el snapshot solo contiene la hora de inicio.
    const revision = state[uid(m)];
    lines.push('BEGIN:VEVENT',`UID:${uid(m)}`,`DTSTAMP:${revision.stamp}`,`DTSTART:${utc(m.start)}`,`SEQUENCE:${revision.sequence}`,`LAST-MODIFIED:${revision.stamp}`,`STATUS:${(m.status || 'confirmed').toUpperCase()}`,`SUMMARY:${escapeICS(`${name}: ${m.home_team} — ${m.away_team}`)}`,`LOCATION:${escapeICS(m.venue)}`,`DESCRIPTION:${escapeICS(`${m.round_name}\nHorario Europe/Madrid. Fuente: ActaWP\n${m.url}\nEstado: ${m.status || 'confirmed'}\nGoogle Maps: ${mapsURL(m.venue)}`)}`,`URL:${m.url}`,'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n')+'\r\n';
}
export function generate(root = new URL('../', import.meta.url)) {
  const raw = readFileSync(new URL('data/actawp_matches.json',root));
  const matches = JSON.parse(raw);
  const status = JSON.parse(readFileSync(new URL('data/actawp_export_status.json',root)));
  if (status.snapshot_sha256 && status.snapshot_sha256 !== createHash('sha256').update(raw).digest('hex')) throw Error('Hash del snapshot no coincide: se conservan los feeds');
  const counts = validate(matches, status);
  let previous = {};
  try { previous = JSON.parse(readFileSync(new URL('calendars/event-state.json',root))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = eventState(matches, previous, utc(new Date()));
  const manifest = {source:'data/actawp_matches.json',snapshot_sha256:createHash('sha256').update(raw).digest('hex'),total:matches.length,timeZone:'Europe/Madrid',categories:Object.entries(categories).map(([name,slug])=>({name,slug,count:counts[name],url:`${baseURL}calendars/${slug}.ics`}))};
  mkdirSync(new URL('calendars/',root),{recursive:true});
  for (const [name,slug] of Object.entries(categories)) writeFileSync(new URL(`calendars/${slug}.ics`,root),feed(name,matches,state));
  writeFileSync(new URL('calendars/event-state.json',root),JSON.stringify(state,null,2)+'\n');
  writeFileSync(new URL('calendars/index.json',root),JSON.stringify(manifest,null,2)+'\n');
  console.log(`Validados y generados: ${Object.keys(categories).length} feeds, ${matches.length} partidos`);
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) generate();
