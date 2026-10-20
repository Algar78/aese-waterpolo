"""Exportador AESE: descubre el grupo correcto de cada equipo y no publica datos parciales."""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import time
import hashlib
import unicodedata
from pathlib import Path
from datetime import datetime, timezone

from actawp_fetch import SourceChallengeError, fetch_html
from actawp_sync import CALENDARS, calendar_url, parse_calendar_html

OUT = Path("data/actawp_matches.json")
DISCOVERY = Path("data/actawp_calendar_overrides.json")
STATUS = Path("data/actawp_export_status.json")
ATTEMPT_STATUS = Path("data/actawp_last_attempt.json")
IGNORED_ROWS = Path("data/actawp_ignored_rows.json")
POLICY = Path("data/freshness_policy.json")
CACHE = {}
DIAGNOSTICS = []  # rows ignored because AESE is not involved; reported, never silent
PENDING_BY_GROUP = {}  # (tournament, group) -> AESE matches ActaWP itself lists as undated
MANUAL_DIR = None  # set by --from-dir: read pages saved by a person, make no request
MANUAL_HASHES = {}
DEFAULT_POLICY = {"fresh_hours": 12, "outdated_hours": 48, "reminder_hours": 48}
# Observed behaviour: requests two seconds apart were answered with HTTP 429 by
# the third to fifth page. A polite, jittered spacing costs a few minutes per
# run and removes the burst. Overridable for tests and for the operator.
REQUEST_SPACING_SECONDS = float(os.environ.get("ACTAWP_REQUEST_SPACING_SECONDS", "30"))


def polite_pause():
    if MANUAL_DIR is not None:
        return  # reading files a person saved: there is nobody to be polite to
    time.sleep(REQUEST_SPACING_SECONDS + random.uniform(0, REQUEST_SPACING_SECONDS / 3))


def manual_filename(category):
    """File a person saves for a category, e.g. 'Alevín Mixto A' -> 'alevin-mixto-a.html'."""
    text = unicodedata.normalize("NFKD", category.lower())
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-") + ".html"


def read_manual_page(category, tournament_id, calendar_id):
    path = Path(MANUAL_DIR) / manual_filename(category)
    if not path.is_file():
        raise RuntimeError(f"Falta el fichero guardado {path.name} ({category})")
    raw = path.read_bytes()
    html = raw.decode("utf-8", errors="replace")
    if "tabletype-public" not in html:
        raise RuntimeError(f"{path.name}: no contiene la tabla pública de calendario; ¿se guardó la página correcta?")
    if f"/tournament/{tournament_id}/" not in html:
        raise RuntimeError(f"{path.name}: no corresponde a {category} (torneo {tournament_id})")
    MANUAL_HASHES[path.name] = hashlib.sha256(raw).hexdigest()
    return html


def fetch_group(category, tournament_id, calendar_id):
    key = (tournament_id, calendar_id)
    if MANUAL_DIR is not None:
        html = read_manual_page(category, tournament_id, calendar_id)
    elif key in CACHE:
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
                if isinstance(exc, SourceChallengeError):
                    # The server is asking this client to stop; asking again is not a retry.
                    raise RuntimeError(f"Desafío de navegador: {exc}") from exc
                if "429" in str(exc) or "Too Many Requests" in str(exc):
                    raise RuntimeError("HTTP 429: ActaWP limita temporalmente las consultas") from exc
                if attempt == 0:
                    time.sleep(5)
        else:
            raise RuntimeError(f"No se pudo cargar grupo {calendar_id}: {last_error}")

    pending = []
    matches = parse_calendar_html(html, category, tournament_id, calendar_id, diagnostics=DIAGNOSTICS, pending=pending)
    PENDING_BY_GROUP[key] = pending
    print(f"{category}, grupo {calendar_id}: {len(matches)} partidos AESE, {len(pending)} pendientes", flush=True)
    return matches, html


def discover_group_ids(html, tournament_id):
    """ActaWP incluye enlaces a todos los grupos en la navegación del calendario."""
    regex = rf"(?:https?://actawp\.natacio\.cat)?/(?:ca|es|en|fr|de|it|pt|eu)/tournament/{tournament_id}/calendar/(\d+)"
    ids = {int(value) for value in re.findall(regex, html)}
    return sorted(ids)


