from __future__ import annotations

import requests

from actawp_sync import calendar_url, parse_calendar_html

TARGET = calendar_url(1339803, 3714121)
PROXY = 'https://r.jina.ai/' + TARGET

r = requests.get(
    PROXY,
    timeout=90,
    headers={
        'Accept': 'text/html',
        'X-Respond-With': 'html',
        'X-No-Cache': 'true',
        'User-Agent': 'AESE-Waterpolo-Calendar-Sync/1.0',
    },
)
print('Jina status:', r.status_code)
print('Content length:', len(r.text))
r.raise_for_status()

matches = parse_calendar_html(r.text, 'Absoluto Masculino', 1339803, 3714121)
print('Matches found:', len(matches))
needle = next((m for m in matches if m.match_id == 145573547), None)
if needle is None:
    raise SystemExit('Known match 145573547 was not found')

print(needle)
if needle.home_team != 'A.E. SANTA EULÀLIA' or needle.away_team != 'C.N. MARTORELL':
    raise SystemExit(f'Unexpected teams: {needle.home_team} vs {needle.away_team}')
if not needle.start.startswith('2026-09-26T16:00:'):
    raise SystemExit(f'Unexpected local start: {needle.start}')
print('ACTAWP JINA HTML TEST OK')
