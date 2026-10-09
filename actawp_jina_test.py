from __future__ import annotations

import requests

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://proxy.cors.dev/' + TARGET

r = requests.get(
    PROXY,
    timeout=20,
    headers={
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    },
)
print('Proxy status:', r.status_code)
print('Content length:', len(r.text))
print('Content-Type:', r.headers.get('Content-Type'))
print(r.text[:12000])
r.raise_for_status()
if '145573547' not in r.text:
    raise SystemExit('Known match 145573547 was not found through cors.dev')
print('ACTAWP CORS PROXY TEST OK')
