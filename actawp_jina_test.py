from __future__ import annotations

import requests

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(
    PROXY,
    timeout=120,
    headers={
        'Accept': 'text/plain',
        'X-Respond-With': 'markdown',
        'X-Engine': 'browser',
        'X-No-Cache': 'true',
        'X-User-Agent': 'browser',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    },
)
print('Jina status:', r.status_code)
print('Content length:', len(r.text))
r.raise_for_status()
print(r.text[:16000])
needle = '145573547'
pos = r.text.find(needle)
print('TARGET POSITION:', pos)
if pos < 0:
    raise SystemExit('Known match 145573547 was not found in Jina browser output')
print('ACTAWP JINA BROWSER TEST OK')