def fetch_category(category, tournament_id, default_id, overrides):
    first_id = int(overrides.get(category, default_id))
    matches, html = fetch_group(category, tournament_id, first_id)
    if matches or MANUAL_DIR is not None:
        # Reading saved pages never goes looking for other groups.
        return matches, (first_id if matches else None)

    group_ids = discover_group_ids(html, tournament_id)
    print(f"GRUPOS disponibles en {category}: {group_ids}", flush=True)
    if not group_ids:
        raise RuntimeError(f"Sin enlaces de grupos para {category}")

    for group_id in group_ids:
        if group_id == first_id:
            continue
        polite_pause()
        candidates, _ = fetch_group(category, tournament_id, group_id)
        if candidates:
            print(f"GRUPO AESE ENCONTRADO {category}: {group_id}", flush=True)
            return candidates, group_id
    return [], None


def classify_error(message):
    """Stable machine-readable class for an error line, for monitoring and alerts."""
    text = str(message)
    if "pendiente por límite" in text:
        return "skipped_after_rate_limit"
    if "429" in text or "Too Many Requests" in text:
        return "rate_limited"
    if "desafío" in text.lower() or "challenge" in text.lower():
        return "browser_challenge"
    if re.search(r"AESE \d+ sin dos equipos", text):
        return "aese_row_unreadable"
    if "snapshot bloqueado" in text or "bloqueado" in text:
        return "validation_blocked"
    if "AESE no aparece" in text or "Sin enlaces de grupos" in text:
        return "unexpected_structure"
    return "other"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_json_or(path, default):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else default
    except (OSError, ValueError):
        return default


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline='\n')
    temporary.replace(path)


def load_policy():
    """How old official data may be before people are told. Travels inside the
    published status so Apps Script, the family page and the status page all
    judge freshness with the same numbers."""
    value = load_json_or(POLICY, {})
    policy = dict(DEFAULT_POLICY)
    for key in DEFAULT_POLICY:
        number = value.get(key)
        if isinstance(number, (int, float)) and not isinstance(number, bool) and number > 0:
            policy[key] = number
    if policy["outdated_hours"] <= policy["fresh_hours"]:
        return dict(DEFAULT_POLICY)
    # False declares that nobody attempts to read ActaWP by machine: Apps Script then does not treat the
    # age of the last attempt as a failure. Only an explicit boolean is carried; anything else is dropped.
    if isinstance(value.get("automated_attempts"), bool):
        policy["automated_attempts"] = value["automated_attempts"]
    return policy


