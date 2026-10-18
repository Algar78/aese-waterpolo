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

def team_row(match_id, teams, date='2026-10-10 10:15:00', title_only=False):
    cells = ''.join('<td class="colstyle-equipo"><span class="ellipsis" title="%s">%s</span></td>' % (t, '' if title_only else t) for t in teams)
    return ('<tr>%s<td class="colstyle-fecha"><span data-sort="%s">10/10/26 12:15 GMT+2</span>'
            '<span class="ellipsis" title="228 - Santa Eulàlia, AE">Piscina</span></td>'
            '<td><a href="/ca/tournament/1/match/%d/results">Acta</a></td></tr>') % (cells, date, match_id)


def page(*rows):
    return '<h2>Jornada 1</h2><table class="tabletype-public"><tbody>%s</tbody></table>' % ''.join(rows)


AESE = 'A.E. SANTA EULÀLIA'


class RowIsolationTests(unittest.TestCase):
    """Another club's unreadable row must not block AESE; AESE's own never may."""
    def parse(self, html, diagnostics=None):
        return parse_calendar_html(html, 'Absoluto Masculino', 1, 2, diagnostics=diagnostics)

    def test_other_clubs_row_with_one_team_does_not_block_aese_matches(self):
        diagnostics = []
        rows = self.parse(page(team_row(147, [AESE, 'C.N. MARTORELL']), team_row(148, ['C.N. BADIA'])), diagnostics)
        self.assertEqual([m.match_id for m in rows], [147])
        self.assertEqual([d['match_id'] for d in diagnostics], [148])
        self.assertEqual(diagnostics[0]['teams_found'], ['C.N. BADIA'])
        self.assertFalse(diagnostics[0]['aese_mentioned'])
        self.assertIn('C.N. BADIA', diagnostics[0]['row_html'])

    def test_other_clubs_row_without_any_team_cells_is_reported_not_fatal(self):
        diagnostics = []
        empty = ('<tr><td class="colstyle-fecha"><span data-sort="2026-10-10 10:15:00">x</span></td>'
                 '<td><a href="/ca/tournament/1/match/149/results">Acta</a></td></tr>')
        rows = self.parse(page(team_row(147, [AESE, 'C.N. MARTORELL']), empty), diagnostics)
        self.assertEqual([m.match_id for m in rows], [147])
        self.assertEqual([d['match_id'] for d in diagnostics], [149])

    def test_other_clubs_match_hosted_at_the_aese_pool_is_not_mistaken_for_aese(self):
        # team_row() puts every match at "228 - Santa Eulàlia, AE", AESE's own pool.
        diagnostics = []
        rows = self.parse(page(team_row(148, ['C.N. BADIA'])), diagnostics)
        self.assertEqual(rows, [])
        self.assertEqual([d['match_id'] for d in diagnostics], [148])

    def test_aese_row_with_only_one_readable_team_still_blocks(self):
        with self.assertRaisesRegex(ValueError, 'AESE \\d+ sin dos equipos'):
            self.parse(page(team_row(150, [AESE])))

    def test_aese_visible_only_in_an_attribute_still_blocks(self):
        row = ('<tr><td class="colstyle-equipo"><img alt="%s"></td>'
               '<td><a href="/ca/tournament/1/match/151/results">Acta</a></td></tr>') % AESE
        with self.assertRaisesRegex(ValueError, 'AESE \\d+ sin dos equipos'):
            self.parse(page(row))

    def test_aese_against_blank_rival_is_not_published_with_empty_team(self):
        with self.assertRaisesRegex(ValueError, 'AESE \\d+ sin dos equipos'):
            self.parse(page(team_row(152, [AESE, ''])))

    def test_diagnostics_are_bounded(self):
        import actawp_sync
        rows = [team_row(1000 + i, ['C.N. SOLO %d' % i]) for i in range(actawp_sync.MAX_DIAGNOSTIC_ROWS + 10)]
        diagnostics = []
        self.parse(page(team_row(147, [AESE, 'C.N. MARTORELL']), *rows), diagnostics)
        self.assertEqual(len(diagnostics), actawp_sync.MAX_DIAGNOSTIC_ROWS)
        self.assertTrue(all(len(d['row_html']) <= 1000 and len(d['row_text']) <= 300 for d in diagnostics))

    def test_without_a_diagnostics_list_behaviour_is_unchanged_for_callers(self):
        rows = self.parse(page(team_row(147, [AESE, 'C.N. MARTORELL']), team_row(148, ['C.N. BADIA'])))
        self.assertEqual([m.match_id for m in rows], [147])


