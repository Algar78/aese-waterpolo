from __future__ import annotations

from actawp_sync import fetch_calendar

matches = fetch_calendar('Absoluto Masculino', 1339803, 3714121, timeout=30)
print('Matches parsed:', len(matches))
needle = next((m for m in matches if m.match_id == 145573547), None)
if needle is None:
    raise SystemExit('Known match 145573547 was not parsed')
print(needle)
if needle.home_team != 'A.E. SANTA EULÀLIA' or needle.away_team != 'C.N. MARTORELL':
    raise SystemExit(f'Unexpected teams: {needle.home_team} vs {needle.away_team}')
if not needle.start.startswith('2026-09-26T16:00:'):
    raise SystemExit(f'Unexpected local start: {needle.start}')
print('ACTAWP PARSER TEST OK')
