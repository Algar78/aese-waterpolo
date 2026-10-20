// Trae de Apps Script los avisos de Clupik ya interpretados y los guarda en data/clupik_overlay.json,
// que scripts/calendar-feeds.mjs aplica a los .ics de las familias.
//
// Reglas, pensadas para que un fallo nunca estropee lo ya publicado:
//  - Solo se lee una dirección de script.google.com guardada en data/clupik_overlay_source.json.
//    Sin ese fichero no hace nada (así se puede fusionar el código antes de activar la lectura).
//  - Si la respuesta no es un documento válido y reciente, no se escribe nada.
//  - Los avisos solo se añaden o se actualizan con otro más reciente; nunca se borran. Un partido que ya
//    aparece en un .ics no puede desaparecer porque Apps Script haya perdido un dato.
//  - El fichero solo se reescribe cuando cambia algún aviso, o como mucho cada 5 días para dejar
//    constancia de la última comprobación (y mantener activo el workflow programado).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOverlay, uid } from './calendar-feeds.mjs';

export const sourcePattern = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const STALE_SCAN_MS = 6 * 3600000;       // Apps Script sin terminar una lectura del correo en 6 h
export const MAX_RESPONSE_AGE_MS = 3600000;     // una respuesta con más de 1 h no es «de ahora»
export const REFRESH_MS = 5 * 86400000;

const byIdentity = (a, b) => a.tournament_id - b.tournament_id || a.match_id - b.match_id;

export function mergeOverlay(current, fetched) {
  const stored = parseOverlay(current);
  if (stored.rejected.length) throw Error('El fichero guardado tiene avisos inválidos: ' + JSON.stringify(stored.rejected));
  const incoming = parseOverlay(fetched);
  const merged = new Map(stored.entries.map(entry => [uid(entry), entry]));
  for (const entry of incoming.entries) {
    const old = merged.get(uid(entry));
    if (!old || Date.parse(entry.received_at) >= Date.parse(old.received_at)) merged.set(uid(entry), entry);
  }
  return {notices: [...merged.values()].sort(byIdentity), rejected: incoming.rejected};
}

// Devuelve lo que hay que hacer sin tocar disco ni red; `run` lo ejecuta.
export function plan({current, fetched, now}) {
  const generated = Date.parse(fetched.generated_at);
  if (!Number.isFinite(generated) || Math.abs(now - generated) > MAX_RESPONSE_AGE_MS) throw Error('La respuesta de Apps Script no es reciente (generated_at: ' + fetched.generated_at + ')');
  const {notices, rejected} = mergeOverlay(current, fetched);
  const lastScan = Date.parse(fetched.clupik_last_success);
  const stale = !Number.isFinite(lastScan) || now - lastScan > STALE_SCAN_MS;
  const before = JSON.stringify(parseOverlay(current).entries.sort(byIdentity));
  const changed = before !== JSON.stringify(notices);
  const checked = Date.parse(current.checked_at);
  const write = changed || !Number.isFinite(checked) || now - checked > REFRESH_MS;
  const document = {schema_version: 1, checked_at: new Date(now).toISOString(), clupik_last_success: Number.isFinite(lastScan) ? new Date(lastScan).toISOString() : null, notices};
  // Un aviso por correo solo cada 6 h aunque siga el problema; el resto de ejecuciones solo avisan en el registro.
  const alert = stale && new Date(now).getUTCHours() % 6 === 0 && new Date(now).getUTCMinutes() < 30;
  return {document, changed, write, stale, alert, rejected, lastScan};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readSource(root, fetchImpl = fetch, wait = sleep) {
  let configured;
  try { configured = JSON.parse(readFileSync(new URL('data/clupik_overlay_source.json', root), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (typeof configured.url !== 'string' || !sourcePattern.test(configured.url)) throw Error('data/clupik_overlay_source.json: la dirección debe ser una aplicación web de script.google.com');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(configured.url, {redirect: 'follow', signal: AbortSignal.timeout(30000), headers: {accept: 'application/json'}});
      const text = await response.text();
      if (!response.ok) throw Error('Apps Script respondió HTTP ' + response.status);
      // Lo que no es un documento JSON no mejora al repetir: se avisa de inmediato.
      if (text.length > 2000000) throw Object.assign(Error('Respuesta demasiado grande'), {permanent: true});
      if (/^\s*</.test(text)) throw Object.assign(Error('Apps Script devolvió una página y no JSON: ¿la implementación es pública («Cualquier usuario»)?'), {permanent: true});
      try { return JSON.parse(text); } catch (_) { throw Object.assign(Error('La respuesta de Apps Script no es JSON'), {permanent: true}); }
    } catch (error) {
      if (error.permanent) throw error;
      lastError = error;
      if (attempt < 3) await wait(5000 * attempt);
    }
  }
  throw Error('No se pudo leer Apps Script tras 3 intentos: ' + lastError.message);
}

export async function run({root = new URL('../', import.meta.url), now = Date.now(), fetchImpl = fetch, log = console.log, wait = sleep} = {}) {
  const fetched = await readSource(root, fetchImpl, wait);
  if (fetched === null) { log('Sin data/clupik_overlay_source.json: la lectura de avisos de Clupik no está activada.'); return {configured: false, changed: false, alert: false}; }
  let current;
  try { current = JSON.parse(readFileSync(new URL('data/clupik_overlay.json', root), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; current = {schema_version: 1, notices: []}; }
  const result = plan({current, fetched, now});
  for (const item of result.rejected) log(`::warning::Aviso de Clupik ignorado (${item.identity}): ${item.reason}`);
  if (result.write) writeFileSync(new URL('data/clupik_overlay.json', root), JSON.stringify(result.document, null, 2) + '\n');
  log(`Avisos de Clupik: ${result.document.notices.length} guardados; ${result.changed ? 'hay cambios' : 'sin cambios'}.`);
  if (result.stale) log(`::warning::Apps Script no ha terminado de leer el correo de Clupik desde ${result.lastScan ? new Date(result.lastScan).toISOString() : 'nunca'}.`);
  return {configured: true, changed: result.changed, alert: result.alert, stale: result.stale};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(result => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `configured=${result.configured}\nchanged=${result.changed}\nalert=${result.alert}\n`);
  }).catch(error => { console.log('::error::' + error.message); process.exit(1); });
}
