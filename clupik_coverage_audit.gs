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
    row.undated = !!notice.undated;               // partido nuevo todavía sin fecha: es normal
    row.dateResolution = notice.date_resolution;  // cómo se decidió el día y el mes
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
  for (const row of rows) if (row.ok === true && !row.undated) latest.set(row.identity, row);   // rows are in time order
  const unknown = Array.from(latest.keys()).filter(id => !byIdentity.has(id));
  // The copy bundled in the script has identities but no dates: it cannot be compared.
  const differing = Array.from(latest.values()).filter(r => byIdentity.has(r.identity) && byIdentity.get(r.identity).start &&
    Date.parse(byIdentity.get(r.identity).start) !== Date.parse(r.start));
  const statuses = {confirmed: 0, tentative: 0, cancelled: 0};
  for (const row of rows) if (row.ok === true && !row.undated) statuses[row.status] = (statuses[row.status] || 0) + 1;
  const undatedRows = rows.filter(r => r.ok === true && r.undated);
  const undatedIds = new Set(undatedRows.map(r => r.identity));
  const stillUndated = Array.from(undatedIds).filter(id => !latest.has(id));
  const resolution = {};
  for (const row of rows) if (row.ok === true && row.dateResolution) resolution[row.dateResolution] = (resolution[row.dateResolution] || 0) + 1;

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
  lines.push('Avisos de partido nuevo sin fecha (normal: la fecha llega en un aviso posterior): ' + undatedRows.length + ' de ' + undatedIds.size +
    ' partidos; todavía sin fecha en los avisos: ' + stillUndated.length + '.');
  lines.push('Cómo se ha leído la fecha: ' + (Object.keys(resolution).sort().map(k => k + ' ' + resolution[k]).join(' · ') || 'sin avisos con fecha') + '.');
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
          unknown: unknown, differing: differing.map(r => r.identity), statuses: statuses, reference: known.source,
          undated: undatedRows.length, stillUndated: stillUndated, resolution: resolution};
}

/** Diagnóstico de solo lectura de los avisos que el sistema procesa y no entiende.
 *
 * Para cada tipo de fallo dice cuántos avisos son, de qué meses y cómo es por dentro
 * el más reciente (solo los textos de la plantilla; se omiten enlaces y direcciones
 * de correo). Sirve para decidir si el lector de avisos tiene que aprender un formato
 * nuevo. No toca Calendar, ni propiedades, ni marca ni mueve correos.
 *
 * Uso: elige «auditClupikUnreadable» en el editor de Apps Script y pulsa Ejecutar.
 */
function auditClupikUnreadable() {
  const report = aeseClupikUnreadable_();
  Logger.log(report.text);
  return report;
}