def load_overrides():
    if not DISCOVERY.exists():
        return {}
    value = json.loads(DISCOVERY.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def main():
    CACHE.clear()
    DIAGNOSTICS.clear()
    PENDING_BY_GROUP.clear()
    MANUAL_HASHES.clear()
    pending_all = []
    overrides = load_overrides()
    # Reviewed federation notices must not be rolled back by a stale source page.
    corrections = json.loads(STATUS.read_text(encoding="utf-8")).get("reviewed_corrections", []) if STATUS.exists() else []
    collected = []
    counts = {}
    errors = []
    throttled = False

    for category, (tournament_id, default_id) in CALENDARS.items():
        if throttled:
            errors.append(f"{category}: pendiente por límite HTTP 429 o desafío del servidor")
            continue
        if counts:
            polite_pause()
        try:
            matches, discovered_id = fetch_category(category, tournament_id, default_id, overrides)
            counts[category] = len(matches)
            if not matches:
                errors.append(f"{category}: AESE no aparece en los grupos publicados")
            else:
                overrides[category] = discovered_id
                collected.extend(match.to_dict() for match in matches)
                pending_all.extend(PENDING_BY_GROUP.get((tournament_id, discovered_id), []))
                save_json(DISCOVERY, overrides)
        except Exception as exc:
            errors.append(f"{category}: {exc}")
            if "429" in str(exc) or "Desafío de navegador" in str(exc):
                throttled = True
            print(f"ERROR {category}: {exc}", flush=True)

    unique = {(item["tournament_id"], item["match_id"]): item for item in collected}
    if len(unique) != len(collected):
        errors.append("Identidad de partido duplicada; snapshot bloqueado")
    output = sorted(unique.values(), key=lambda item: item["start"])
    for correction in corrections:
        for match in output:
            identity = f"{match['tournament_id']}:{match['match_id']}"
            if identity == correction['identity'] and match['start'] == correction['previous_start']:
                errors.append(f"{identity}: origen conserva fecha anterior al aviso oficial revisado; snapshot bloqueado")
    if not output and not errors:
        errors.append("Snapshot vacío bloqueado")
    complete = not errors and len(counts) == len(CALENDARS)
    if OUT.exists() and complete:
        previous = json.loads(OUT.read_text(encoding="utf-8"))
        missing = {(m['tournament_id'], m['match_id']) for m in previous} - set(unique)
        if missing:
            errors.append(f"Partidos desaparecidos sin cancelación explícita: {sorted(missing)}; snapshot bloqueado")
            complete = False
    attempted_at = now_iso()
    published = load_json_or(STATUS, {})
    previous_attempt = load_json_or(ATTEMPT_STATUS, {})
    failures = 0 if not errors else int(previous_attempt.get("consecutive_failures", 0) or 0) + 1
    status = {
        "attempted_at": attempted_at,
        "complete": complete,
        "categories_expected": list(CALENDARS),
        "counts": counts,
        "total_matches_found": len(output),
        "errors": errors,
        "error_classes": sorted({classify_error(error) for error in errors}),
        "consecutive_failures": failures,
        # Freshness of the *official* data, not of the last attempt: this is the
        # only timestamp that says how old the published schedule really is.
        "last_complete_export_at": published.get("last_complete_export_at"),
        "ignored_row_ids": sorted({row["match_id"] for row in DIAGNOSTICS}),
        # AESE matches that ActaWP itself lists without rival and/or date. They
        # cannot be calendar events yet; they are shown, never silently dropped.
        "pending_matches": sorted(pending_all, key=lambda item: (item["tournament_id"], item["match_id"])),
        "source": ({"mode": "manual_import", "files": dict(sorted(MANUAL_HASHES.items()))}
                   if MANUAL_DIR is not None else {"mode": "automated"}),
        "freshness_policy": load_policy(),
        "reviewed_corrections": corrections,
    }
    # Manual audit annotations survive an automatic publication.
    for key in ("official_times_audit", "incident_review"):
        if key in published:
            status[key] = published[key]
    # Bulky row excerpts live in their own file, so the attempt record and the
    # published status stay identical (the publication gate compares them).
    save_json(IGNORED_ROWS, {"attempted_at": attempted_at, "rows": list(DIAGNOSTICS)})
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
    status['last_complete_export_at'] = attempted_at
    status['snapshot_sha256'] = hashlib.sha256(OUT.read_bytes()).hexdigest()
    save_json(ATTEMPT_STATUS, status)
    save_json(STATUS, status)
    print(f"PUBLICADO: {len(output)} partidos AESE únicos de {len(CALENDARS)} categorías", flush=True)


def list_manual_pages():
    overrides = load_overrides()
    print("Guarda cada página con «Guardar como» (Ctrl+S, «solo HTML») usando exactamente este nombre:\n")
    for category, (tournament_id, default_id) in CALENDARS.items():
        group = int(overrides.get(category, default_id))
        print(f"{manual_filename(category):32} {calendar_url(tournament_id, group)}")


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-dir", metavar="DIR",
                        help="lee las páginas de ActaWP guardadas a mano en DIR; no hace ninguna petición")
    parser.add_argument("--list-manual", action="store_true",
                        help="muestra qué página guardar y con qué nombre")
    args = parser.parse_args(argv)
    if args.list_manual:
        list_manual_pages()
        return 0
    if args.from_dir:
        global MANUAL_DIR
        MANUAL_DIR = args.from_dir
        main()
        return 0
    if os.environ.get("ACTAWP_AUTOMATED_ACCESS_AUTHORIZED") != "yes":
        print("Acceso automatizado a ActaWP desactivado: las condiciones de uso de Clupik lo prohíben sin "
              "autorización escrita. Usa --from-dir con páginas guardadas a mano. Si existe autorización, "
              "exporta ACTAWP_AUTOMATED_ACCESS_AUTHORIZED=yes.", flush=True)
        return 2
    main()
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
