"""Extractor independiente de calendarios públicos ActaWP para AESE Waterpolo."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html import unescape
import os
import re
import unicodedata
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from actawp_fetch import fetch_html

MADRID = ZoneInfo("Europe/Madrid")
# Overridable only so the end-to-end tests can point the real HTTP client at a local server.
BASE_URL = os.environ.get("ACTAWP_BASE_URL", "https://actawp.natacio.cat")
AESE_MARKER = "SANTA EULALIA"
TEAM_SUFFIX = {
    'Alevín Mixto A': 'A', 'Alevín Mixto B': 'B',
    'Infantil Mixto A': 'A', 'Infantil Mixto B': 'B',
}

CALENDARS = {
    "Absoluto Masculino": (1339803, 3714121),
    "Alevín Mixto A": (1339810, 3714185),
    "Alevín Mixto B": (1339810, 3714193),
    "Cadete Masculino": (1339808, 3714150),
    "Infantil Mixto A": (1339809, 3714166),
    "Infantil Mixto B": (1339809, 3714183),
    "Juvenil Femenino": (1339811, 3714138),
    "1a Div Fem Absoluta B": (1339806, 3713773),
    "Juvenil Masculino": (1339807, 3714140),
}


@dataclass(frozen=True)
class Match:
    category: str
    tournament_id: int
    calendar_id: int
    match_id: int
    home_team: str
    away_team: str
    start: str
    venue: str
    round_name: str | None
    url: str

    def to_dict(self) -> dict:
        return asdict(self)


def calendar_url(tournament_id: int, calendar_id: int, language: str = "ca") -> str:
    return f"{BASE_URL}/{language}/tournament/{tournament_id}/calendar/{calendar_id}/all"


def _clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", unescape(value)).strip()


def _normalized(value: str) -> str:
    return ''.join(char for char in unicodedata.normalize('NFKD', value.upper()) if not unicodedata.combining(char))


def _is_aese(value: str) -> bool:
    return AESE_MARKER in _normalized(value)


def _extract_round(soup: BeautifulSoup) -> str | None:
    heading = soup if soup.name == "h2" else soup.find("h2", class_=lambda c: c and "bottom-bordered" in c)
    if not heading:
        heading = soup.find("h2")
    if not heading:
        return None
    text = _clean(heading.get_text(" ", strip=True))
    match = re.search(r"Jornada\s+\d+(?:\s*[-–]\s*\d+)?", text, re.I)
    return match.group(0).strip() if match else None


def _extract_local_datetime(data_sort: str, display_text: str) -> datetime:
    displayed = _clean(display_text)
    # ActaWP renders a stale GMT+2 label in winter. Its sortable timestamp is
    # UTC; verify it against the visible Madrid wall clock, ignoring the label.
    match = re.search(r"(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})", data_sort)
    if not match:
        raise ValueError(f"No se pudo interpretar la fecha: {data_sort!r}")
    year, month, day, hour, minute, second = map(int, match.groups())
    local = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).astimezone(MADRID)
    visible = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4}).*?(\d{1,2}):(\d{2})", displayed)
    if visible:
        day, month, year, hour, minute = map(int, visible.groups())
        if year < 100:
            year += 2000
        if (year, month, day, hour, minute) != (local.year, local.month, local.day, local.hour, local.minute):
            raise ValueError("Fecha UTC y hora visible Europe/Madrid contradictorias")
    return local


MAX_DIAGNOSTIC_ROWS = 25
_SNIPPET_CHARS = 1000
# ActaWP marks a match without a date with this sortable placeholder
# ("5 9999-99-99 99:99:99 <team>"); real dates never contain it.
_UNDATED_SORT = re.compile(r"(?:^|\s)9999-99-99(?:\s|$)")


def _row_teams(row) -> list[str]:
    """Teams in DOM order. Only team-profile links are a fallback: the results
    link in this same cell merely says "Veure"."""
    teams = []
    for node in row.select('.colstyle-equipo span.ellipsis, .colstyle-equipo a[href*="/team/"]'):
        if node.name == "a" and node.select_one("span.ellipsis"):
            continue
        team = _clean(node.get("title") or node.get_text(" ", strip=True))
        if team:
            teams.append(team)
    return teams


def _row_undated(row) -> bool:
    """True only for ActaWP's explicit "no date yet" marker with no visible date."""
    cell = row.select_one(".colstyle-fecha")
    if cell is None:
        return False
    node = cell.find(attrs={"data-sort": True})
    if node is None or not _UNDATED_SORT.search(node.get("data-sort", "")):
        return False
    return not re.search(r"\d{1,2}/\d{1,2}/\d{2,4}", _clean(cell.get_text(" ", strip=True)))


