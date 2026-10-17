import unittest
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch
import requests
import actawp_fetch as fetch


def response(code, headers=None):
    r = requests.Response()
    r.status_code = code
    r.headers.update(headers or {})
    r.url = 'https://actawp.natacio.cat/test'
    return r


class BackoffTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        patcher = patch.object(fetch, '_COOLDOWN_PATH', Path(temp.name) / 'cooldown.json')
        patcher.start()
        self.addCleanup(patcher.stop)
    def run_sequence(self, rows):
        client = Mock()
        client.get.side_effect = rows
        return client

    @patch.object(fetch.time, 'sleep')
    def test_seconds_then_success(self, sleep):
        client = self.run_sequence([response(429, {'Retry-After': '7'}), response(200)])
        self.assertEqual(fetch._get_with_backoff(client, 'same', headers={}, timeout=1).status_code, 200)
        sleep.assert_called_once_with(7)
        self.assertEqual([c.args[0] for c in client.get.call_args_list], ['same', 'same'])

    @patch.object(fetch.time, 'sleep')
    def test_http_date_uses_server_clock(self, sleep):
        client = self.run_sequence([response(429, {'Date': 'Sat, 17 Oct 2026 10:00:00 GMT', 'Retry-After': 'Sat, 17 Oct 2026 10:00:12 GMT'}), response(200)])
        fetch._get_with_backoff(client, 'same', headers={}, timeout=1)
        sleep.assert_called_once_with(12)

    @patch.object(fetch.time, 'sleep')
    def test_long_server_wait_aborts_without_shortening(self, sleep):
        client = self.run_sequence([response(429, {'Retry-After': '600'})])
        with self.assertRaises(requests.HTTPError):
            fetch._get_with_backoff(client, 'same', headers={}, timeout=1)
        sleep.assert_not_called()
        self.assertEqual(client.get.call_count, 1)

    @patch.object(fetch.time, 'sleep')
    def test_retry_exhaustion_and_invalid_header(self, sleep):
        client = self.run_sequence([response(429, {'Retry-After': 'invalid'})] * 4)
        with self.assertRaises(requests.HTTPError):
            fetch._get_with_backoff(client, 'same', headers={}, timeout=1)
        self.assertEqual(client.get.call_count, 4)
        self.assertEqual(sleep.call_count, 3)

    def test_no_proxy_after_429(self):
        err = requests.HTTPError(response=response(429))
        with patch.object(fetch, '_fetch_direct', side_effect=err), patch.object(fetch, '_fetch_corsfix') as proxy:
            with self.assertRaises(requests.HTTPError):
                fetch.fetch_html('https://actawp.natacio.cat/test')
            proxy.assert_not_called()

    @patch.object(fetch.time, 'sleep')
    def test_long_wait_survives_next_export(self, sleep):
        client = self.run_sequence([response(429, {'Retry-After': '36000'})])
        for _ in range(2):
            with self.assertRaises(requests.HTTPError):
                fetch._get_with_backoff(client, 'same', headers={}, timeout=1)
        self.assertEqual(client.get.call_count, 1)
