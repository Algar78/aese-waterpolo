import unittest
from pathlib import Path
from unittest.mock import patch
import actawp_fetch as fetcher
from actawp_sync import parse_calendar_html

def html(date='2026-10-10 10:15:00', extra=''):
    return '''<table class="tabletype-public"><tbody><tr>
    <td class="colstyle-equipo"><span class="ellipsis" title="A.E. SANTA EULÀLIA">AESE</span></td>
    <td class="colstyle-equipo"><span class="ellipsis" title="C.N. RIVAL">Rival</span></td>
    <td class="colstyle-fecha"><span data-sort="%s">10/10/26 12:15 GMT+2</span>
    <span class="ellipsis" title="228 - Santa Eulàlia, AE">Piscina</span>%s</td>
    <td><a href="/ca/tournament/1/match/123/results">Acta</a></td>
    </tr></tbody></table>''' % (date,extra)

class ParserSafetyTests(unittest.TestCase):
    def parse(self, value): return parse_calendar_html(value,'Absoluto Masculino',1,2)
    def incomplete(self):
        return (Path(__file__).parent / 'fixtures/granollers-incomplete.html').read_text(encoding='utf-8')

    def test_incomplete_third_party_with_null_date_is_ignored(self):
        self.assertEqual(self.parse(self.incomplete()), [])
        self.assertEqual([m.match_id for m in self.parse(self.incomplete() + html())], [123])

    def test_incomplete_aese_blocks_even_with_results_links(self):
        value = self.incomplete().replace('C.N. GRANOLLERS', 'A.E. SANTA EULÀLIA')
        for suffix in ['', '<a href="/match/145573548/results">Veure</a>']:
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, 'AESE 145573548 sin dos equipos'):
                self.parse(value.replace('</td>', suffix + '</td>', 1))

    def test_valid_aese_is_extracted(self):
        match, = self.parse(html())
        self.assertEqual((match.match_id, match.home_team, match.away_team, match.start),
                         (123, 'A.E. SANTA EULÀLIA', 'C.N. RIVAL', '2026-10-10T12:15:00+02:00'))

    def test_real_aese_placeholder_rows_block(self):
        for match_id in (145573588, 145573633):
            value = (Path(__file__).parent / f'fixtures/aese-{match_id}-incomplete.html').read_text(encoding='utf-8')
            for prefix in ('', html()):
                with self.subTest(match_id=match_id, preceding_valid=bool(prefix)):
                    with self.assertRaisesRegex(ValueError, f'AESE {match_id} sin dos equipos'):
                        self.parse(prefix + value)

    def test_team_profile_fallback_preserves_known_team_and_order(self):
        for home, away in [
            ('<a href="/ca/team/1">A.E. SANTA EULÀLIA</a>', '<span class="ellipsis">C.N. RIVAL</span>'),
            ('<span class="ellipsis">A.E. SANTA EULÀLIA</span>', '<a href="/ca/team/2">C.N. RIVAL</a>'),
            ('<a href="/ca/team/1"><span class="ellipsis">A.E. SANTA EULÀLIA</span></a>', '<a href="/ca/team/2">C.N. RIVAL</a>'),
        ]:
            value = html().replace('<span class="ellipsis" title="A.E. SANTA EULÀLIA">AESE</span>', home)
            value = value.replace('<span class="ellipsis" title="C.N. RIVAL">Rival</span>', away)
            match, = self.parse(value)
            self.assertEqual((match.home_team, match.away_team), ('A.E. SANTA EULÀLIA', 'C.N. RIVAL'))

    def test_empty_name_does_not_count_as_opponent(self):
        with self.assertRaisesRegex(ValueError, 'sin dos equipos'):
            self.parse(html().replace('<span class="ellipsis" title="C.N. RIVAL">Rival</span>', '<span class="ellipsis"> </span>'))

    def test_exact_duplicate_rows_are_collapsed(self):
        self.assertEqual(len(self.parse(html()+html())),1)
    def test_conflicting_duplicate_rows_are_blocked(self):
        with self.assertRaisesRegex(ValueError,'contradictorios'):
            self.parse(html()+html().replace('12:15','14:15').replace('10:15:00','12:15:00'))
    def test_missing_date_never_silently_removes_match(self):
        with self.assertRaises(ValueError): self.parse(html().replace('data-sort','other'))
    def test_invalid_date_never_silently_removes_match(self):
        with self.assertRaises(ValueError): self.parse(html('unknown').replace('10/10/26 12:15 GMT+2','Pendiente'))
    def test_postponed_or_cancelled_requires_review(self):
        for label in ['Ajornat','Cancelado','Cancel·lat','Aplazado']:
            with self.subTest(label=label), self.assertRaisesRegex(ValueError,'revisar'):
                self.parse(html(extra=label))
    def test_round_is_taken_from_each_table(self):
        rows = self.parse('<h2>Jornada 1</h2>' + html() + '<h2>Jornada 4</h2>' + html().replace('/123/', '/124/'))
        self.assertEqual([m.round_name for m in rows], ['Jornada 1', 'Jornada 4'])
    def test_utc_sort_is_converted_once_in_winter_and_summer(self):
        from actawp_sync import _extract_local_datetime
        for raw, expected in [('2026-11-15 12:30:00','2026-11-15T13:30:00+01:00'),
                              ('2026-10-24 11:30:00','2026-10-24T13:30:00+02:00')]:
            self.assertEqual(_extract_local_datetime(raw, '').isoformat(), expected)

    def test_stale_gmt_label_does_not_shift_winter_wall_clock(self):
        from actawp_sync import _extract_local_datetime
        for raw, display, expected in [
            ('0 2026-11-15 12:30:00 Olot', '15/11/2026 13:30 GMT+2', '2026-11-15T13:30:00+01:00'),
            ('0 2026-10-25 08:00:00 AESE', '25/10/2026 09:00 GMT+2', '2026-10-25T09:00:00+01:00'),
            ('0 2027-04-04 09:30:00 AESE', '04/04/2027 11:30 GMT+2', '2027-04-04T11:30:00+02:00'),
        ]:
            self.assertEqual(_extract_local_datetime(raw, display).isoformat(), expected)

    def test_conflicting_visible_and_sortable_time_blocks_snapshot(self):
        from actawp_sync import _extract_local_datetime
        with self.assertRaisesRegex(ValueError, 'contradictorias'):
            _extract_local_datetime('2026-11-15 11:30:00', '15/11/2026 13:30 GMT+2')
        with self.assertRaises(ValueError):
            _extract_local_datetime('unknown', '15/11/2026 13:30 GMT+2')

    def test_429_direct_does_not_try_proxies(self):
        with patch.object(fetcher,'_fetch_direct',side_effect=RuntimeError('HTTP 429')), \
             patch.object(fetcher,'_fetch_corsfix') as cors, patch.object(fetcher,'_fetch_translate') as translate:
            with self.assertRaisesRegex(RuntimeError,'429'): fetcher.fetch_html('https://example.test')
            cors.assert_not_called(); translate.assert_not_called()
    def test_429_proxy_does_not_try_translate(self):
        with patch.object(fetcher,'_fetch_direct',side_effect=RuntimeError('HTTP 500')), \
             patch.object(fetcher,'_fetch_corsfix',side_effect=RuntimeError('HTTP 429')), \
             patch.object(fetcher,'_fetch_translate') as translate:
            with self.assertRaisesRegex(RuntimeError,'429'): fetcher.fetch_html('https://example.test')
            translate.assert_not_called()
