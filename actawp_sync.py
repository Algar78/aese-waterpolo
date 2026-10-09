"""Extractor independiente de calendarios públicos ActaWP para AESE Waterpolo."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
import re
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from actawp_fetch import fetch_html

MADRID = ZoneInfo("Europe/Madrid")

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
    return f"https://actawp.natacio.cat/{language}/tournament/{tournament_id}/calendar/{calendar_id}/all"


def _clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", unescape(value)).strip()


def _extract_round(soup: BeautifulSoup) -> str | None:
    heading = soup.find("h2", class_=lambda c: c and "bottom-bordered" in c)
    if not heading:
        heading = soup.find("h2")
    if not heading:
        return None
    text = _clean(heading.get_text(" ", strip=True))
    match = re.search(r"Jornada\s+\d+(?:\s*[-–]\s*\d+)?", text, re.I)
    return match.group(0).strip() if match else None


def _extract_local_datetime(data_sort: str, display_text: str) -> datetime:
    """Return the displayed Europe/Madrid time.

    ActaWP exposes a data-sort timestamp that is UTC-like while the page also
    displays the actual local time with GMT offset. When the explicit display
    is present, use that offset directly; otherwise fall back to data-sort as
    UTC and convert to Europe/Madrid.
    """
    displayed = _clean(display_text)
    explicit = re.search(
        r"(\d{1,2})/(\d{1,2})/(\d{2,4}).*?(\d{1,2}:\d{2})\s+GMT([+-]\d{1,2})",
        displayed,
    )
    if explicit:
        day, month, year = map(int, explicit.group(1, 2, 3))
        if year < 100:
            year += 2000
        hour, minute = map(int, explicit.group(4).split(":"))
        offset_hours = int(explicit.group(5))
        fixed_zone = timezone(timedelta(hours=offset_hours))
        return datetime(year, month, day, hour, minute, tzinfo=fixed_zone).astimezone(MADRID)

    match = re.search(r"(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})", data_sort)
    if not match:
        raise ValueError(f"No se pudo interpretar la fecha: {data_sort!r}")
    year, month, day, hour, minute, second = map(int, match.groups())
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc).astimezone(MADRID)


def parse_calendar_html(html: str, category: str, tournament_id: int, calendar_id: int) -> list[Match]:
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

        teams = [_clean(node.get("title") or node.get_text(" ", strip=True)) for node in row.select(".colstyle-equipo span.ellipsis")]
        if len(teams) < 2:
            teams = [_clean(node.get_text(" ", strip=True)) for node in row.select(".colstyle-equipo a")]
        if len(teams) < 2:
            continue

        date_cell = row.select_one(".colstyle-fecha")
        if not date_cell:
            continue
        date_node = date_cell.find(attrs={"data-sort": True})
        if not date_node:
            continue
        data_sort = date_node.get("data-sort", "")
        display_text = _clean(date_cell.get_text(" ", strip=True))
        try:
            start = _extract_local_datetime(data_sort, display_text)
        except ValueError:
            continue

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
            round_name=round_name,
            url=url,
        ))

    unique: dict[int, Match] = {match.match_id: match for match in matches}
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
