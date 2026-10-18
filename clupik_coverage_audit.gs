/** Auditoría de solo lectura: ¿qué cubren de verdad los avisos de Clupik?
 *
 * Sin autorización para leer ActaWP por su cuenta, el calendario depende de estos
 * correos para enterarse de cambios y de partidos nuevos. Esta función dice, con
 * los correos reales de tu Gmail, qué tipos de aviso llegan, cuáles procesa el
 * sistema, cuáles no se pueden interpretar y dónde discrepan del último paquete
 * oficial.
 *
 * Uso: en el editor de Apps Script, elige «auditClupikCoverage» y pulsa Ejecutar;
 * el informe sale en el registro de ejecución. «auditClupikCoverageEmail» hace lo
 * mismo y además lo envía por correo a AESE_ALERT_EMAIL.
 *
 * Solo lee: no toca Calendar, no marca ni mueve correos, no guarda propiedades
 * y no envía nada (salvo la variante «Email», a tu propia dirección de alertas).
 */
const AESE_AUDIT_MAX_DAYS = 400;
const AESE_AUDIT_BUDGET_MS = 240000;

function auditClupikCoverage() {
  const report = aeseClupikCoverage_();
  Logger.log(report.text);
  return report;
}

function auditClupikCoverageEmail() {
  const report = aeseClupikCoverage_();
  Logger.log(report.text);
  MailApp.sendEmail(AESE_ALERT_EMAIL, 'AESE: auditoría de los avisos de Clupik', report.text);
  return report;
}

function aeseAuditRow_(message) {
  const subject = message.getSubject() || '';
  const row = {
    id: message.getId(),
    at: message.getDate().toISOString(),
    subject: subject,
    pattern: subject.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80),
    // The pipeline only looks at subjects like this one (clupik_calendar_sync.gs).
    handled: /partid|match/i.test(subject)
  };
  if (!row.handled) return row;
  try {
    const notice = parseClupikNotice_(message);
    row.ok = true;
    row.identity = actaWPIdentity_(notice);
    row.status = notice.status;
    row.start = notice.start;
  } catch (error) {
    row.ok = false;
    row.error = String((error && error.message) || error).slice(0, 160);
  }
  return row;
}

function aeseAuditKnownMatches_() {
  try {
    const live = loadActaWPSnapshot_();
    if (live && live.length) return {matches: live, source: 'paquete publicado en GitHub Pages'};
  } catch (error) { /* falls back to the copy inside this script */ }
  return {matches: (AESE_OFFLINE_BUNDLE && AESE_OFFLINE_BUNDLE.matches) || [], source: 'copia incluida en este script'};
}