UNDATED = '5 9999-99-99 99:99:99 A.E. SANTA EULÀLIA'


def undated_row(match_id, teams, text=' '):
    cells = ''.join('<td class="colstyle-equipo"><span class="ellipsis" title="%s">%s</span></td>' % (t, t) for t in teams)
    return ('<tr>%s<td class="colstyle-fecha"><span data-sort="%s">%s</span></td>'
            '<td><a href="/ca/tournament/1/match/%d/results">Acta</a></td></tr>') % (cells, UNDATED, text, match_id)


class PendingMatchTests(unittest.TestCase):
    """ActaWP lists some AESE matches without rival and/or date. They cannot be
    calendar events, but they must neither block every other match nor vanish."""
    def parse(self, value, category='Absoluto Masculino', pending=None):
        return parse_calendar_html(value, category, 1339803, 2, pending=pending)

    def real(self, match_id):
        return (Path(__file__).parent / f'fixtures/aese-{match_id}-incomplete.html').read_text(encoding='utf-8')

    def test_real_undated_aese_rows_become_pending_and_leave_valid_matches_alone(self):
        for match_id in (145573588, 145573633):
            with self.subTest(match_id=match_id):
                pending = []
                matches = self.parse(html() + self.real(match_id), pending=pending)
                self.assertEqual([m.match_id for m in matches], [123])
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]['match_id'], match_id)
                self.assertEqual(pending[0]['reason'], 'sin_rival_ni_fecha')
                self.assertEqual(pending[0]['teams'], [AESE])
                self.assertEqual(pending[0]['category'], 'Absoluto Masculino')
                self.assertTrue(pending[0]['url'].endswith(f'/match/{match_id}/results'))

    def test_without_a_pending_list_the_same_rows_still_block(self):
        for match_id in (145573588, 145573633):
            with self.subTest(match_id=match_id), self.assertRaisesRegex(ValueError, f'AESE {match_id} sin dos equipos'):
                self.parse(html() + self.real(match_id))

    def test_two_teams_but_no_date_is_pending_with_its_own_reason(self):
        pending = []
        self.parse(page(undated_row(160, [AESE, 'C.N. X'])), pending=pending)
        self.assertEqual([(p['match_id'], p['reason']) for p in pending], [(160, 'sin_fecha')])
        with self.assertRaisesRegex(ValueError, 'fecha inválida'):
            self.parse(page(undated_row(160, [AESE, 'C.N. X'])))

    def test_a_date_marker_next_to_a_visible_date_is_a_contradiction_and_blocks(self):
        with self.assertRaises(ValueError):
            self.parse(page(undated_row(161, [AESE, 'C.N. X'], text='10/10/26 12:15 GMT+2')), pending=[])

    def test_one_team_with_a_real_date_is_damaged_not_pending(self):
        with self.assertRaisesRegex(ValueError, 'AESE 162 sin dos equipos'):
            self.parse(page(team_row(162, [AESE])), pending=[])

    def test_postponed_text_still_blocks_even_without_a_date(self):
        with self.assertRaisesRegex(ValueError, 'aplazado/cancelado'):
            self.parse(page(undated_row(163, [AESE, 'C.N. X'], text='Ajornat')), pending=[])

    def test_the_other_aese_team_of_a_split_category_is_not_reported_here(self):
        row = undated_row(164, ['A.E. SANTA EULÀLIA B'])
        pending = []
        self.parse(page(row), category='Alevín Mixto A', pending=pending)
        self.assertEqual(pending, [])
        self.parse(page(row), category='Alevín Mixto B', pending=pending)
        self.assertEqual([p['match_id'] for p in pending], [164])

    def test_more_than_two_teams_in_an_aese_row_blocks(self):
        with self.assertRaisesRegex(ValueError, 'AESE 165 sin dos equipos'):
            self.parse(page(team_row(165, [AESE, 'C.N. X', 'C.N. Y'])), pending=[])


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