def _row_mentions_aese(row) -> bool:
    """True if AESE appears in the row outside the date/venue cell.

    A row that cannot be read as two teams is only harmless when AESE is
    demonstrably absent from it. Everything except the date/venue cell is
    inspected (text and title/alt attributes), not just the team cells, so an
    AESE match with a damaged team cell cannot be ignored. The venue cell is
    excluded on purpose: AESE's own pool, "Santa Eulàlia", also hosts other
    clubs' matches.
    """
    def in_venue_cell(node):
        tag = node if hasattr(node, "attrs") else node.parent
        return tag is not None and (tag.find_parent(class_="colstyle-fecha") is not None
                                    or "colstyle-fecha" in (tag.get("class") or []))
    for text in row.find_all(string=True):
        if not in_venue_cell(text) and _is_aese(str(text)):
            return True
    for node in row.find_all(True):
        if in_venue_cell(node):
            continue
        for attribute in ("title", "alt", "aria-label", "data-title", "data-name"):
            value = node.get(attribute)
            if isinstance(value, str) and _is_aese(value):
                return True
    return False


def _row_diagnostic(row, match_id: int, category: str, teams: list[str]) -> dict:
    return {
        "category": category,
        "match_id": match_id,
        "teams_found": teams,
        "aese_mentioned": False,
        "row_text": _clean(row.get_text(" ", strip=True))[:300],
        # Bounded excerpt kept only so an anomaly can be inspected without
        # re-requesting the page.
        "row_html": re.sub(r"\s+", " ", str(row))[:_SNIPPET_CHARS],
    }


