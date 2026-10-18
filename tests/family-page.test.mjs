import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// La página de las familias solo dice qué hay en el calendario. Que la última
// lectura oficial sea antigua es cosa de quien mantiene el sistema (estado.html y
// el correo a la dirección de alertas): no debe aparecer ningún aviso para ellas.
const source = readFileSync(new URL('../mi-calendario.js', import.meta.url), 'utf8');
const node = tag => ({ tag, textContent: '', className: '', children: [], value: '', append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {}, focus() {}, select() {} });
const text = n => (typeof n === 'string' ? n : n.textContent + n.children.map(text).join(''));

async function render(data) {
  const els = { categories: node('fieldset'), links: node('div'), message: node('p'), snapshot: node('p') };
  const context = {
    document: { getElementById: id => els[id], createElement: node },
    localStorage: { getItem: () => null, setItem() {} }, navigator: {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(data) }),
    Intl, Date, Set, Map, JSON, Array, Number, Error, Promise
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setTimeout(resolve, 20));
  return text(els.snapshot);
}
const base = () => ({
  total: 80,
  categories: Array.from({ length: 9 }, (_, i) => ({ slug: 'c' + i, name: 'Categoría ' + i, count: 9, url: 'https://example.test/' + i + '.ics' })),
  freshness_policy: { fresh_hours: 192, outdated_hours: 360 }
});

test('las familias no ven aviso de datos antiguos, tenga la lectura la edad que tenga o no se conozca', async () => {
  for (const stamp of ['2020-01-01T00:00:00Z', new Date().toISOString(), undefined]) {
    const shown = await render({ ...base(), last_complete_export_at: stamp });
    assert.match(shown, /80 partidos · 9 categorías/);
    assert.doesNotMatch(shown, /pueden no incluir|cambios recientes|hace \d|lectura|desconocida/i);
  }
});

test('los partidos pendientes de rival o fecha siguen apareciendo para las familias', async () => {
  const shown = await render({ ...base(), last_complete_export_at: '2020-01-01T00:00:00Z', pending_matches: [{ category: 'Alevín Mixto B' }, { category: 'Alevín Mixto B' }] });
  assert.match(shown, /Pendientes de rival o fecha en la FCN, aún sin evento: Alevín Mixto B \(2\)/);
});