function aeseClupikBlocks_(html) {
  const clean = text => decodeClupikHTML_(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return Array.from(html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .matchAll(/<(?:div|td|p|span)\b[^>]*>((?:(?!<(?:div|td|p|span)\b)[\s\S])*?)<\/(?:div|td|p|span)>/gi), m => clean(m[1])).filter(Boolean);
}

function aeseClupikDescribe_(message) {
  const html = message.getBody();
  const blocks = aeseClupikBlocks_(html);
  let identity;
  try { const i = clupikIdentity_(html); identity = i.tournament_id + ':' + i.match_id; }
  catch (error) { identity = 'sin identidad (' + error.message + ')'; }
  return {
    identity: identity,
    blocks: blocks.length,
    hasTime: blocks.some(b => /^\d{1,2}:\d{2}$/.test(b)),
    hasDate: blocks.some(b => /^\d{2}\/\d{2}\/\d{4}$/.test(b)),
    knownTemplate: /id=["']calendar["']/.test(html) && /id=["']clock["']/.test(html),
    texts: blocks.filter(b => !/@|https?:|www\./i.test(b)).map(b => b.slice(0, 80)).slice(0, 60)
  };
}

function aeseClupikUnreadable_(options) {
  const opts = options || {};
  const deadline = Date.now() + (opts.budgetMs === undefined ? AESE_AUDIT_BUDGET_MS : opts.budgetMs);
  const query = 'from:' + CLUPIK_REMITENTE + ' newer_than:' + (opts.days || AESE_AUDIT_MAX_DAYS) + 'd';
  const seen = new Set(), groups = new Map();
  let handled = 0, partial = false;
  scan: for (let offset = 0; ; offset += 100) {
    if (Date.now() > deadline) { partial = true; break; }
    const threads = GmailApp.search(query, offset, 100);
    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        if (!/^(?:.*<)?no-reply@clupik\.com>?$/i.test(message.getFrom().trim())) continue;
        const id = message.getId();
        if (seen.has(id)) continue;
        seen.add(id);
        const subject = message.getSubject() || '';
        if (!/partid|match/i.test(subject)) continue;
        handled++;
        try { parseClupikNotice_(message); }
        catch (error) {
          const reason = String((error && error.message) || error).slice(0, 120);
          const pattern = subject.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
          const key = pattern + ' | ' + reason.replace(/\d/g, '#');
          const at = message.getDate().toISOString();
          const g = groups.get(key) || {pattern: pattern, reason: reason, count: 0, months: {}, first: at, last: at, latest: null};
          g.count++;
          g.months[at.slice(0, 7)] = (g.months[at.slice(0, 7)] || 0) + 1;
          if (at < g.first) g.first = at;
          if (at >= g.last) { g.last = at; g.latest = message; }
          groups.set(key, g);
        }
        if (Date.now() > deadline) { partial = true; break scan; }
      }
    }
    if (threads.length < 100) break;
  }
  const list = Array.from(groups.values()).sort((a, b) => b.count - a.count);
  const lines = ['AVISOS DE CLUPIK QUE EL SISTEMA PROCESA Y NO ENTIENDE (solo lectura)', ''];
  lines.push('Avisos revisados con asunto de partido: ' + handled + '. Tipos de fallo: ' + list.length + '.' +
    (partial ? ' INFORME PARCIAL: se agotó el tiempo; vuelve a ejecutarlo.' : ''));
  const described = [];
  for (const g of list) {
    const d = aeseClupikDescribe_(g.latest);
    described.push({pattern: g.pattern, reason: g.reason, count: g.count, months: g.months, sample: d});
    lines.push('');
    lines.push('«' + g.pattern + '» · ' + g.count + ' aviso(s) · motivo: ' + g.reason);
    lines.push('  por mes: ' + Object.keys(g.months).sort().map(m => m + ': ' + g.months[m]).join(', '));
    lines.push('  el más reciente (' + g.last.slice(0, 10) + ') · identidad ' + d.identity + ' · bloques de texto: ' + d.blocks +
      ' · hora: ' + (d.hasTime ? 'sí' : 'NO') + ' · fecha: ' + (d.hasDate ? 'sí' : 'NO') + ' · plantilla conocida: ' + (d.knownTemplate ? 'sí' : 'no'));
    let line = '  textos:';
    d.texts.forEach((t, i) => {
      const piece = ' [' + i + '] ' + t;
      if (line.length + piece.length > 170) { lines.push(line); line = '         '; }
      line += piece;
    });
    lines.push(line);
  }
  return {text: lines.join('\n'), partial: partial, handled: handled, groups: described};
}

/** Diagnóstico de solo lectura: ¿en qué formato escribe Clupik las fechas de los avisos?
 *
 * Una fecha como «05/11/2026» puede ser 5 de noviembre o 11 de mayo. Esta función
 * cuenta, mes a mes, cuántos avisos tienen una fecha que solo admite un formato
 * (día/mes o mes/día) y cuántos son ambiguos, y comprueba cuál de las dos lecturas
 * coincide con el último paquete oficial. Sirve para saber si el formato cambia con
 * el tiempo y si se puede leer sin riesgo de intercambiar día y mes.
 *
 * Uso: elige «auditClupikDateFormats» en el editor de Apps Script y pulsa Ejecutar.
 */
function auditClupikDateFormats() {
  const report = aeseClupikDateFormats_();
  Logger.log(report.text);
  return report;
}

