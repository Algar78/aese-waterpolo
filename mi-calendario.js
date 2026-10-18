(() => {
  const storageKey = 'aese-calendar-categories-v1';
  const categories = document.getElementById('categories');
  const links = document.getElementById('links');
  const message = document.getElementById('message');
  let selected = new Set();
  try { const saved = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (Array.isArray(saved)) selected = new Set(saved); } catch {}
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
  function renderLinks(items) {
    links.replaceChildren(); message.textContent = '';
    const chosen = items.filter(item => selected.has(item.slug));
    if (!chosen.length) links.append(element('p','Selecciona una o varias categorías para ver sus enlaces.'));
    for (const item of chosen) {
      const row = element('div',null,'feed'); row.append(element('h3',item.name));
      const input = element('input',null,'url'); input.value = item.url; input.readOnly = true; input.setAttribute('aria-label',`Enlace de ${item.name}`); row.append(input);
      const copy = element('button','Copiar enlace'); copy.type = 'button';
      copy.addEventListener('click',async () => { try { await navigator.clipboard.writeText(item.url); message.textContent = `Enlace copiado: ${item.name}`; } catch { input.focus(); input.select(); message.textContent = 'Mantén pulsado el enlace seleccionado y elige Copiar.'; } });
      const apple = element('a','Suscribir en iPhone','action'); apple.href = item.url.replace(/^https:/,'webcal:');
      row.append(copy,apple); links.append(row);
    }
  }
  // "Validado" no dice cuándo se leyeron por última vez los datos oficiales; esto sí.
  function freshness(data) {
    const stamp = Date.parse(data.last_complete_export_at || ''), hours = Number.isFinite(stamp) ? (Date.now() - stamp) / 3600000 : null;
    const when = hours === null ? 'fecha desconocida' : new Intl.DateTimeFormat('es-ES', {timeZone:'Europe/Madrid', dateStyle:'short', timeStyle:'short'}).format(stamp);
    const age = hours === null ? '' : hours < 48 ? ` (hace ${Math.max(1, Math.round(hours))} h)` : ` (hace ${Math.round(hours / 24)} días)`;
    const nodes = [element('span', `${data.total} partidos · ${data.categories.length} categorías. Última lectura completa de la web oficial: ${when}${age}.`)];
    // The limit travels with the data (published by the exporter), so a weekly manual reading is not flagged as stale after two days.
    const limit = Number(data.freshness_policy && data.freshness_policy.outdated_hours) > 0 ? Number(data.freshness_policy.outdated_hours) : 48;
    if (hours === null || hours > limit) nodes.push(element('strong', ' Los datos pueden no incluir cambios recientes: confirma fecha y hora en el enlace oficial de tu categoría.'));
    const pending = Array.isArray(data.pending_matches) ? data.pending_matches : [];
    if (pending.length) {
      const byCategory = new Map();
      for (const item of pending) byCategory.set(item.category, (byCategory.get(item.category) || 0) + 1);
      const list = [...byCategory].map(([name, count]) => `${name} (${count})`).join(', ');
      nodes.push(element('span', ` Pendientes de rival o fecha en la FCN, aún sin evento: ${list}.`));
    }
    return nodes;
  }
  fetch('./calendars/index.json',{cache:'no-store'}).then(response => { if (!response.ok) throw Error(); return response.json(); }).then(data => {
    if (!Array.isArray(data.categories) || data.categories.length !== 9) throw Error();
    categories.replaceChildren(element('legend','Mis categorías'));
    selected = new Set([...selected].filter(slug => data.categories.some(item => item.slug === slug)));
    for (const item of data.categories) {
      const label = element('label',null,'choice'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.slug); checkbox.value = item.slug;
      const text = element('span',item.name); text.append(element('small',`${item.count} partidos`)); label.append(checkbox,text); categories.append(label);
      checkbox.addEventListener('change',() => { if (checkbox.checked) selected.add(item.slug); else selected.delete(item.slug); try { localStorage.setItem(storageKey,JSON.stringify([...selected])); } catch {} renderLinks(data.categories); });
    }
    document.getElementById('snapshot').replaceChildren(...freshness(data));
    renderLinks(data.categories);
  }).catch(() => { categories.replaceChildren(element('legend','Mis categorías'),element('p','No se han podido cargar los calendarios. Comprueba la conexión y recarga la página.')); });
})();
