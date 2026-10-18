"""Reading ActaWP pages that a person saved by hand: no request is made, nothing else changes.

This is the path that keeps the calendar verifiable against the official source
without any automated access to it. The saved pages here are synthetic (see
test_actawp_e2e) except the incomplete rows, which are the real excerpts from
tests/fixtures.
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import actawp_export as exporter
import actawp_sync as sync
from test_actawp_e2e import MATCHES, OVERRIDES, REPO, build_pages

FIXTURES = REPO / 'tests/fixtures'
spec = importlib.util.spec_from_file_location('validate_actawp_export', REPO / 'scripts/validate_actawp_export.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def fixture_rows(name):
    return re.search(r'<tbody>(.*)</tbody>', (FIXTURES / name).read_text(encoding='utf-8'), re.S).group(1)


class ManualImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pages = build_pages()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='aese-manual-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / 'data').mkdir()
        for name in ('actawp_matches.json', 'actawp_export_status.json', 'actawp_calendar_overrides.json'):
            shutil.copy(REPO / 'data' / name, self.tmp / 'data' / name)
        self.manual = self.tmp / 'manual'
        self.manual.mkdir()
        for category, (tournament, default_group) in sync.CALENDARS.items():
            group = int(OVERRIDES.get(category, default_group))
            self.page(category, self.pages[(tournament, group)])
        patches = {
            'OUT': self.tmp / 'data/actawp_matches.json',
            'STATUS': self.tmp / 'data/actawp_export_status.json',
            'ATTEMPT_STATUS': self.tmp / 'data/actawp_last_attempt.json',
            'DISCOVERY': self.tmp / 'data/actawp_calendar_overrides.json',
            'IGNORED_ROWS': self.tmp / 'data/actawp_ignored_rows.json',
            'POLICY': self.tmp / 'data/freshness_policy.json',
            'MANUAL_DIR': self.manual,
        }
        for name, value in patches.items():
            p = patch.object(exporter, name, value)
            p.start()
            self.addCleanup(p.stop)
        # Reading saved pages must never touch the network or wait.
        for target in ('fetch_html',):
            p = patch.object(exporter, target, side_effect=AssertionError('se hizo una petición de red'))
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(exporter.time, 'sleep', side_effect=AssertionError('no debe haber esperas'))
        p.start()
        self.addCleanup(p.stop)
        self.before = {n: (self.tmp / 'data' / n).read_bytes() for n in ('actawp_matches.json', 'actawp_export_status.json')}

    def page(self, category, html):
        (self.manual / exporter.manual_filename(category)).write_text(html, encoding='utf-8')

    def read(self, name):
        return json.loads((self.tmp / 'data' / name).read_text(encoding='utf-8'))

    def assert_published_data_untouched(self):
        for name, content in self.before.items():
            self.assertEqual((self.tmp / 'data' / name).read_bytes(), content, name)

    def absoluto_group(self):
        tournament, default_group = sync.CALENDARS['Absoluto Masculino']
        return tournament, int(OVERRIDES.get('Absoluto Masculino', default_group))

    def with_rows(self, rows, category='Absoluto Masculino'):
        key = (sync.CALENDARS[category][0], int(OVERRIDES.get(category, sync.CALENDARS[category][1])))
        self.page(category, self.pages[key].replace('</tbody>', rows + '</tbody>', 1))

    # --- the normal case ----------------------------------------------------
    def test_saved_pages_reproduce_the_80_matches_without_any_request(self):
        exporter.main()
        status = self.read('actawp_export_status.json')
        self.assertTrue(status['complete'])
        self.assertEqual(len(self.read('actawp_matches.json')), 80)
        self.assertEqual({(m['tournament_id'], m['match_id']) for m in self.read('actawp_matches.json')},
                         {(m['tournament_id'], m['match_id']) for m in MATCHES})
        self.assertEqual(status['source']['mode'], 'manual_import')
        self.assertEqual(sorted(status['source']['files']), sorted(exporter.manual_filename(c) for c in sync.CALENDARS))
        self.assertEqual(self.read('actawp_last_attempt.json'), status)   # the publication gate needs this
        gate.validate(self.tmp, 'true')                                   # and it passes
        self.assertEqual(status['pending_matches'], [])

    def test_freshness_policy_travels_with_the_status(self):
        exporter.main()
        self.assertEqual(self.read('actawp_export_status.json')['freshness_policy'],
                         {'fresh_hours': 12, 'outdated_hours': 48, 'reminder_hours': 48})  # no policy file: defaults
        (self.tmp / 'data/freshness_policy.json').write_text(
            json.dumps({'fresh_hours': 192, 'outdated_hours': 360, 'reminder_hours': 168}), encoding='utf-8')
        exporter.main()
        self.assertEqual(self.read('actawp_export_status.json')['freshness_policy']['outdated_hours'], 360)
        (self.tmp / 'data/freshness_policy.json').write_text(
            json.dumps({'fresh_hours': 100, 'outdated_hours': 50}), encoding='utf-8')   # inverted: unusable
        exporter.main()
        self.assertEqual(self.read('actawp_export_status.json')['freshness_policy']['outdated_hours'], 48)

    # --- matches ActaWP lists without rival and/or date ---------------------
    def test_aese_matches_without_rival_or_date_are_shown_as_pending_and_do_not_block(self):
        self.with_rows(fixture_rows('aese-145573588-incomplete.html') + fixture_rows('aese-145573633-incomplete.html')
                       + fixture_rows('granollers-incomplete.html'))
        exporter.main()
        status = self.read('actawp_export_status.json')
        self.assertTrue(status['complete'])
        self.assertEqual(status['errors'], [])
        self.assertEqual(len(self.read('actawp_matches.json')), 80)       # nothing invented, nothing lost
        pending = status['pending_matches']
        self.assertEqual([p['match_id'] for p in pending], [145573588, 145573633])
        self.assertTrue(all(p['reason'] == 'sin_rival_ni_fecha' and p['category'] == 'Absoluto Masculino' for p in pending))
        self.assertIn('145573548', ','.join(map(str, status['ignored_row_ids'])))   # the other club's row stays ignored, visibly
        gate.validate(self.tmp, 'true')

    def test_pending_match_that_used_to_have_a_date_is_not_silently_dropped(self):
        known = next(m for m in MATCHES if m['category'] == 'Absoluto Masculino')
        key = self.absoluto_group()
        html = self.pages[key]
        html = re.sub(rf'<tr>(?:(?!</tr>).)*match/{known["match_id"]}/results.*?</tr>', '', html, count=1, flags=re.S)
        undated = fixture_rows('aese-145573588-incomplete.html').replace('145573588', str(known['match_id']))
        self.page('Absoluto Masculino', html.replace('</tbody>', undated + '</tbody>', 1))
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        self.assertIn('desaparecidos', json.dumps(self.read('actawp_last_attempt.json')['errors']))
        self.assert_published_data_untouched()

    def test_an_aese_row_that_is_damaged_rather_than_undated_still_blocks(self):
        damaged = fixture_rows('aese-145573588-incomplete.html').replace(
            '5 9999-99-99 99:99:99 A.E. SANTA EULÀLIA', '2026-12-05 10:00:00')   # has a date, lost its rival
        self.with_rows(damaged)
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        self.assertEqual(self.read('actawp_last_attempt.json')['error_classes'], ['aese_row_unreadable'])
        self.assert_published_data_untouched()

    # --- mistakes a person can make -----------------------------------------
    def test_missing_file_publishes_nothing_and_names_the_file(self):
        (self.manual / exporter.manual_filename('Cadete Masculino')).unlink()
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        errors = self.read('actawp_last_attempt.json')['errors']
        self.assertTrue(any('cadete-masculino.html' in e for e in errors), errors)
        self.assert_published_data_untouched()

    def test_page_saved_under_the_wrong_name_is_rejected(self):
        cadete, absoluto = (self.manual / exporter.manual_filename(c) for c in ('Cadete Masculino', 'Absoluto Masculino'))
        cadete_html, absoluto_html = cadete.read_text(encoding='utf-8'), absoluto.read_text(encoding='utf-8')
        cadete.write_text(absoluto_html, encoding='utf-8')
        absoluto.write_text(cadete_html, encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        self.assertTrue(any('no corresponde' in e for e in self.read('actawp_last_attempt.json')['errors']))
        self.assert_published_data_untouched()

    def test_saved_challenge_or_error_page_is_rejected(self):
        self.page('Juvenil Masculino', '<html>Comprovant el teu navegador</html>')
        with self.assertRaisesRegex(RuntimeError, 'incompleta'):
            exporter.main()
        self.assertTrue(any('tabla pública' in e for e in self.read('actawp_last_attempt.json')['errors']))
        self.assert_published_data_untouched()


class CommandLineTests(unittest.TestCase):
    def run_cli(self, *argv, env=None):
        out = io.StringIO()
        with patch.dict('os.environ', env or {}, clear=False), contextlib.redirect_stdout(out):
            code = exporter.cli(list(argv))
        return code, out.getvalue()

    def test_automated_access_is_off_unless_explicitly_authorized(self):
        env = {k: v for k, v in os.environ.items() if k != 'ACTAWP_AUTOMATED_ACCESS_AUTHORIZED'}
        with patch.dict('os.environ', env, clear=True), \
             patch.object(exporter, 'main', side_effect=AssertionError('no debe ejecutarse')):
            code, output = self.run_cli()
        self.assertEqual(code, 2)
        self.assertIn('desactivado', output)

    def test_authorization_flag_enables_the_old_behaviour(self):
        with patch.object(exporter, 'main') as main:
            code, _ = self.run_cli(env={'ACTAWP_AUTOMATED_ACCESS_AUTHORIZED': 'yes'})
        self.assertEqual(code, 0)
        main.assert_called_once()

    def test_list_manual_prints_one_line_per_category_with_its_url(self):
        code, output = self.run_cli('--list-manual')
        self.assertEqual(code, 0)
        lines = [l for l in output.splitlines() if '.html' in l]
        self.assertEqual(len(lines), len(sync.CALENDARS))
        self.assertTrue(all('https://actawp.natacio.cat/' in l for l in lines))
        self.assertIn('alevin-mixto-a.html', output)
        self.assertIn('1a-div-fem-absoluta-b.html', output)

    def test_from_dir_sets_the_source_and_runs_the_exporter(self):
        with patch.object(exporter, 'main') as main:
            code, _ = self.run_cli('--from-dir', '/algun/directorio')
            self.assertEqual(code, 0)
            main.assert_called_once()
        self.assertEqual(str(exporter.MANUAL_DIR), '/algun/directorio')
        exporter.MANUAL_DIR = None


if __name__ == '__main__':
    unittest.main()