function aeseClupikDateFormats_(options) {
  const opts = options || {};
  const deadline = Date.now() + (opts.budgetMs === undefined ? AESE_AUDIT_BUDGET_MS : opts.budgetMs);
  const query = 'from:' + CLUPIK_REMITENTE + ' newer_than:' + (opts.days || AESE_AUDIT_MAX_DAYS) + 'd';
  const known = aeseAuditKnownMatches_();
  const reference = new Map(known.matches.filter(m => m.start).map(m => [actaWPIdentity_(m), m.start.slice(0, 10)]));
  const pad = n => (n < 10 ? '0' : '') + n;
  const seen = new Set(), months = {}, certain = {}, tournaments = {}, ref = {mmdd: 0, ddmm: 0, ninguno: 0, ambosIguales: 0, sinReferencia: 0};
  let withDate = 0, withoutDate = 0, partial = false;
  scan: for (let offset = 0; ; offset += 100) {
    if (Date.now() > deadline) { partial = true; break; }
    const threads = GmailApp.search(query, offset, 100);
    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        if (!/^(?:.*<)?no-reply@clupik\.com>?$/i.test(message.getFrom().trim())) continue;
        const id = message.getId();
        if (seen.has(id)) continue;
        seen.add(id);
        if (!/partid|match/i.test(message.getSubject() || '')) continue;
        const html = message.getBody();
        const text = aeseClupikBlocks_(html).find(b => /^\d{2}\/\d{2}\/\d{4}$/.test(b));
        if (!text) { withoutDate++; continue; }
        withDate++;
        const parts = text.split('/').map(Number), a = parts[0], b = parts[1], year = parts[2];
        const kind = a > 12 ? 'DD/MM seguro' : b > 12 ? 'MM/DD seguro' : a === b ? 'igual' : 'ambiguo';
        const at = message.getDate().toISOString(), month = at.slice(0, 7);
        months[month] = months[month] || {};
        months[month][kind] = (months[month][kind] || 0) + 1;
        if (kind.endsWith('seguro')) {
          const c = certain[kind] || {first: at, last: at};
          if (at < c.first) c.first = at;
          if (at > c.last) c.last = at;
          certain[kind] = c;
        }
        let identity = null;
        try { const i = clupikIdentity_(html); identity = i.tournament_id + ':' + i.match_id; } catch (error) { /* sin identidad */ }
        const tournament = identity ? identity.split(':')[0] : 'sin identidad';
        tournaments[tournament] = tournaments[tournament] || {};
        tournaments[tournament][kind] = (tournaments[tournament][kind] || 0) + 1;
        if (kind === 'ambiguo' || kind === 'DD/MM seguro' || kind === 'MM/DD seguro') {
          const day = identity && reference.get(identity);
          if (!day) ref.sinReferencia++;
          else {
            const ddmm = year + '-' + pad(b) + '-' + pad(a), mmdd = year + '-' + pad(a) + '-' + pad(b);
            if (day === ddmm && day === mmdd) ref.ambosIguales++;
            else if (day === mmdd) ref.mmdd++;
            else if (day === ddmm) ref.ddmm++;
            else ref.ninguno++;
          }
        }
        if (Date.now() > deadline) { partial = true; break scan; }
      }
    }
    if (threads.length < 100) break;
  }
  const lines = ['FORMATO DE LAS FECHAS EN LOS AVISOS DE CLUPIK (solo lectura)', ''];
  lines.push('Avisos de partido con fecha: ' + withDate + '. Sin fecha: ' + withoutDate + '.' +
    (partial ? ' INFORME PARCIAL: se agotó el tiempo; vuelve a ejecutarlo.' : ''));
  lines.push('');
  lines.push('Por mes de llegada del aviso:');
  for (const m of Object.keys(months).sort()) {
    lines.push(' - ' + m + ': ' + Object.keys(months[m]).sort().map(k => k + ' ' + months[m][k]).join(' · '));
  }
  lines.push('');
  for (const k of Object.keys(certain).sort()) lines.push(k + ': del ' + certain[k].first.slice(0, 10) + ' al ' + certain[k].last.slice(0, 10) + '.');
  lines.push('');
  lines.push('Por torneo (identificador de la competición):');
  for (const t of Object.keys(tournaments).sort()) {
    const x = tournaments[t];
    lines.push(' - ' + t + ': DD/MM ' + (x['DD/MM seguro'] || 0) + ' · MM/DD ' + (x['MM/DD seguro'] || 0) +
      ' · ambiguos ' + ((x['ambiguo'] || 0) + (x['igual'] || 0)) + ((x['DD/MM seguro'] && x['MM/DD seguro']) ? ' · MEZCLA' : ''));
  }
  lines.push('');
  lines.push('Frente al paquete oficial (' + known.source + '): la lectura mes/día coincide en ' + ref.mmdd + ', la lectura día/mes en ' +
    ref.ddmm + ', ninguna en ' + ref.ninguno + ', las dos dan la misma fecha en ' + ref.ambosIguales + ', y ' + ref.sinReferencia + ' avisos no tienen partido de referencia.');
  return {text: lines.join('\n'), partial: partial, withDate: withDate, withoutDate: withoutDate, months: months, certain: certain, tournaments: tournaments, reference: ref};
}

/** Diagnóstico de solo lectura: ¿qué distingue un aviso con fecha día/mes de uno con mes/día?
 *
 * Enseña, para unos pocos avisos de cada formato, el idioma declarado del correo, algunas
 * cabeceras que no identifican a nadie (dominio del identificador, programa de envío) y el
 * trozo de HTML que rodea a la fecha, con enlaces y estilos ocultos. Sirve para saber si
 * hay una pista fiable para leer la fecha sin adivinar.
 *
 * Uso: elige «auditClupikDateDetail» en el editor de Apps Script y pulsa Ejecutar.
 */
