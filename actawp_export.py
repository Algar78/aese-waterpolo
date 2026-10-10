from __future__ import annotations

import json
import time
from pathlib import Path

from bs4 import BeautifulSoup

from actawp_fetch import fetch_html
from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")


def fetch_with_retry(category, tournament_id, calendar_id):
    url = calendar_url(tournament_id, calendar_id)
    last_error = None
    for attempt in range(3):
        try:
            html = fetch_html(url, timeout=30)
            matches = parse_calendar_html(html, category, tournament_id, calendar_id)

            # Un calendario puede ser perfectamente válido y no tener todavía
            # ningún partido de AESE. Solo tratamos como error una respuesta
            # que no parezca el calendario público esperado de ActaWP.
            if not matches:
                soup = BeautifulSoup(html, 'html.parser')
                rows = soup.select('table.tabletype-public tbody tr')
                print(f'DIAGNOSTICO {category}: filas={len(rows)} enlaces_partido={len(soup.select("a[href*=\"/match/\"]"))} titulos={[_t.get_text(" ", strip=True)[:90] for _t in soup.select("h1,h2")[:3]]}')
                for row in rows[:5]:
                    print('  FILA:', row.get_text(' ', strip=True)[:260])
            if not matches and 'tabletype-public' not in html:
                raise RuntimeError(
                    f"Calendario {category} respondió pero no contiene la tabla pública esperada"
                )

            print(f"{category}: {len(matches)} partidos AESE")
            return matches
        except Exception as exc:
            last_error = exc
            print(f"Error en {category} (intento {attempt + 1}/3): {exc}")
            if attempt < 2:
                time.sleep(8 * (attempt + 1))
    raise RuntimeError(f"No se pudo consultar {category}: {last_error}") from last_error


def main():
    all_matches = []
    errors = []
    for index, (category, (tournament_id, calendar_id)) in enumerate(CALENDARS.items()):
        if index:
            time.sleep(2)
        try:
            all_matches.extend(match.to_dict() for match in fetch_with_retry(category, tournament_id, calendar_id))
        except Exception as exc:
            errors.append((category, str(exc)))
            print(f"ERROR DEFINITIVO {category}: {exc}")

    # No publicar un nuevo JSON cuando las consultas fallan o faltan categorías
    # con partidos confirmados: Google Calendar debe conservar su último snapshot.
    if errors:
        raise RuntimeError('Exportación incompleta: ' + '; '.join(name for name, _ in errors))
    required_today = ('Alevín Mixto A', 'Juvenil Masculino')
    missing_required = [name for name in required_today if not any(m['category'] == name for m in all_matches)]
    if missing_required:
        raise RuntimeError('Exportación incompleta: sin partidos para ' + ', '.join(missing_required))

    unique = {item["match_id"]: item for item in all_matches}
    output = sorted(unique.values(), key=lambda item: item["start"])
    if not output:
        raise RuntimeError("No se han encontrado partidos AESE; no se publica snapshot vacío")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"TOTAL: {len(output)} partidos AESE únicos")
    if errors:
        print("CALENDARIOS CON ERROR EN ESTA EJECUCIÓN:")
        for category, error in errors:
            print(f" - {category}: {error}")


if __name__ == "__main__":
    main()
