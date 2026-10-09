from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")


def fetch_with_retry(category, tournament_id, calendar_id):
    url = calendar_url(tournament_id, calendar_id)
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; AESE-Waterpolo-Calendar-Sync/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ca-ES,ca;q=0.9,es;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
    }
    last = None
    for attempt in range(5):
        try:
            response = requests.get(url, timeout=30, headers=headers)
            if response.status_code == 429:
                wait = 15 * (attempt + 1)
                print(f"429 en {category}; esperando {wait}s")
                time.sleep(wait)
                continue
            response.raise_for_status()
            matches = parse_calendar_html(response.text, category, tournament_id, calendar_id)
            if not matches:
                raise RuntimeError(f"Calendario {category} respondió pero no contiene partidos extraíbles")
            return matches
        except Exception as exc:
            last = exc
            if attempt < 4:
                time.sleep(5 * (attempt + 1))
            else:
                raise
    raise last or RuntimeError("No se pudo consultar ActaWP")


def main():
    all_matches = []
    for index, (category, (tournament_id, calendar_id)) in enumerate(CALENDARS.items()):
        if index:
            time.sleep(8)
        matches = fetch_with_retry(category, tournament_id, calendar_id)
        print(f"{category}: {len(matches)} partidos")
        all_matches.extend(match.to_dict() for match in matches)

    unique = {item["match_id"]: item for item in all_matches}
    output = sorted(unique.values(), key=lambda item: item["start"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"TOTAL: {len(output)} partidos únicos")


if __name__ == "__main__":
    main()
