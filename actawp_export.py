from __future__ import annotations

import json
import time
from pathlib import Path

import requests

from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")
JINA_BASE = "https://r.jina.ai/"


def fetch_with_retry(category, tournament_id, calendar_id):
    target_url = calendar_url(tournament_id, calendar_id)
    proxy_url = JINA_BASE + target_url
    headers = {
        "Accept": "text/html",
        "X-Respond-With": "html",
        "X-No-Cache": "true",
        "User-Agent": "AESE-Waterpolo-Calendar-Sync/1.0",
    }
    last = None
    for attempt in range(3):
        try:
            response = requests.get(proxy_url, timeout=90, headers=headers)
            if response.status_code in (429, 503):
                retry_after = response.headers.get("Retry-After")
                wait = int(retry_after) if retry_after and retry_after.isdigit() else 20 * (attempt + 1)
                print(f"{response.status_code} en Jina para {category}; esperando {wait}s")
                time.sleep(wait)
                continue
            response.raise_for_status()
            matches = parse_calendar_html(response.text, category, tournament_id, calendar_id)
            if not matches:
                raise RuntimeError(f"Calendario {category} respondió pero no contiene partidos extraíbles")
            return matches
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(10 * (attempt + 1))
            else:
                raise
    raise last or RuntimeError("No se pudo consultar ActaWP mediante Jina")


def main():
    all_matches = []
    for index, (category, (tournament_id, calendar_id)) in enumerate(CALENDARS.items()):
        if index:
            # Stay comfortably below Jina's unauthenticated request-rate limit.
            time.sleep(5)
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
