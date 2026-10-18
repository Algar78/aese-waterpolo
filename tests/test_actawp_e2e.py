"""End-to-end: real HTTP client -> exporter -> data files -> feed generator -> Apps Script validator.

The "ActaWP" here is a local HTTP server that serves pages built to the parser's
contract (table.tabletype-public, data-sort in UTC, visible Madrid time).  The
pages are synthetic: they are NOT a recording of the real site, so they prove
the pipeline's behaviour (publication, blocking, recovery, classification),
not that today's real markup is parsed.  Real-markup evidence is collected by
the exporter itself (ignored_rows / request log) on the first live run.
"""
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import actawp_export as exporter
import actawp_fetch as fetch
import actawp_sync as sync

REPO = Path(__file__).resolve().parent.parent
MATCHES = json.loads((REPO / 'data/actawp_matches.json').read_text(encoding='utf-8'))
OVERRIDES = json.loads((REPO / 'data/actawp_calendar_overrides.json').read_text(encoding='utf-8'))
INCOMPLETE = {  # the three rows reported on 2026-10-18: other clubs' matches with one readable team
    'Absoluto Masculino': (145573548, 'C.N. EQUIPO SIN RIVAL'),
    'Alevín Mixto B': (145608992, 'C.N. EQUIPO SIN RIVAL'),
    'Cadete Masculino': (145574487, 'C.N. EQUIPO SIN RIVAL'),
}


def row(match_id, teams, start_utc, venue, tournament):
    local = start_utc.astimezone(ZoneInfo('Europe/Madrid'))
    cells = ''.join(f'<td class="colstyle-equipo"><span class="ellipsis" title="{t}">{t}</span></td>' for t in teams)
    return (f'<tr>{cells}<td class="colstyle-fecha"><span data-sort="{start_utc:%Y-%m-%d %H:%M:%S}">'
            f'{local:%d/%m/%y %H:%M} GMT+2</span><span class="ellipsis" title="{venue}">sede</span></td>'
            f'<td><a href="/ca/tournament/{tournament}/match/{match_id}/results">Acta</a></td></tr>')


def build_pages():
    pages = {}
    for category, (tournament, default_group) in sync.CALENDARS.items():
        group = int(OVERRIDES.get(category, default_group))
        mine = [m for m in MATCHES if m['category'] == category]
        rounds = {}
        for m in mine:
            utc = datetime.fromisoformat(m['start']).astimezone(timezone.utc)
            rounds.setdefault(m['round_name'], []).append(
                row(m['match_id'], [m['home_team'], m['away_team']], utc, m['venue'], tournament))
        body = ''
        for name, rows in rounds.items():
            extra = [row(9_000_000 + len(rows), ['C.N. OTRO UNO', 'C.N. OTRO DOS'],
                         datetime(2027, 1, 9, 12, 0, tzinfo=timezone.utc), '5 - Otra piscina', tournament)]
            if category in INCOMPLETE and name == mine[0]['round_name']:
                match_id, lone = INCOMPLETE[category]
                extra.append(row(match_id, [lone], datetime(2027, 1, 16, 12, 0, tzinfo=timezone.utc), '5 - Otra piscina', tournament))
            body += f'<h2 class="bottom-bordered">{name}</h2><table class="tabletype-public"><tbody>{"".join(rows + extra)}</tbody></table>'
        pages[(tournament, group)] = f'<html><body>{body}</body></html>'
    return pages


