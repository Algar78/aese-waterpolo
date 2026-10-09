from __future__ import annotations

import requests

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(
    PROXY,
    timeout=90,
    headers={
        'Accept': 'text/plain',
        'X-Respond-With': 'markdown',
        'X-No-Cache': 'true',
        'User-Agent': 'AESE-Waterpolo-Calendar-Sync/1.0',
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
    raise SystemExit('Known match 145573547 was not found in Jina markdown')
print('ACTAWP JINA MARKDOWN FOUND')
