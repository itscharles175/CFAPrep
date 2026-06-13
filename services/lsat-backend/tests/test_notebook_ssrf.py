"""SSRF guard for Notebook OS URL imports (Codex backend P1 #2).

``source_from_url`` previously fetched with ``follow_redirects=True`` and only
checked the FINAL host AFTER the request completed. A public URL that 302s to
``http://127.0.0.1`` / a LAN / private IP was therefore fetched before the guard
could reject it. The fix follows redirects MANUALLY, validating every hop's host
via ``_validate_public_url`` BEFORE issuing the next request.

These tests pin a fake httpx transport so no real network call happens, and pin
``socket.getaddrinfo`` so the real ``_validate_public_url`` logic stays exercised
(public host resolves public, the redirect target resolves to loopback/private).
"""
from __future__ import annotations

import socket

import httpx
import pytest

from app import notebook_os

PUBLIC_HOST = "research.example"
PRIVATE_TARGET = "http://127.0.0.1:9000/internal"
LEAK_MARKER = "INTERNAL-SECRET-THAT-MUST-NOT-BE-FETCHED"


def _pin_dns(monkeypatch, mapping: dict[str, str]) -> None:
    """Make ``_validate_public_url``'s DNS lookups deterministic.

    Hosts in ``mapping`` resolve to the given IP; anything else raises like a
    real failed lookup so an unexpected request can't silently "pass".
    """

    def fake_getaddrinfo(host, *args, **kwargs):  # noqa: ANN001, ANN002
        try:
            ip = mapping[host]
        except KeyError as exc:  # pragma: no cover - guards test mistakes
            raise socket.gaierror(f"unexpected host {host!r}") from exc
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    monkeypatch.setattr(notebook_os.socket, "getaddrinfo", fake_getaddrinfo)


def _pin_transport(monkeypatch, handler):
    """Route every ``httpx.Client`` built inside notebook_os through a mock."""
    real_client = httpx.Client

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(notebook_os.httpx, "Client", client_factory)


def test_redirect_to_loopback_is_blocked_before_fetch(monkeypatch):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if request.url.host == PUBLIC_HOST:
            # Public page bounces to an internal address.
            return httpx.Response(302, headers={"location": PRIVATE_TARGET})
        # Reaching here means the loopback target was actually fetched (SSRF).
        return httpx.Response(200, text=LEAK_MARKER)

    _pin_dns(monkeypatch, {PUBLIC_HOST: "93.184.216.34", "127.0.0.1": "127.0.0.1"})
    _pin_transport(monkeypatch, handler)

    with pytest.raises(ValueError) as excinfo:
        notebook_os.source_from_url(f"http://{PUBLIC_HOST}/article")

    assert str(excinfo.value) == "private_url_blocked"
    # The public host's redirect response is fetched once; the loopback target
    # must NEVER be requested.
    assert requested == [f"http://{PUBLIC_HOST}/article"]
    assert all("127.0.0.1" not in url for url in requested)


def test_redirect_to_private_lan_is_blocked_before_fetch(monkeypatch):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if request.url.host == PUBLIC_HOST:
            return httpx.Response(301, headers={"location": "http://intranet.example/admin"})
        return httpx.Response(200, text=LEAK_MARKER)

    _pin_dns(
        monkeypatch,
        {PUBLIC_HOST: "93.184.216.34", "intranet.example": "10.0.0.5"},
    )
    _pin_transport(monkeypatch, handler)

    with pytest.raises(ValueError) as excinfo:
        notebook_os.source_from_url(f"http://{PUBLIC_HOST}/start")

    assert str(excinfo.value) == "private_url_blocked"
    assert requested == [f"http://{PUBLIC_HOST}/start"]
    assert all(LEAK_MARKER not in (url) for url in requested)


def test_normal_public_redirect_chain_still_fetches_final_page(monkeypatch):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if request.url.host == PUBLIC_HOST:
            return httpx.Response(302, headers={"location": "http://cdn.example/final"})
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<html><body>Conditional logic survives a public hop.</body></html>",
        )

    _pin_dns(
        monkeypatch,
        {PUBLIC_HOST: "93.184.216.34", "cdn.example": "151.101.0.1"},
    )
    _pin_transport(monkeypatch, handler)

    result = notebook_os.source_from_url(f"http://{PUBLIC_HOST}/article")

    assert result["source_type"] == "web"
    assert "Conditional logic survives a public hop." in result["content"]
    assert requested == [
        f"http://{PUBLIC_HOST}/article",
        "http://cdn.example/final",
    ]


def test_redirect_loop_is_capped(monkeypatch):
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        # Always bounce to a fresh public host so the cap (not the SSRF guard)
        # is what stops us.
        nxt = f"http://hop{len(requested)}.example/next"
        return httpx.Response(302, headers={"location": nxt})

    # Every hopN.example host resolves public so _validate_public_url passes and
    # only the redirect cap can terminate the loop.
    class _AlwaysPublic(dict):
        def __getitem__(self, key):  # noqa: ANN001
            return "93.184.216.34"

        def __contains__(self, key):  # noqa: ANN001
            return True

    _pin_dns(monkeypatch, _AlwaysPublic())
    _pin_transport(monkeypatch, handler)

    with pytest.raises(ValueError) as excinfo:
        notebook_os.source_from_url(f"http://{PUBLIC_HOST}/loop")

    assert str(excinfo.value) == "too_many_redirects"
    # Original request + MAX_URL_REDIRECTS hops, then the guard trips.
    assert len(requested) == notebook_os.MAX_URL_REDIRECTS + 1


def test_direct_loopback_url_is_blocked_without_any_fetch(monkeypatch):
    """Sanity mirror of the direct-private case: no request is ever issued."""
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        requested.append(str(request.url))
        return httpx.Response(200, text=LEAK_MARKER)

    _pin_dns(monkeypatch, {"127.0.0.1": "127.0.0.1"})
    _pin_transport(monkeypatch, handler)

    with pytest.raises(ValueError) as excinfo:
        notebook_os.source_from_url("http://127.0.0.1:9000/internal")

    assert str(excinfo.value) == "private_url_blocked"
    assert requested == []
