import json
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
        log = patch.object(fetch, '_LOG_PATH', Path(temp.name) / 'requests.json')
        log.start()
        self.addCleanup(log.stop)
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

    def test_429_stops_at_the_origin_and_never_reaches_another_host(self):
        client = self.run_sequence([response(429, {'Retry-After': '600'})])
        with patch.object(fetch, '_SESSION', client):
            with self.assertRaises(requests.HTTPError):
                fetch.fetch_html('https://actawp.natacio.cat/test')
        self.assertEqual([c.args[0] for c in client.get.call_args_list], ['https://actawp.natacio.cat/test'])

    @patch.object(fetch.time, 'sleep')
    def test_long_wait_survives_next_export(self, sleep):
        client = self.run_sequence([response(429, {'Retry-After': '36000'})])
        for _ in range(2):
            with self.assertRaises(requests.HTTPError):
                fetch._get_with_backoff(client, 'same', headers={}, timeout=1)
        self.assertEqual(client.get.call_count, 1)


class CompliantClientTests(unittest.TestCase):
    """The client identifies itself and does not evade controls (see docs/audit-2026-10-18.md)."""
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.log_path = Path(temp.name) / 'requests.json'
        for name, path in (('_COOLDOWN_PATH', Path(temp.name) / 'cooldown.json'), ('_LOG_PATH', self.log_path)):
            patcher = patch.object(fetch, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)

    def page(self, status, text, headers=None):
        r = response(status, headers)
        r._content = text.encode()
        return r

    def test_no_evasion_machinery_is_left_in_the_module(self):
        for name in ('_solve_pow', '_fetch_corsfix', '_fetch_translate', '_fetch_direct'):
            self.assertFalse(hasattr(fetch, name), name)
        source = Path(fetch.__file__).read_text(encoding='utf-8')
        # Only the module docstring may mention these, to explain what is deliberately absent.
        code = source.split('"""', 2)[2]
        for needle in ('corsfix', 'translate.google', 'jina', '_pow_', 'sha256', 'Mozilla'):
            self.assertNotIn(needle.lower(), code.lower(), needle)

    def test_user_agent_identifies_the_project_and_does_not_pose_as_a_browser(self):
        self.assertIn('AESE-Waterpolo-Calendar', fetch.UA)
        self.assertNotIn('Mozilla', fetch.UA)
        self.assertNotIn('@', fetch.UA)  # no personal address is sent to third parties

    def test_challenge_page_is_reported_and_never_solved(self):
        html = "<html>Comprovant el teu navegador <script>RETO='a';FIRMA='b';SEMILLA='c';BITS=12</script></html>"
        client = Mock()
        client.get.return_value = self.page(200, html)
        with patch.object(fetch, '_SESSION', client):
            with self.assertRaises(fetch.SourceChallengeError):
                fetch.fetch_html('https://actawp.natacio.cat/ca/tournament/1/calendar/2/all')
        self.assertEqual(client.get.call_count, 1)
        self.assertNotIn('_pow_', client.get.call_args.args[0])

    def test_server_error_is_not_retried_through_a_proxy(self):
        client = Mock()
        client.get.return_value = self.page(500, 'boom')
        with patch.object(fetch, '_SESSION', client):
            with self.assertRaises(requests.HTTPError):
                fetch.fetch_html('https://actawp.natacio.cat/x')
        self.assertEqual(client.get.call_count, 1)

    def test_every_response_is_recorded_with_its_real_status(self):
        client = Mock()
        client.get.side_effect = [self.page(429, 'Too Many Requests', {'Retry-After': '600', 'Server': 'nginx'})]
        with patch.object(fetch, '_SESSION', client):
            with self.assertRaises(requests.HTTPError):
                fetch.fetch_html('https://actawp.natacio.cat/ca/tournament/1/calendar/2/all?x=secret')
        entry = json.loads(self.log_path.read_text())[-1]
        self.assertEqual((entry['status'], entry['retry_after'], entry['server']), (429, '600', 'nginx'))
        self.assertEqual(entry['host'], 'actawp.natacio.cat')
        self.assertNotIn('secret', json.dumps(entry))  # query strings are not stored
        self.assertEqual(entry['body_hint'], 'Too Many Requests')

    def test_connection_errors_are_recorded_too(self):
        client = Mock()
        client.get.side_effect = requests.ConnectionError('reset by peer')
        with patch.object(fetch, '_SESSION', client):
            with self.assertRaises(requests.ConnectionError):
                fetch.fetch_html('https://actawp.natacio.cat/x')
        self.assertIn('ConnectionError', json.loads(self.log_path.read_text())[-1]['error'])

    def test_request_log_is_bounded(self):
        client = Mock()
        client.get.return_value = self.page(200, '<table class="tabletype-public"></table>')
        with patch.object(fetch, '_SESSION', client):
            for _ in range(fetch._LOG_LIMIT + 15):
                fetch.fetch_html('https://actawp.natacio.cat/x')
        self.assertEqual(len(json.loads(self.log_path.read_text())), fetch._LOG_LIMIT)