function aeseClupikCoverage_(options) {
  const opts = options || {};
  const deadline = Date.now() + (opts.budgetMs === undefined ? AESE_AUDIT_BUDGET_MS : opts.budgetMs);
  const query = 'from:' + CLUPIK_REMITENTE + ' newer_than:' + (opts.days || AESE_AUDIT_MAX_DAYS) + 'd';
  const seen = new Set(), rows = [];
  let partial = false;
  scan: for (let offset = 0; ; offset += 100) {
    if (Date.now() > deadline) { partial = true; break; }
    const threads = GmailApp.search(query, offset, 100);
    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        if (!/^(?:.*<)?no-reply@clupik\.com>?$/i.test(message.getFrom().trim())) continue;
        const id = message.getId();
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push(aeseAuditRow_(message));
        if (Date.now() > deadline) { partial = true; break scan; }
      }
    }
    if (threads.length < 100) break;
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const patterns = new Map();
  for (const row of rows) {
    const p = patterns.get(row.pattern) || {pattern: row.pattern, handled: row.handled, count: 0, ok: 0, failed: 0, first: row.at, last: row.at};
    p.count++; p.last = row.at;
    if (row.ok === true) p.ok++;
    if (row.ok === false) p.failed++;
    patterns.set(row.pattern, p);
  }
  const groups = Array.from(patterns.values()).sort((a, b) => b.count - a.count);
  const failures = rows.filter(r => r.ok === false);

  const known = aeseAuditKnownMatches_();
  const byIdentity = new Map(known.matches.map(m => [actaWPIdentity_(m), m]));
  const latest = new Map();
  for (const row of rows) if (row.ok === true) latest.set(row.identity, row);   // rows are in time order
  const unknown = Array.from(latest.keys()).filter(id => !byIdentity.has(id));
  // The copy bundled in the script has identities but no dates: it cannot be compared.
  const differing = Array.from(latest.values()).filter(r => byIdentity.has(r.identity) && byIdentity.get(r.identity).start &&
    Date.parse(byIdentity.get(r.identity).start) !== Date.parse(r.start));
  const statuses = {confirmed: 0, tentative: 0, cancelled: 0};
  for (const row of rows) if (row.ok === true) statuses[row.status] = (statuses[row.status] || 0) + 1;

  const day = iso => iso.slice(0, 10);
  const lines = ['AUDITORÍA DE LOS AVISOS DE CLUPIK (solo lectura)', ''];
  lines.push('Correos de Clupik encontrados: ' + rows.length + (rows.length ? ' (del ' + day(rows[0].at) + ' al ' + day(rows[rows.length - 1].at) + ')' : '') +
    (partial ? ' — INFORME PARCIAL: se agotó el tiempo; vuelve a ejecutarlo.' : '') + '.');
  lines.push('');
  lines.push('Tipos de aviso (agrupados por asunto):');
  if (!groups.length) lines.push(' - ninguno');
  for (const g of groups) {
    lines.push(' - «' + g.pattern + '»: ' + g.count + ' correo(s). ' +
      (g.handled ? 'El sistema los procesa; se interpretan ' + g.ok + (g.failed ? ' y NO se pueden interpretar ' + g.failed : '') + '.'
                 : 'El sistema NO los procesa (su asunto no contiene «partid» ni «match»).'));
  }
  lines.push('');
  lines.push('Avisos que el sistema intenta procesar y no puede interpretar: ' + failures.length + '.');
  for (const r of failures.slice(0, 10)) lines.push(' - ' + day(r.at) + ' · «' + r.subject + '» · ' + r.error);
  if (failures.length > 10) lines.push(' - … y ' + (failures.length - 10) + ' más');
  lines.push('');
  lines.push('Partidos con aviso: ' + latest.size + '. Estados vistos: ' + statuses.confirmed + ' confirmados, ' +
    statuses.tentative + ' aplazados, ' + statuses.cancelled + ' cancelados.');
  lines.push('Referencia para comparar: ' + known.source + ' (' + known.matches.length + ' partidos).');
  lines.push('Avisos de partidos que NO figuran en esa referencia (posibles partidos nuevos): ' + unknown.length + (unknown.length ? ' → ' + unknown.slice(0, 15).join(', ') : '') + '.');
  lines.push(known.matches.some(m => m.start)
    ? 'Partidos cuyo último aviso tiene otra fecha que la referencia: ' + differing.length + '.'
    : 'No se comparan fechas: la copia incluida en este script no las contiene.');
  for (const r of differing.slice(0, 15)) {
    const m = byIdentity.get(r.identity);
    lines.push(' - ' + r.identity + ' · aviso (' + day(r.at) + '): ' + r.start + ' · referencia: ' + m.start);
  }
  lines.push('');
  lines.push('CÓMO LEERLO');
  lines.push('- Un partido sin aviso no es un fallo: solo hay aviso cuando algo cambia.');
  lines.push('- Los tipos que el sistema NO procesa: comprueba si alguno puede traer un cambio de partido; si sí, hay un hueco.');
  lines.push('- Los avisos que no se interpretan se reintentan en cada ejecución y bloquean el avance del punto de control: conviene revisarlos uno a uno.');
  lines.push('- Si nunca ha llegado un aviso de un tipo (nuevo partido, cancelación, aplazamiento), esta auditoría no puede saber si Clupik lo enviaría: solo muestra lo que ya ha pasado.');
  return {text: lines.join('\n'), partial: partial, total: rows.length, groups: groups, failures: failures,
          unknown: unknown, differing: differing.map(r => r.identity), statuses: statuses, reference: known.source};
}
