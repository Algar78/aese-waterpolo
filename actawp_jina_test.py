from __future__ import annotations

import requests
from actawp_sync import parse_calendar_html

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(PROXY, timeout=60, headers={
    'X-Respond-With': 'html',
    'X-Engine': 'direct',
    'X-No-Cache': 'true',
    'User-Agent': 'AESE-Waterpolo-Calendar-Sync/1.0',
})
print('Jina status:', r.status_code)
print('Content length:', len(r.text))
print(r.text[:12000])
if r.status_code != 200:
    r.raise_for_status()

matches = parse_calendar_html(r.text, 'Absoluto Masculino', 1339803, 3714121)
print('Matches found:', len(matches))
