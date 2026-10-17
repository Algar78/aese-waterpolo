from __future__ import annotations

import hashlib
import re
import time
import random
import json
import math
from pathlib import Path
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlencode, quote, urlsplit

import requests

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
_SESSION = requests.Session()
_COOLDOWN_PATH = Path(__file__).parent / 'data' / 'actawp_http_cooldowns.json'
_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ca-ES,ca;q=0.9,en;q=0.8',
}

def _get_with_backoff(client, url, *, headers, timeout):
    """Respect Retry-After; never route a rate-limited request around the server."""
    origin = urlsplit(url).netloc or url
    cooldowns = json.loads(_COOLDOWN_PATH.read_text()) if _COOLDOWN_PATH.exists() else {}
    until = float(cooldowns.get(origin, 0))
    if until > time.time():
        r = requests.Response()
        r.status_code = 429
        r.url = url
        r.headers['Retry-After'] = str(math.ceil(until - time.time()))
        raise requests.HTTPError('HTTP 429 persisted server cooldown', response=r)
    deadline = time.monotonic() + 120
    for attempt in range(4):
        response = client.get(url, headers=headers, timeout=timeout)
        if response.status_code != 429:
            return response
        retry = response.headers.get('Retry-After', '')
        try:
            delay = float(retry)
            if delay < 0 or not math.isfinite(delay):
                raise ValueError('invalid delay')
        except (ValueError, TypeError):
            try:
                target = parsedate_to_datetime(retry)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                server_date = response.headers.get('Date')
                now = parsedate_to_datetime(server_date) if server_date else datetime.now(timezone.utc)
                delay = max(0, (target - now).total_seconds())
            except (ValueError, TypeError, OverflowError):
                delay = 0
        delay = max(delay, 2 ** attempt + random.uniform(0, 1))
        cooldowns[origin] = time.time() + delay
        _COOLDOWN_PATH.parent.mkdir(parents=True, exist_ok=True)
        _COOLDOWN_PATH.write_text(json.dumps(cooldowns, sort_keys=True) + '\n')
        if attempt == 3:
            response.raise_for_status()
        if time.monotonic() + delay + timeout > deadline:
            # Abort this export; the last good snapshot and the next scheduled
            # run remain responsible for recovery, without truncating the wait.
            response.raise_for_status()
        print(f'HTTP 429: waiting {delay:.1f}s before same-endpoint retry')
        time.sleep(delay)
    raise AssertionError('unreachable')

def _rate_limited(exc):
    return getattr(getattr(exc, 'response', None), 'status_code', None) == 429 or '429' in str(exc)


def _solve_pow(seed: str, bits: int) -> int:
    nonce = 0
    prefix = seed.encode()
    shift = 64 - bits
    while True:
        digest = hashlib.sha256(prefix + str(nonce).encode()).digest()
        if (int.from_bytes(digest[:8], 'big') >> shift) == 0:
            return nonce
        nonce += 1


def _fetch_direct(url: str, timeout: int) -> str:
    response = _get_with_backoff(_SESSION, url, headers=_HEADERS, timeout=timeout)
    if response.status_code == 429:
        response.raise_for_status()
    if response.status_code == 200 and 'Comprovant el teu navegador' not in response.text:
        return response.text

    html = response.text
    reto = re.search(r"RETO\s*=\s*'([^']+)'", html)
    firma = re.search(r"FIRMA\s*=\s*'([^']+)'", html)
    semilla = re.search(r"SEMILLA\s*=\s*'([^']+)'", html)
    bits_match = re.search(r"BITS\s*=\s*(\d+)", html)
    if not (reto and firma and semilla and bits_match):
        raise RuntimeError(f'ActaWP HTTP {response.status_code}: desafío PoW no reconocido')

    bits = int(bits_match.group(1))
    nonce = _solve_pow(semilla.group(1), bits)
    proof_url = url + ('&' if '?' in url else '?') + urlencode({
        '_pow_r': reto.group(1),
        '_pow_f': firma.group(1),
        '_pow_n': str(nonce),
    })

    proof = _get_with_backoff(_SESSION, proof_url, headers=_HEADERS, timeout=timeout)
    if proof.status_code not in (200, 204):
        raise RuntimeError(f'ActaWP PoW rechazado: HTTP {proof.status_code}')

    final = _get_with_backoff(_SESSION, url, headers=_HEADERS, timeout=timeout)
    final.raise_for_status()
    if 'Comprovant el teu navegador' in final.text:
        raise RuntimeError('ActaWP sigue mostrando el desafío PoW tras resolverlo')
    return final.text


def _fetch_corsfix(url: str, timeout: int) -> str:
    proxy = 'https://proxy-eu.corsfix.com/?' + url
    response = _get_with_backoff(requests, proxy, headers=_HEADERS, timeout=min(timeout, 20))
    response.raise_for_status()
    if 'tabletype-public' not in response.text and '/match/' not in response.text:
        raise RuntimeError('Corsfix no devolvió el HTML de ActaWP esperado')
    return response.text


def _fetch_translate(url: str, timeout: int) -> str:
    proxy = 'https://translate.google.com/translate?sl=auto&tl=en&u=' + quote(url, safe='')
    response = _get_with_backoff(requests, proxy, headers=_HEADERS, timeout=min(timeout, 20))
    response.raise_for_status()
    if 'tabletype-public' not in response.text and '/match/' not in response.text:
        raise RuntimeError('Google Translate no devolvió el HTML de ActaWP esperado')
    return response.text


def fetch_html(url: str, timeout: int = 30) -> str:
    try:
        return _fetch_direct(url, timeout)
    except (requests.RequestException, RuntimeError) as direct_exc:
        if _rate_limited(direct_exc):
            raise
        print(f'ActaWP directo falló ({direct_exc}); probando Corsfix EU')
        try:
            return _fetch_corsfix(url, timeout)
        except (requests.RequestException, RuntimeError) as proxy_exc:
            if _rate_limited(proxy_exc):
                raise
            print(f'Corsfix EU falló ({proxy_exc}); probando Google Translate')
            return _fetch_translate(url, timeout)
