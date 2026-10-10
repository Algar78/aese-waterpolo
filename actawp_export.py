"""Exportador AESE: descubre el grupo correcto de cada equipo y no publica datos parciales."""

from __future__ import annotations

import json
import re
import time
import hashlib
from pathlib import Path
from datetime import datetime, timezone

from actawp_fetch import fetch_html
from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")
DISCOVERY = Path("data/actawp_calendar_overrides.json")
STATUS = Path("data/actawp_export_status.json")
ATTEMPT_STATUS = Path("data/actawp_last_attempt.json")
CACHE = {}


def fetch_group(category, tournament_id, calendar_id):
    key = (tournament_id, calendar_id)
    if key in CACHE:
        html = CACHE[key]
    else:
        url = calendar_url(tournament_id, calendar_id)
        last_error = None
        for attempt in range(2):
            try:
                html = fetch_html(url, timeout=18)
                if "tabletype-public" not in html:
                    raise RuntimeError("HTML sin tabla pública de calendario")
                CACHE[key] = html
                break
            except Exception as exc:
                last_error = exc
                print(f"ERROR HTTP {category} grupo {calendar_id} ({attempt + 1}/2): {exc}", flush=True)
                if "429" in str(exc) or "Too Many Requests" in str(exc):
                    raise RuntimeError("HTTP 429: ActaWP limita temporalmente las consultas") from exc
                if attempt == 0:
                    time.sleep(5)
        else:
            raise RuntimeError(f"No se pudo cargar grupo {calendar_id}: {last_error}")

    matches = parse_calendar_html(html, category, tournament_id, calendar_id)
    print(f"{category}, grupo {calendar_id}: {len(matches)} partidos AESE", flush=True)
    return matches, html


def discover_group_ids(html, tournament_id):
    """ActaWP incluye enlaces a todos los grupos en la navegación del calendario."""
    regex = rf"(?:https?://actawp\.natacio\.cat)?/(?:ca|es|en|fr|de|it|pt|eu)/tournament/{tournament_id}/calendar/(\d+)"
    ids = {int(value) for value in re.findall(regex, html)}
    return sorted(ids)


def fetch_category(category, tournament_id, default_id, overrides):
    first_id = int(overrides.get(category, default_id))
    matches, html = fetch_group(category, tournament_id, first_id)
    if matches:
        return matches, first_id

    group_ids = discover_group_ids(html, tournament_id)
    print(f"GRUPOS disponibles en {category}: {group_ids}", flush=True)
    if not group_ids:
        raise RuntimeError(f"Sin enlaces de grupos para {category}")

    for group_id in group_ids:
        if group_id == first_id:
            continue
        time.sleep(2)
        candidates, _ = fetch_group(category, tournament_id, group_id)
        if candidates:
            print(f"GRUPO AESE ENCONTRADO {category}: {group_id}", flush=True)
            return candidates, group_id
    return [], None


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline='\n')
    temporary.replace(path)


def load_overrides():
    if not DISCOVERY.exists():
        return {}
    value = json.loads(DISCOVERY.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def main():
    CACHE.clear()
    overrides = load_overrides()
    collected = []
    counts = {}
    errors = []
    throttled = False

    for category, (tournament_id, default_id) in CALENDARS.items():
        if throttled:
            errors.append(f"{category}: pendiente por límite HTTP 429")
            continue
        if counts:
            time.sleep(2)
        try:
            matches, discovered_id = fetch_category(category, tournament_id, default_id, overrides)
            counts[category] = len(matches)
            if not matches:
                errors.append(f"{category}: AESE no aparece en los grupos publicados")
            else:
                overrides[category] = discovered_id
                collected.extend(match.to_dict() for match in matches)
                save_json(DISCOVERY, overrides)
        except Exception as exc:
            errors.append(f"{category}: {exc}")
            if "429" in str(exc):
                throttled = True
            print(f"ERROR {category}: {exc}", flush=True)

    unique = {(item["tournament_id"], item["match_id"]): item for item in collected}
    if len(unique) != len(collected):
        errors.append("Identidad de partido duplicada; snapshot bloqueado")
    output = sorted(unique.values(), key=lambda item: item["start"])
    if not output and not errors:
        errors.append("Snapshot vacío bloqueado")
    complete = not errors and len(counts) == len(CALENDARS)
    if OUT.exists() and complete:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
        missing = {(m['tournament_id'], m['match_id']) for m in previous} - set(unique)
        if missing:
            errors.append(f"Partidos desaparecidos sin cancelación explícita: {sorted(missing)}; snapshot bloqueado")
            complete = False
    status = {
        "attempted_at": datetime.now(timezone.utc).isoformat(),
        "complete": complete,
        "categories_expected": list(CALENDARS),
        "counts": counts,
        "total_matches_found": len(output),
        "errors": errors,
    }
    # Un fallo describe el intento, nunca invalida el último snapshot publicado.
    save_json(ATTEMPT_STATUS, status)
    print(f"RESUMEN: {len(output)} partidos, {len(counts)}/{len(CALENDARS)} categorías consultadas", flush=True)
    if errors:
        print("NO PUBLICADO: exportación incompleta (se conserva el snapshot anterior)", flush=True)
        for error in errors:
            print(" - " + error, flush=True)
        raise RuntimeError("Exportación incompleta; ver data/actawp_last_attempt.json")

    if not output:
        raise RuntimeError("Snapshot vacío bloqueado")
    save_json(OUT, output)
    status['snapshot_sha256'] = hashlib.sha256(OUT.read_bytes()).hexdigest()
    save_json(ATTEMPT_STATUS, status)
    save_json(STATUS, status)
    print(f"PUBLICADO: {len(output)} partidos AESE únicos de {len(CALENDARS)} categorías", flush=True)


if __name__ == "__main__":
    main()
