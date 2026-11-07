(() => {
  const team = document.getElementById('schedule-team');
  const period = document.getElementById('schedule-period');
  const status = document.getElementById('schedule-status');
  const list = document.getElementById('schedule-list');
  const refresh = document.getElementById('schedule-refresh');
  let matches = [], loading = false;
  const node = (tag, text) => { const n = document.createElement(tag); n.textContent = text; return n; };
  const day = date => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Madrid'}).format(date);
  const format = new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'});
  function paint() {
    const today = day(new Date());
    const chosen = matches.filter(m => (team.value === 'all' || m.category === team.value) && (period.value === 'all' || day(new Date(m.start)) >= today));
    list.replaceChildren();
    const count = node('p', `${chosen.length} partidos para estos filtros · Horario de Barcelona.`);
    list.append(count);
    if (!chosen.length) list.append(node('p','No hay partidos con fecha confirmada para estos filtros. Puedes consultar toda la temporada o la web de la FCN.'));
    for (const m of chosen) {
      const row = document.createElement('article'); row.className = 'match-row';
      row.dataset.matchId = `${m.tournament_id}:${m.match_id}`;
      const time = node('time',format.format(new Date(m.start))); time.dateTime = m.start;
      const link = node('a','Ver partido en FCN ↗'); link.href = m.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      row.append(time,node('p',`${m.home_team} — ${m.away_team}`),node('small',`${m.category} · ${m.round_name || ''}`),node('p',`Piscina: ${m.venue}`));
      if (m.status === 'cancelled') row.append(node('strong','CANCELADO'));
      if (m.status === 'tentative') row.append(node('strong','APLAZADO / POR CONFIRMAR'));
      row.append(link); list.append(row);
    }
  }
  async function load() {
    if (loading) return;
    loading = true; refresh.disabled = true;
    status.textContent = 'Comprobando calendarios…';
    try {
      const response = await fetch('./calendars/matches.json',{cache:'no-store',signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw Error('HTTP '+response.status);
      const data = await response.json();
      const ids = new Set();
      if (data.schema_version !== 1 || !Array.isArray(data.matches) || data.total !== data.matches.length || !data.total) throw Error('Calendario incompleto');
      for (const m of data.matches) {
        const id = `${m.tournament_id}:${m.match_id}`;
        if (ids.has(id) || !Number.isSafeInteger(m.tournament_id) || !Number.isSafeInteger(m.match_id) || !Number.isFinite(Date.parse(m.start)) || !m.category || !m.home_team || !m.away_team || !m.venue || !/^https:\/\/actawp\.natacio\.cat\//.test(m.url)) throw Error('Partido inválido');
        ids.add(id);
      }
      const saved = team.value;
      team.replaceChildren(Object.assign(node('option','Todos los equipos'),{value:'all'}));
      for (const category of [...new Set(data.matches.map(m=>m.category))].sort()) team.append(Object.assign(node('option',category),{value:category}));
      team.value = [...team.options].some(o=>o.value===saved) ? saved : 'all';
      matches = data.matches.slice().sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.match_id-b.match_id);
      paint();
      status.textContent = `${data.total} partidos publicados · Consulta realizada a las ${new Intl.DateTimeFormat('es-ES',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit'}).format(new Date())}. Fuente: FCN y avisos oficiales de Clupik.`;
    } catch (error) {
      // Una lectura fallida no se presenta como una sincronización correcta.
      status.textContent = 'No se han podido comprobar los calendarios. Revisa la conexión y pulsa Actualizar partidos.';
      if (matches.length) status.textContent += ' La lista conserva la última consulta de esta sesión.';
      else list.replaceChildren();
      console.warn('[AESE] Calendario oficial:',error.message);
    } finally { loading = false; refresh.disabled = false; }
  }
  team.addEventListener('change',paint); period.addEventListener('change',paint);
  refresh.addEventListener('click',load);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) load();});
  setInterval(()=>{if(!document.hidden) load();},5*60000);
  load();
})();
