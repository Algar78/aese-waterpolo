"""Read-only publication gate. Never accept a previous successful export."""
import hashlib
import json
import sys
from pathlib import Path


def validate(root, fetch_complete):
    if fetch_complete != 'true':
        raise ValueError('Extracción incompleta o fallida; se conserva el calendario publicado')
    data = Path(root) / 'data'
    attempt = json.loads((data / 'actawp_last_attempt.json').read_text(encoding='utf-8'))
    status = json.loads((data / 'actawp_export_status.json').read_text(encoding='utf-8'))
    raw = (data / 'actawp_matches.json').read_bytes()
    matches = json.loads(raw)
    if attempt != status or status.get('complete') is not True or status.get('errors') != []:
        raise ValueError('Intento y validación no confirman una exportación completa')
    if status.get('snapshot_sha256') != hashlib.sha256(raw).hexdigest():
        raise ValueError('Hash del snapshot no coincide con la validación')
    expected = status['categories_expected']
    counts = {category: 0 for category in expected}
    identities = set()
    if len(counts) != 9 or len(expected) != 9 or not matches:
        raise ValueError('Exportación vacía o categorías incompletas')
    for match in matches:
        identity = (match['tournament_id'], match['match_id'])
        if identity in identities or not match['home_team'].strip() or not match['away_team'].strip():
            raise ValueError('Identidad duplicada o equipos incompletos')
        identities.add(identity)
        counts[match['category']] += 1
    if counts != status['counts'] or not all(counts.values()) or len(matches) != status['total_matches_found']:
        raise ValueError('Conteos del snapshot no coinciden con la validación')


if __name__ == '__main__':
    try:
        validate(Path.cwd(), sys.argv[1] if len(sys.argv) > 1 else '')
    except Exception as exc:
        print(f'::error::Publicación bloqueada; calendario anterior conservado: {exc}')
        raise SystemExit(1)