class FakeActaWP:
    """mode: ok | rate_limit | challenge | aese_one_team. Records every request."""
    def __init__(self, pages):
        self.pages, self.mode, self.requests, self.rate_limit_after = pages, 'ok', [], 0
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                outer.requests.append(self.path)
                parts = self.path.split('?')[0].strip('/').split('/')
                try:
                    key = (int(parts[2]), int(parts[4]))
                    page = outer.pages[key]
                except (IndexError, ValueError, KeyError):
                    return self.reply(404, 'not found')
                if outer.mode == 'rate_limit' and len(outer.requests) > outer.rate_limit_after:
                    return self.reply(429, 'Too Many Requests', {'Retry-After': '600', 'Server': 'fake-nginx'})
                if outer.mode == 'challenge':
                    return self.reply(200, "<html>Comprovant el teu navegador <script>RETO='r';FIRMA='f';SEMILLA='s';BITS=8</script></html>")
                if outer.mode == 'aese_one_team':
                    page = page.replace('<span class="ellipsis" title="C.N. MARTORELL">C.N. MARTORELL</span>', '', 1) \
                               .replace('C.N. MARTORELL', '', 1)
                    page = page.replace('<td class="colstyle-equipo"><span class="ellipsis" title="C.N. MARTORELL"></span></td>', '', 1)
                self.reply(200, page)

            def reply(self, code, body, headers=None):
                data = body.encode()
                self.send_response(code)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pages = build_pages()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='aese-e2e-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / 'data').mkdir()
        for name in ('actawp_matches.json', 'actawp_export_status.json', 'actawp_calendar_overrides.json', 'venues.json'):
            shutil.copy(REPO / 'data' / name, self.tmp / 'data' / name)
        shutil.copytree(REPO / 'calendars', self.tmp / 'calendars')
        self.server = FakeActaWP(self.pages)
        self.addCleanup(self.server.close)
        patches = {
            (exporter, 'OUT'): self.tmp / 'data/actawp_matches.json',
            (exporter, 'STATUS'): self.tmp / 'data/actawp_export_status.json',
            (exporter, 'ATTEMPT_STATUS'): self.tmp / 'data/actawp_last_attempt.json',
            (exporter, 'DISCOVERY'): self.tmp / 'data/actawp_calendar_overrides.json',
            (exporter, 'IGNORED_ROWS'): self.tmp / 'data/actawp_ignored_rows.json',
            (exporter, 'POLICY'): self.tmp / 'data/freshness_policy.json',
            (fetch, '_COOLDOWN_PATH'): self.tmp / 'data/actawp_http_cooldowns.json',
            (fetch, '_LOG_PATH'): self.tmp / 'data/actawp_request_log.json',
            (sync, 'BASE_URL'): self.server.url,
            (exporter, 'REQUEST_SPACING_SECONDS'): 0.0,
        }
        for (module, name), value in patches.items():
            p = patch.object(module, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.before = {n: (self.tmp / 'data' / n).read_bytes() for n in ('actawp_matches.json', 'actawp_export_status.json')}

    def read(self, name):
        return json.loads((self.tmp / 'data' / name).read_text(encoding='utf-8'))

    def assert_published_data_untouched(self):
        for name, content in self.before.items():
            self.assertEqual((self.tmp / 'data' / name).read_bytes(), content, name)

    def feeds_and_validator(self):
        """Run the real feed generator, then the real Apps Script validator on its bundle."""
        script = f"""
import {{generate}} from {json.dumps((REPO / 'scripts/calendar-feeds.mjs').as_uri())};
import {{pathToFileURL}} from 'node:url';
generate(pathToFileURL({json.dumps(str(self.tmp) + '/')}));
"""
        subprocess.run(['node', '--input-type=module', '-e', script], check=True, capture_output=True, text=True, cwd=REPO)
        validator = f"""
const fs=require('fs'),vm=require('vm');
const bundle=JSON.parse(fs.readFileSync({json.dumps(str(self.tmp / 'calendars/general-calendar.json'))}));
const ctx=vm.createContext({{console,Date,Set,Number,Intl,JSON,Utilities:{{formatDate:(d,z)=>new Intl.DateTimeFormat('sv-SE',{{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}}).format(d).replace(' ','T')}}}});
vm.runInContext(fs.readFileSync({json.dumps(str(REPO / 'actawp_calendar_sync.gs'))},'utf8'),ctx);
vm.runInContext('ACTAWP_VENUES = '+JSON.stringify(bundle.venues),ctx);
ctx.validateActaWPSnapshot_(bundle.matches,bundle.status);
console.log('OK '+bundle.matches.length);
"""
        result = subprocess.run(['node', '-e', validator], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'OK 80')

    # --- scenarios -------------------------------------------------------
    def test_normal_run_reproduces_the_80_matches_ignores_the_three_foreign_rows_and_validates_downstream(self):
        exporter.main()
        status = self.read('actawp_export_status.json')
        self.assertTrue(status['complete'])
        self.assertEqual(status['errors'], [])
        self.assertEqual(status['ignored_row_ids'], sorted(v[0] for v in INCOMPLETE.values()))
        got = {(m['tournament_id'], m['match_id']): m for m in self.read('actawp_matches.json')}
        want = {(m['tournament_id'], m['match_id']): m for m in MATCHES}
        self.assertEqual(got.keys(), want.keys())
        for key in want:  # includes winter/summer offsets: ActaWP's UTC key vs Madrid wall clock
            self.assertEqual({k: got[key][k] for k in ('start', 'home_team', 'away_team', 'venue', 'round_name')},
                             {k: want[key][k] for k in ('start', 'home_team', 'away_team', 'venue', 'round_name')}, key)
        stamp = datetime.fromisoformat(status['last_complete_export_at'])
        self.assertLess((datetime.now(timezone.utc) - stamp).total_seconds(), 60)
        self.assertEqual(self.read('actawp_last_attempt.json')['consecutive_failures'], 0)
        self.assertEqual(len(self.server.requests), 9)  # one request per category: no discovery loop, no retries
        self.assertFalse(any('_pow_' in r for r in self.server.requests))
        self.feeds_and_validator()
        manifest = json.loads((self.tmp / 'calendars/index.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['last_complete_export_at'], status['last_complete_export_at'])
        ics = (self.tmp / 'calendars/cadete-masculino.ics').read_text(encoding='utf-8')
        self.assertIn('UID:actawp-1339808-145574486@aese-waterpolo', ics)

    def test_rate_limit_midway_publishes_nothing_records_the_real_cause_and_stops_asking(self):
        self.server.mode, self.server.rate_limit_after = 'rate_limit', 3
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        self.assert_published_data_untouched()
        attempt = self.read('actawp_last_attempt.json')
        self.assertFalse(attempt['complete'])
        self.assertIn('rate_limited', attempt['error_classes'])
        self.assertEqual(attempt['consecutive_failures'], 1)
        self.assertEqual(len(self.server.requests), 4)          # 3 good pages + the one answered 429, then stop
        log = self.read('actawp_request_log.json')
        self.assertEqual([e['status'] for e in log], [200, 200, 200, 429])
        self.assertEqual(log[-1]['retry_after'], '600')
        self.assertIn('fake-nginx', log[-1]['server'])
        self.assertIn(f"127.0.0.1:{self.server.server.server_port}", self.read('actawp_http_cooldowns.json'))
        self.feeds_and_validator()                               # downstream still serves the last good data
        # A second run during the cooldown makes no request at all.
        before = len(self.server.requests)
        with self.assertRaises(RuntimeError):
            exporter.main()
        self.assertEqual(len(self.server.requests), before)
        self.assertEqual(self.read('actawp_last_attempt.json')['consecutive_failures'], 2)

    def test_browser_challenge_is_reported_once_and_never_solved(self):
        self.server.mode = 'challenge'
        with self.assertRaises(RuntimeError):
            exporter.main()
        self.assert_published_data_untouched()
        self.assertEqual(len(self.server.requests), 1)
        self.assertFalse(any('_pow_' in r for r in self.server.requests))
        attempt = self.read('actawp_last_attempt.json')
        self.assertIn('browser_challenge', attempt['error_classes'])
        self.assertTrue(self.read('actawp_request_log.json')[0]['challenge'])

    def test_aese_row_that_cannot_be_read_blocks_publication(self):
        self.server.mode = 'aese_one_team'
        with self.assertRaises(RuntimeError):
            exporter.main()
        self.assert_published_data_untouched()
        self.assertIn('aese_row_unreadable', self.read('actawp_last_attempt.json')['error_classes'])

    def test_recovery_after_failures_publishes_and_resets_the_counters(self):
        self.server.mode, self.server.rate_limit_after = 'rate_limit', 0
        with self.assertRaises(RuntimeError): exporter.main()
        self.server.mode = 'ok'
        (self.tmp / 'data/actawp_http_cooldowns.json').unlink()
        exporter.main()
        status = self.read('actawp_export_status.json')
        self.assertTrue(status['complete'])
        self.assertEqual(status['consecutive_failures'], 0)


if __name__ == '__main__':
    unittest.main()
