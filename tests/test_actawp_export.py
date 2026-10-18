"""Offline regressions: failed requests must preserve the published snapshot."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import actawp_export as exporter


class ExportSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.matches = json.loads(Path('data/actawp_matches.json').read_text(encoding='utf-8'))
        self.status = json.loads(Path('data/actawp_export_status.json').read_text(encoding='utf-8'))
        for name, path in [('OUT', root/'matches.json'), ('STATUS', root/'status.json'),
                           ('ATTEMPT_STATUS', root/'attempt.json'), ('DISCOVERY', root/'groups.json'),
                           ('IGNORED_ROWS', root/'ignored.json'), ('POLICY', root/'policy.json')]:
            mock = patch.object(exporter, name, path)
            mock.start()
            self.addCleanup(mock.stop)
        exporter.save_json(exporter.OUT, self.matches)
        exporter.save_json(exporter.STATUS, self.status)
        self.before = (exporter.OUT.read_bytes(), exporter.STATUS.read_bytes())
        mock = patch.object(exporter.time, 'sleep')
        mock.start()
        self.addCleanup(mock.stop)

    def fetched(self, category, tournament, default, overrides):
        rows = [SimpleNamespace(to_dict=lambda m=m: m) for m in self.matches if m['category'] == category]
        return rows, default

    def assert_preserved(self):
        self.assertEqual(self.before, (exporter.OUT.read_bytes(), exporter.STATUS.read_bytes()))
        self.assertFalse(json.loads(exporter.ATTEMPT_STATUS.read_text(encoding='utf-8'))['complete'])

    def test_429_preserves_snapshot_and_validation_and_stops_requests(self):
        with patch.object(exporter, 'fetch_category', side_effect=RuntimeError('HTTP 429')) as fetch:
            with self.assertRaisesRegex(RuntimeError, 'incompleta'):
                exporter.main()
        self.assertEqual(fetch.call_count, 1)
        self.assert_preserved()

    def test_partial_export_preserves_snapshot_and_validation(self):
        def partial(category, *args):
            return ([], None) if category == 'Juvenil Masculino' else self.fetched(category, *args)
        with patch.object(exporter, 'fetch_category', side_effect=partial):
            with self.assertRaisesRegex(RuntimeError, 'incompleta'):
                exporter.main()
        self.assert_preserved()

    def test_real_incomplete_aese_rows_preserve_publication(self):
        for match_id in (145573588, 145573633):
            value = (Path(__file__).parent / f'fixtures/aese-{match_id}-incomplete.html').read_text(encoding='utf-8')
            def incomplete(category, tournament, default, overrides):
                if category == 'Absoluto Masculino':
                    return exporter.parse_calendar_html(value, category, tournament, default), default
                return self.fetched(category, tournament, default, overrides)
            with self.subTest(match_id=match_id):
                with patch.object(exporter, 'fetch_category', side_effect=incomplete):
                    with self.assertRaisesRegex(RuntimeError, 'incompleta'):
                        exporter.main()
                self.assert_preserved()
                attempt = json.loads(exporter.ATTEMPT_STATUS.read_text(encoding='utf-8'))
                self.assertTrue(any(str(match_id) in error for error in attempt['errors']))

    def test_success_after_429_restores_both_publication_and_attempt(self):
        with patch.object(exporter, 'fetch_category', side_effect=RuntimeError('HTTP 429')):
            with self.assertRaises(RuntimeError):
                exporter.main()
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched):
            exporter.main()
        status = json.loads(exporter.STATUS.read_text(encoding='utf-8'))
        rows = json.loads(exporter.OUT.read_text(encoding='utf-8'))
        self.assertTrue(status['complete'])
        attempt = json.loads(exporter.ATTEMPT_STATUS.read_text(encoding='utf-8'))
        # The attempt record also carries bulky row excerpts; the published status does not.
        self.assertEqual(status, {k: v for k, v in attempt.items() if k != 'ignored_rows'})
        self.assertEqual(status['total_matches_found'], len(rows))
        self.assertEqual(sum(status['counts'].values()), len(rows))
        self.assertEqual(len(status['counts']), 9)

    def test_duplicate_identity_is_rejected_without_publication(self):
        def duplicate(category, *args):
            rows, group = self.fetched(category, *args)
            return rows + rows[:1], group
        with patch.object(exporter, 'fetch_category', side_effect=duplicate):
            with self.assertRaises(RuntimeError):
                exporter.main()
        self.assert_preserved()

    def test_one_missing_match_in_nonempty_category_blocks_publication(self):
        def missing(category, *args):
            rows, group = self.fetched(category, *args)
            return (rows[1:] if category == 'Absoluto Masculino' else rows), group
        with patch.object(exporter, 'fetch_category', side_effect=missing):
            with self.assertRaises(RuntimeError): exporter.main()
        self.assert_preserved()

    def test_official_notice_cannot_be_rolled_back_by_stale_source(self):
        target = next(m for m in self.matches if m['match_id'] == 145573561)
        self.status['reviewed_corrections'] = [{
            'identity': '1339803:145573561',
            'previous_start': '2026-10-24T13:30:00+02:00',
            'start': target['start'],
        }]
        exporter.save_json(exporter.STATUS, self.status)
        self.before = (exporter.OUT.read_bytes(), exporter.STATUS.read_bytes())
        def stale(category, *args):
            rows, group = self.fetched(category, *args)
            return [SimpleNamespace(to_dict=lambda m=m: dict(m, start='2026-10-24T13:30:00+02:00') if m['match_id'] == 145573561 else m)
                    for m in self.matches if m['category'] == category], group
        with patch.object(exporter, 'fetch_category', side_effect=stale):
            with self.assertRaises(RuntimeError): exporter.main()
        self.assert_preserved()

    def attempt(self):
        return json.loads(exporter.ATTEMPT_STATUS.read_text(encoding='utf-8'))

    def test_failure_keeps_age_of_last_official_export_and_counts_failures(self):
        stamp = '2026-10-10T16:25:00+00:00'
        self.status['last_complete_export_at'] = stamp
        exporter.save_json(exporter.STATUS, self.status)
        for expected in (1, 2, 3):
            with patch.object(exporter, 'fetch_category', side_effect=RuntimeError('HTTP 429')):
                with self.assertRaises(RuntimeError): exporter.main()
            attempt = self.attempt()
            self.assertEqual(attempt['last_complete_export_at'], stamp)
            self.assertEqual(attempt['consecutive_failures'], expected)
            self.assertIn('rate_limited', attempt['error_classes'])
        # The published snapshot never moved, and still says how old it is.
        self.assertEqual(json.loads(exporter.STATUS.read_text(encoding='utf-8'))['last_complete_export_at'], stamp)

    def test_success_stamps_last_complete_export_and_resets_failures(self):
        with patch.object(exporter, 'fetch_category', side_effect=RuntimeError('HTTP 429')):
            with self.assertRaises(RuntimeError): exporter.main()
        self.assertEqual(self.attempt()['consecutive_failures'], 1)
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched):
            exporter.main()
        status = json.loads(exporter.STATUS.read_text(encoding='utf-8'))
        self.assertEqual(status['consecutive_failures'], 0)
        self.assertEqual(status['error_classes'], [])
        self.assertEqual(status['last_complete_export_at'], status['attempted_at'])

    def test_ignored_rows_are_reported_but_do_not_block_publication(self):
        row = {'category': 'Cadete Masculino', 'match_id': 145574487, 'teams_found': ['C.N. X'],
               'aese_mentioned': False, 'row_text': 'C.N. X', 'row_html': '<tr>...</tr>'}
        def fetched(category, *args):
            if category == 'Cadete Masculino':
                exporter.DIAGNOSTICS.append(row)
            return self.fetched(category, *args)
        with patch.object(exporter, 'fetch_category', side_effect=fetched):
            exporter.main()
        status = json.loads(exporter.STATUS.read_text(encoding='utf-8'))
        self.assertTrue(status['complete'])
        self.assertEqual(status['ignored_row_ids'], [145574487])
        self.assertNotIn('ignored_rows', status)          # keeps the Calendar bundle small
        self.assertEqual(self.attempt(), status)           # the publication gate compares them
        evidence = json.loads(exporter.IGNORED_ROWS.read_text(encoding='utf-8'))
        self.assertEqual(evidence['rows'], [row])          # evidence kept for inspection

    def test_aese_row_that_cannot_be_read_blocks_and_is_classified(self):
        def broken(category, *args):
            if category == 'Cadete Masculino':
                raise ValueError('Fila de partido AESE 1 sin dos equipos; snapshot bloqueado')
            return self.fetched(category, *args)
        with patch.object(exporter, 'fetch_category', side_effect=broken):
            with self.assertRaises(RuntimeError): exporter.main()
        self.assert_preserved()
        self.assertEqual(self.attempt()['error_classes'], ['aese_row_unreadable'])

    def test_manual_audit_annotations_survive_automatic_publication(self):
        self.status['official_times_audit'] = {'date': '2026-10-15'}
        exporter.save_json(exporter.STATUS, self.status)
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched):
            exporter.main()
        self.assertEqual(json.loads(exporter.STATUS.read_text(encoding='utf-8'))['official_times_audit'], {'date': '2026-10-15'})

    def test_error_classes(self):
        for text, expected in [
            ('Absoluto: HTTP 429: ActaWP limita temporalmente las consultas', 'rate_limited'),
            ('Alevín: pendiente por límite HTTP 429', 'skipped_after_rate_limit'),
            ('X: Fila de partido AESE 1 sin dos equipos; snapshot bloqueado', 'aese_row_unreadable'),
            ('X: Partido AESE 5: fecha inválida; snapshot bloqueado', 'validation_blocked'),
            ('X: ActaWP detectó un desafío de navegador', 'browser_challenge'),
            ('X: AESE no aparece en los grupos publicados', 'unexpected_structure'),
            ('X: algo raro', 'other'),
        ]:
            self.assertEqual(exporter.classify_error(text), expected, text)

    def test_requests_are_spaced_politely(self):
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched):
            with patch.object(exporter.time, 'sleep') as sleep:
                exporter.main()
        pauses = [call.args[0] for call in sleep.call_args_list]
        self.assertEqual(len(pauses), 8)  # between nine categories
        self.assertTrue(all(pause >= exporter.REQUEST_SPACING_SECONDS for pause in pauses))
        self.assertGreaterEqual(exporter.REQUEST_SPACING_SECONDS, 20)

    def test_fresh_cache_each_export(self):
        exporter.CACHE[(1,2)] = 'stale'
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched): exporter.main()
        self.assertEqual(exporter.CACHE, {})


if __name__ == '__main__':
    unittest.main()
