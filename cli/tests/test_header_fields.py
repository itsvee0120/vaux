"""Tests for _build_http_header_fields (vaux/app.py), which formats headers
yt-dlp attached to a resolved stream URL for mpv's --http-header-fields
option. Real sample from live yt-dlp output during the mpv-403 investigation
— Accept and Accept-Language both contain literal commas that must be
backslash-escaped, since mpv's list-option parser splits on unescaped commas.
"""

from __future__ import annotations

from vaux.app import _build_http_header_fields

SAMPLE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
}


def test_excludes_user_agent():
    result = _build_http_header_fields(SAMPLE_HEADERS)
    assert "User-Agent" not in result


def test_escapes_commas_in_header_values():
    result = _build_http_header_fields(SAMPLE_HEADERS)
    assert "text/html\\,application/xhtml+xml\\,application/xml;q=0.9\\,*/*;q=0.8" in result
    assert "en-us\\,en;q=0.5" in result


def test_splitting_on_unescaped_commas_yields_three_items():
    result = _build_http_header_fields(SAMPLE_HEADERS)
    # mpv's list-option parser splits on unescaped commas; a real parser
    # would unescape "\," back to "," within each item. Mimic that here.
    raw_items = result.split(",")
    items = []
    buf = ""
    for part in raw_items:
        if buf:
            buf += "," + part
        else:
            buf = part
        if not buf.endswith("\\"):
            items.append(buf.replace("\\,", ","))
            buf = ""
    assert len(items) == 3
    assert items[0] == "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    assert items[1] == "Accept-Language: en-us,en;q=0.5"
    assert items[2] == "Sec-Fetch-Mode: navigate"


def test_empty_dict_returns_empty_string():
    assert _build_http_header_fields({}) == ""


def test_only_user_agent_returns_empty_string():
    assert _build_http_header_fields({"User-Agent": "x"}) == ""
