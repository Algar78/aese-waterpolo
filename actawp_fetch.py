from __future__ import annotations

import hashlib
import re
from urllib.parse import urlencode, quote

import requests

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
_SESSION = requests.Session()
_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ca-ES,ca;q=0.9,en;q=0.8',
}

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
    response = _SESSION.get(url, headers=_HEADERS, timeout=timeout)
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

    proof = _SESSION.get(proof_url, headers=_HEADERS, timeout=timeout)
    if proof.status_code not in (200, 204):
        raise RuntimeError(f'ActaWP PoW rechazado: HTTP {proof.status_code}')

    final = _SESSION.get(url, headers=_HEADERS, timeout=timeout)
    final.raise_for_status()
    if 'Comprovant el teu navegador' in final.text:
        raise RuntimeError('ActaWP sigue mostrando el desafío PoW tras resolverlo')
    return final.text


def _fetch_corsfix(url: str, timeout: int) -> str:
    proxy = 'https://proxy-eu.corsfix.com/?' + url
    response = requests.get(proxy, headers=_HEADERS, timeout=min(timeout, 20))
    response.raise_for_status()
    if 'tabletype-public' not in response.text and '/match/' not in response.text:
        raise RuntimeError('Corsfix no devolvió el HTML de ActaWP esperado')
    return response.text


def _fetch_translate(url: str, timeout: int) -> str:
    proxy = 'https://translate.google.com/translate?sl=auto&tl=en&u=' + quote(url, safe='')
    response = requests.get(proxy, headers=_HEADERS, timeout=min(timeout, 20))
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