function auditClupikDateDetail() {
  const report = aeseClupikDateDetail_();
  Logger.log(report.text);
  return report;
}

function aeseClupikMask_(html) {
  return html.replace(/(href|src|style|class|width|height|align|valign|bgcolor|cellpadding|cellspacing|border)\s*=\s*("[^"]*"|'[^']*')/gi, '$1=…')
    .replace(/https?:\/\/[^\s"'<>]+/gi, 'URL').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'EMAIL').replace(/\s+/g, ' ');
}

function aeseClupikHeaderHints_(message) {
  let raw = '';
  try { raw = message.getRawContent() || ''; } catch (error) { return ['(cabeceras no disponibles: ' + error.message + ')']; }
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const out = [];
  const pick = (name, transform) => {
    const m = head.match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
    if (m) out.push(name + ': ' + (transform ? transform(m[1]) : m[1]).slice(0, 80));
  };
  pick('Message-ID', v => v.replace(/^<[^@]*@/, '<…@'));
  pick('X-Mailer'); pick('User-Agent'); pick('Content-Language');
  pick('Return-Path', v => v.replace(/^<[^@]*@/, '<…@'));
  pick('List-Unsubscribe', v => (v.match(/https?:\/\/([^\/>]+)/) || ['', '?'])[1]);
  pick('Content-Type', v => v.split(';')[0]);
  const keys = (head.match(/^X-[A-Za-z0-9-]+/gim) || []).map(k => k.toLowerCase()).filter((k, i, a) => a.indexOf(k) === i);
  if (keys.length) out.push('cabeceras X-: ' + keys.join(', '));
  return out;
}

function aeseClupikDateDetail_(options) {
  const opts = options || {};
  const perFormat = opts.perFormat || 3;
  const deadline = Date.now() + (opts.budgetMs === undefined ? AESE_AUDIT_BUDGET_MS : opts.budgetMs);
  const query = 'from:' + CLUPIK_REMITENTE + ' newer_than:' + (opts.days || AESE_AUDIT_MAX_DAYS) + 'd';
  const samples = {'DD/MM seguro': [], 'MM/DD seguro': []};
  const seen = new Set();
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
        if (!/partid|match/i.test(message.getSubject() || '')) continue;
        const text = aeseClupikBlocks_(message.getBody()).find(b => /^\d{2}\/\d{2}\/\d{4}$/.test(b));
        if (!text) continue;
        const parts = text.split('/').map(Number);
        const kind = parts[0] > 12 ? 'DD/MM seguro' : parts[1] > 12 ? 'MM/DD seguro' : null;
        if (!kind) continue;
        samples[kind].push({message: message, text: text, at: message.getDate().toISOString()});
        samples[kind].sort((x, y) => y.at.localeCompare(x.at));
        samples[kind].length = Math.min(samples[kind].length, perFormat);
        if (Date.now() > deadline) { partial = true; break scan; }
      }
    }
    if (threads.length < 100) break;
  }
  const lines = ['QUÉ DISTINGUE LOS DOS FORMATOS DE FECHA (solo lectura)', ''];
  if (partial) lines.push('INFORME PARCIAL: se agotó el tiempo; vuelve a ejecutarlo.', '');
  const described = [];
  for (const kind of Object.keys(samples)) {
    for (const s of samples[kind]) {
      const html = s.message.getBody();
      const lang = (html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)/i) || ['', 'sin lang'])[1];
      const metaLang = (html.match(/<meta[^>]+content-language[^>]*>/i) || ['sin meta'])[0].slice(0, 80);
      const masked = aeseClupikMask_(html), i = masked.indexOf(s.text);
      const around = masked.slice(Math.max(0, i - 450), i + 160);
      const hints = aeseClupikHeaderHints_(s.message);
      described.push({kind: kind, at: s.at, lang: lang, hints: hints, around: around});
      lines.push(kind + ' · aviso del ' + s.at.slice(0, 10) + ' · fecha «' + s.text + '» · asunto «' + (s.message.getSubject() || '').replace(/\d+/g, '#') + '» · html lang: ' + lang + ' · ' + metaLang);
      lines.push('  cabeceras: ' + (hints.length ? hints.join(' | ') : 'ninguna'));
      for (let p = 0; p < around.length; p += 170) lines.push('  html: ' + around.slice(p, p + 170));
      lines.push('');
    }
  }
  return {text: lines.join('\n'), partial: partial, samples: described};
}
