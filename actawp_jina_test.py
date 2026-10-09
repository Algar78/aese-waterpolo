from __future__ import annotations

import requests
from actawp_sync import parse_calendar_html

TARGET = 'https://actawp.natacio.cat/ca/tournament/1339803/calendar/3714121/all'
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(
    PROXY,
    timeout=60,
    headers={
        'X-Respond-With': 'html',
        'X-Engine': 'browser',
        'X-No-Cache': 'true',
        'User-Agent': 'AESE-Waterpolo-Calendar-Sync/1.0',
    },
)
print('Jina status:', r.status_code)
print('Content length:', len(r.text))
if r.status_code != 200:
    print(r.text[:1000])
    r.raise_for_status()

matches = parse_calendar_html(r.text, 'Absoluto Masculino', 1339803, 3714121)
print('Matches found:', len(matches))
target = next((m for m in matches if m.match_id == 145573547), None)
if target is None:
    raise SystemExit('Known match 145573547 was not found')
print(target)
if target.home_team != 'A.E. SANTA EULÀLIA' or target.away_team != 'C.N. MARTORELL':
    raise SystemExit(f'Unexpected teams: {target.home_team} vs {target.away_team}')
if not target.start.startswith('2026-09-26T16:00:'):
    raise SystemExit(f'Unexpected local start: {target.start}')
print('JINA ACTAWP TEST OK')
