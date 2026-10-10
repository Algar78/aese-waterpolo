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
                           ('ATTEMPT_STATUS', root/'attempt.json'), ('DISCOVERY', root/'groups.json')]:
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

    def test_success_after_429_restores_both_publication_and_attempt(self):
        with patch.object(exporter, 'fetch_category', side_effect=RuntimeError('HTTP 429')):
            with self.assertRaises(RuntimeError):
                exporter.main()
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched):
            exporter.main()
        status = json.loads(exporter.STATUS.read_text(encoding='utf-8'))
        rows = json.loads(exporter.OUT.read_text(encoding='utf-8'))
        self.assertTrue(status['complete'])
        self.assertEqual(status, json.loads(exporter.ATTEMPT_STATUS.read_text(encoding='utf-8')))
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

    def test_fresh_cache_each_export(self):
        exporter.CACHE[(1,2)] = 'stale'
        with patch.object(exporter, 'fetch_category', side_effect=self.fetched): exporter.main()
        self.assertEqual(exporter.CACHE, {})


if __name__ == '__main__':
    unittest.main()
