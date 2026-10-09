from __future__ import annotations

import hashlib
import re
from urllib.parse import urlencode

import requests

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'


def solve_pow(seed: str, bits: int) -> int:
    nonce = 0
    prefix = seed.encode()
    while True:
        digest = hashlib.sha256(prefix + str(nonce).encode()).digest()
        value = int.from_bytes(digest[:8], 'big')
        if (value >> (64 - bits)) == 0:
            return nonce
        nonce += 1


def fetch_actawp(url: str) -> requests.Response:
    session = requests.Session()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ca-ES,ca;q=0.9,en;q=0.8',
    }
    r = session.get(url, headers=headers, timeout=30)
    print('Initial status:', r.status_code)
    if r.status_code == 200 and 'Comprovant el teu navegador' not in r.text:
        return r

    html = r.text
    reto = re.search(r"RETO\s*=\s*'([^']+)'", html)
    firma = re.search(r"FIRMA\s*=\s*'([^']+)'", html)
    semilla = re.search(r"SEMILLA\s*=\s*'([^']+)'", html)
    bits = re.search(r"BITS\s*=\s*(\d+)", html)
    if not (reto and firma and semilla and bits):
        raise RuntimeError('No se pudo interpretar el desafío PoW de ActaWP')

    seed = semilla.group(1)
    difficulty = int(bits.group(1))
    nonce = solve_pow(seed, difficulty)
    print(f'PoW solved: bits={difficulty} nonce={nonce}')

    challenge_url = url + ('&' if '?' in url else '?') + urlencode({
        '_pow_r': reto.group(1),
        '_pow_f': firma.group(1),
        '_pow_n': str(nonce),
    })
    proof = session.get(challenge_url, headers=headers, timeout=30)
    print('Proof status:', proof.status_code)
    if proof.status_code not in (200, 204):
        raise RuntimeError(f'PoW proof rejected: HTTP {proof.status_code}')

    final = session.get(url, headers=headers, timeout=30)
    print('Final status:', final.status_code, 'length:', len(final.text))
    final.raise_for_status()
    if 'Comprovant el teu navegador' in final.text:
        raise RuntimeError('ActaWP volvió a presentar el desafío después del PoW')
    return final


r = fetch_actawp(TARGET)
print(r.text[:12000])
if '145573547' not in r.text:
    raise SystemExit('Known match 145573547 was not found after PoW')
print('ACTAWP POW TEST OK')
