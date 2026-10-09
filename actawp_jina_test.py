from __future__ import annotations

import re
import requests

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(PROXY, timeout=60, headers={
    'X-Respond-With': 'markdown',
    'X-Engine': 'direct',
    'X-No-Cache': 'true',
    'User-Agent': 'AESE-Waterpolo-Calendar-Sync/1.0',
})
print('Jina status:', r.status_code)
print('Content length:', len(r.text))
if r.status_code != 200:
    print(r.text[:1000])
    r.raise_for_status()

print(r.text[:12000])
needle = '145573547'
pos = r.text.find(needle)
print('TARGET POSITION:', pos)
if pos >= 0:
    print(r.text[max(0, pos-3000):pos+3000])
    print('JINA MARKDOWN TARGET FOUND')
else:
    raise SystemExit('Known match 145573547 was not found in Jina markdown')
