from __future__ import annotations

import json
import time
from pathlib import Path

from actawp_fetch import fetch_html
from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")


def fetch_with_retry(category, tournament_id, calendar_id):
    url = calendar_url(tournament_id, calendar_id)
    for attempt in range(2):
        try:
            html = fetch_html(url, timeout=30)
            matches = parse_calendar_html(html, category, tournament_id, calendar_id)
            if not matches:
                raise RuntimeError(f"Calendario {category} respondió pero no contiene partidos extraíbles")
            return matches
        except Exception as exc:
            print(f"Error en {category}: {exc}")
            if attempt == 0:
                time.sleep(5)
            else:
                raise
    raise RuntimeError("No se pudo consultar ActaWP")


def main():
    all_matches = []
    for index, (category, (tournament_id, calendar_id)) in enumerate(CALENDARS.items()):
        if index:
            time.sleep(2)
        matches = fetch_with_retry(category, tournament_id, calendar_id)
        print(f"{category}: {len(matches)} partidos")
        all_matches.extend(match.to_dict() for match in matches)

    unique = {item["match_id"]: item for item in all_matches}
    output = sorted(unique.values(), key=lambda item: item["start"])
    if not output:
        raise RuntimeError("No se han extraído partidos; no se publica snapshot vacío")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"TOTAL: {len(output)} partidos únicos")


if __name__ == "__main__":
    main()
