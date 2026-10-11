import unittest
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
    def test_exact_duplicate_rows_are_collapsed(self):
        self.assertEqual(len(self.parse(html()+html())),1)
    def test_conflicting_duplicate_rows_are_blocked(self):
        with self.assertRaisesRegex(ValueError,'contradictorios'):
            self.parse(html()+html().replace('12:15','14:15'))
    def test_missing_date_never_silently_removes_match(self):
        with self.assertRaises(ValueError): self.parse(html().replace('data-sort','other'))
    def test_invalid_date_never_silently_removes_match(self):
        with self.assertRaises(ValueError): self.parse(html('unknown').replace('10/10/26 12:15 GMT+2','Pendiente'))
    def test_postponed_or_cancelled_requires_review(self):
        for label in ['Ajornat','Cancelado','Cancel·lat','Aplazado']:
            with self.subTest(label=label), self.assertRaisesRegex(ValueError,'revisar'):
                self.parse(html(extra=label))
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