def parse_calendar_html(html: str, category: str, tournament_id: int, calendar_id: int,
                        diagnostics: list | None = None, pending: list | None = None) -> list[Match]:
    """Parse one ActaWP calendar page and return only the AESE matches.

    * A row of another club that cannot be read as two teams must not block
      AESE's own data; it is recorded in ``diagnostics`` so it stays visible.
    * An AESE row that cannot be read blocks the snapshot: it is ambiguous.
    * One exception, and only when the caller passes a ``pending`` list: an AESE
      match that ActaWP itself marks as undated (rival still to be assigned
      and/or no date yet). It cannot become a calendar event, so it is recorded
      in ``pending`` (visible, never silently dropped) instead of blocking every
      other match. Without a ``pending`` list those rows still block.
    """
    soup = BeautifulSoup(html, "html.parser")
    round_name = _extract_round(soup)
    matches: list[Match] = []

    for row in soup.select("table.tabletype-public tbody tr"):
        link = row.select_one('a[href*="/match/"][href$="/results"]')
        if not link:
            continue
        match_id_match = re.search(r"/match/(\d+)/results", link.get("href", ""))
        if not match_id_match:
            continue
        match_id = int(match_id_match.group(1))

        teams = _row_teams(row)
        aese_teams = [team for team in teams if _is_aese(team)]
        if not aese_teams:
            if len(teams) < 2:
                # Unreadable row: harmless only if AESE is demonstrably absent.
                if _row_mentions_aese(row):
                    raise ValueError(f"Fila de partido AESE {match_id} sin dos equipos; snapshot bloqueado")
                if diagnostics is not None and len(diagnostics) < MAX_DIAGNOSTIC_ROWS:
                    diagnostics.append(_row_diagnostic(row, match_id, category, teams))
            # ActaWP calendar pages contain the complete competition calendar;
            # only matches involving A.E. Santa Eulàlia are kept.
            continue
        expected_suffix = TEAM_SUFFIX.get(category)
        if expected_suffix and not any(_normalized(team).rstrip().endswith(' ' + expected_suffix) for team in aese_teams):
            continue
        if len(teams) > 2:
            raise ValueError(f"Fila de partido AESE {match_id} sin dos equipos; snapshot bloqueado")

        if re.search(r'\b(ajornat|aplazado|cancelado|cancel·lat|anul·lat|suspès)\b', row.get_text(' ', strip=True), re.I):
            raise ValueError(f"Partido AESE {match_id} aplazado/cancelado: revisar estado explícito antes de publicar")

        undated = _row_undated(row)
        if len(teams) < 2 or (undated and pending is not None):
            if undated and pending is not None:
                href = link.get("href", "")
                pending.append({
                    "category": category,
                    "tournament_id": tournament_id,
                    "calendar_id": calendar_id,
                    "match_id": match_id,
                    "teams": teams,
                    "reason": "sin_rival_ni_fecha" if len(teams) < 2 else "sin_fecha",
                    "url": "https://actawp.natacio.cat" + href if href.startswith("/") else href,
                })
                continue
            raise ValueError(f"Fila de partido AESE {match_id} sin dos equipos; snapshot bloqueado")

        date_cell = row.select_one(".colstyle-fecha")
        if not date_cell:
            raise ValueError(f"Partido AESE {match_id} sin fecha; snapshot bloqueado")
        date_node = date_cell.find(attrs={"data-sort": True})
        if not date_node:
            raise ValueError(f"Partido AESE {match_id} sin fecha ordenable; snapshot bloqueado")
        data_sort = date_node.get("data-sort", "")
        display_text = _clean(date_cell.get_text(" ", strip=True))
        try:
            start = _extract_local_datetime(data_sort, display_text)
        except ValueError as exc:
            raise ValueError(f"Partido AESE {match_id}: fecha inválida; snapshot bloqueado") from exc

        venue_node = date_cell.select_one("span.ellipsis[title]")
        venue = _clean(venue_node.get("title") if venue_node else "")
        href = link.get("href", "")
        url = "https://actawp.natacio.cat" + href if href.startswith("/") else href

        matches.append(Match(
            category=category,
            tournament_id=tournament_id,
            calendar_id=calendar_id,
            match_id=match_id,
            home_team=teams[0],
            away_team=teams[1],
            start=start.isoformat(),
            venue=venue,
            round_name=_extract_round(row.find_parent("table").find_previous("h2") or soup) or round_name or '',
            url=url,
        ))

    unique: dict[int, Match] = {}
    for match in matches:
        if match.match_id in unique and unique[match.match_id] != match:
            raise ValueError(f"Partido {match.match_id} duplicado con datos contradictorios")
        unique[match.match_id] = match
    return sorted(unique.values(), key=lambda match: match.start)


def fetch_calendar(category: str, tournament_id: int, calendar_id: int, timeout: int = 30) -> list[Match]:
    return parse_calendar_html(fetch_html(calendar_url(tournament_id, calendar_id), timeout), category, tournament_id, calendar_id)


def fetch_all() -> list[Match]:
    all_matches: list[Match] = []
    for category, (tournament_id, calendar_id) in CALENDARS.items():
        all_matches.extend(fetch_calendar(category, tournament_id, calendar_id))
    unique: dict[int, Match] = {match.match_id: match for match in all_matches}
    return sorted(unique.values(), key=lambda match: match.start)


if __name__ == "__main__":
    import json
    print(json.dumps([match.to_dict() for match in fetch_all()], ensure_ascii=False, indent=2))
