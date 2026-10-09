from __future__ import annotations

import hashlib
import re
from urllib.parse import urlencode

import requests

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'


def _solve_pow(seed: str, bits: int) -> int:
    nonce = 0
    prefix = seed.encode()
    mask_shift = 64 - bits
    while True:
        digest = hashlib.sha256(prefix + str(nonce).encode()).digest()
        if (int.from_bytes(digest[:8], 'big') >> mask_shift) == 0:
            return nonce
        nonce += 1


def fetch_html(url: str, timeout: int = 30) -> str:
    session = requests.Session()
    headers = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ca-ES,ca;q=0.9,en;q=0.8',
    }

    response = session.get(url, headers=headers, timeout=timeout)
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

    proof = session.get(proof_url, headers=headers, timeout=timeout)
    if proof.status_code not in (200, 204):
        raise RuntimeError(f'ActaWP PoW rechazado: HTTP {proof.status_code}')

    final = session.get(url, headers=headers, timeout=timeout)
    final.raise_for_status()
    if 'Comprovant el teu navegador' in final.text:
        raise RuntimeError('ActaWP sigue mostrando el desafío PoW tras resolverlo')
    return final.text
