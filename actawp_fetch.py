"""Cliente HTTP para ActaWP: educado, identificado y sin elusión.

Qué hace
- Se identifica con un User-Agent propio (nada de hacerse pasar por un navegador).
- Respeta HTTP 429 y ``Retry-After``; la espera se conserva entre ejecuciones.
- Registra la respuesta REAL de cada petición (estado, cabeceras relevantes,
  tiempos) en ``data/actawp_request_log.json``. Sin ese registro, un fallo
  directo quedaba oculto detrás del error del último intento.

Qué NO hace (a propósito)
- No resuelve el desafío de navegador (proof-of-work) de ActaWP.
- No usa proxies ni traductores (Corsfix, Google Translate, Jina...) para llegar
  a una página que el servidor no entrega a este cliente.
Si el servidor limita o pide verificación, el exportador se detiene, conserva el
último dato válido y lo notifica. La solución es obtener un acceso autorizado,
no esquivar el control (ver docs/audit-2026-10-18.md).
"""
from __future__ import annotations

import json
import math
import random
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit

import requests

UA = 'AESE-Waterpolo-Calendar/1.0 (+https://github.com/Algar78/aese-waterpolo)'
CHALLENGE_MARKER = 'Comprovant el teu navegador'
_SESSION = requests.Session()
_COOLDOWN_PATH = Path(__file__).parent / 'data' / 'actawp_http_cooldowns.json'
_LOG_PATH = Path(__file__).parent / 'data' / 'actawp_request_log.json'
_LOG_LIMIT = 60
_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    'Accept-Language': 'ca-ES,ca;q=0.9,es;q=0.8,en;q=0.6',
}


class SourceChallengeError(RuntimeError):
    """ActaWP answered with a browser-verification page instead of the calendar."""


def _safe_text(response):
    try:
        return response.text or ''
    except Exception:
        return ''


def _safe_bytes(response):
    try:
        return response.content or b''
    except Exception:
        return b''


def _log_request(url, started, response=None, error=None):
    """Append one factual record; never raise (logging must not break a run)."""
    try:
        parts = urlsplit(url)
        entry = {
            'at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'host': parts.netloc,
            'path': parts.path,
            'elapsed_ms': int((time.monotonic() - started) * 1000),
        }
        if response is not None:
            text = _safe_text(response)
            entry.update({
                'status': response.status_code,
                'retry_after': response.headers.get('Retry-After'),
                'server': response.headers.get('Server'),
                'content_type': response.headers.get('Content-Type'),
                'bytes': len(_safe_bytes(response)),
                'challenge': CHALLENGE_MARKER in text,
            })
            if response.status_code != 200:
                entry['body_hint'] = ' '.join(text.split())[:120]
        if error is not None:
            entry['error'] = f'{type(error).__name__}: {error}'[:200]
        log = json.loads(_LOG_PATH.read_text()) if _LOG_PATH.exists() else []
        log = (log if isinstance(log, list) else []) + [entry]
        _LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _LOG_PATH.write_text(json.dumps(log[-_LOG_LIMIT:], ensure_ascii=False, indent=0) + '\n')
    except (OSError, ValueError, TypeError):
        pass


def _get_with_backoff(client, url, *, headers, timeout):
    """Respect Retry-After; never route a rate-limited request around the server."""
    origin = urlsplit(url).netloc or url
    cooldowns = json.loads(_COOLDOWN_PATH.read_text()) if _COOLDOWN_PATH.exists() else {}
    until = float(cooldowns.get(origin, 0))
    if until > time.time():
        r = requests.Response()
        r.status_code = 429
        r.url = url
        r.headers['Retry-After'] = str(math.ceil(until - time.time()))
        raise requests.HTTPError('HTTP 429 persisted server cooldown', response=r)
    deadline = time.monotonic() + 120
    for attempt in range(4):
        started = time.monotonic()
        try:
            response = client.get(url, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            _log_request(url, started, error=exc)
            raise
        _log_request(url, started, response=response)
        if response.status_code != 429:
            return response
        retry = response.headers.get('Retry-After', '')
        try:
            delay = float(retry)
            if delay < 0 or not math.isfinite(delay):
                raise ValueError('invalid delay')
        except (ValueError, TypeError):
            try:
                target = parsedate_to_datetime(retry)
                if target.tzinfo is None:
                    target = target.replace(tzinfo=timezone.utc)
                server_date = response.headers.get('Date')
                now = parsedate_to_datetime(server_date) if server_date else datetime.now(timezone.utc)
                delay = max(0, (target - now).total_seconds())
            except (ValueError, TypeError, OverflowError):
                delay = 0
        delay = max(delay, 2 ** attempt + random.uniform(0, 1))
        cooldowns[origin] = time.time() + delay
        _COOLDOWN_PATH.parent.mkdir(parents=True, exist_ok=True)
        _COOLDOWN_PATH.write_text(json.dumps(cooldowns, sort_keys=True) + '\n')
        if attempt == 3:
            response.raise_for_status()
        if time.monotonic() + delay + timeout > deadline:
            # Abort this export; the last good snapshot and the next scheduled
            # run remain responsible for recovery, without truncating the wait.
            response.raise_for_status()
        print(f'HTTP 429: waiting {delay:.1f}s before same-endpoint retry')
        time.sleep(delay)
    raise AssertionError('unreachable')


def _rate_limited(exc):
    return getattr(getattr(exc, 'response', None), 'status_code', None) == 429 or '429' in str(exc)


def fetch_html(url: str, timeout: int = 30) -> str:
    """One direct, identified request. No proxies, no challenge solving."""
    response = _get_with_backoff(_SESSION, url, headers=_HEADERS, timeout=timeout)
    if response.status_code == 429:
        response.raise_for_status()
    if CHALLENGE_MARKER in response.text:
        raise SourceChallengeError(
            f'ActaWP respondió con un desafío de navegador (HTTP {response.status_code}); '
            'no se resuelve automáticamente. Se necesita acceso autorizado.')
    response.raise_for_status()
    return response.text
