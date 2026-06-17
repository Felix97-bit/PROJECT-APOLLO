"""
spotify_router.py  —  Apollo's Spotify connector (the first REAL integration).

What it does:
  - Logs Apollo into your Spotify (OAuth) the first time, then stays connected.
  - Searches Spotify and CONTROLS playback on your open Spotify app
    (play a track / playlist / genre, pause, resume, skip, "what's playing").

Security:
  - Reads SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET from the environment (.env).
  - Stores the login token in spotify_token.json (gitignored — never on GitHub).

Notes:
  - Controlling playback requires Spotify Premium AND the Spotify app open on a
    device (that's the "device" Apollo sends play commands to).
  - This file follows the pattern in example_router.py: plain functions with
    clear inputs and simple string return values that Apollo speaks back.
"""

import json
import os
import time
import webbrowser
from urllib.parse import urlencode

import httpx

# ---- Constants ---------------------------------------------------------------
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
REDIRECT_URI = "http://127.0.0.1:8000/spotify/callback"  # MUST match the Spotify app settings
SCOPES = (
    "user-read-playback-state user-modify-playback-state "
    "user-read-currently-playing playlist-read-private playlist-read-collaborative"
)

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOKEN_FILE = os.path.join(_PROJECT_ROOT, "spotify_token.json")

_NO_DEVICE = (
    "I can't see an active Spotify device. Open the Spotify app on your PC and "
    "play (then pause) any track so it becomes active, then ask me again."
)


# ---- Credentials / connection state -----------------------------------------
def _creds():
    cid = os.environ.get("SPOTIFY_CLIENT_ID", "").strip()
    secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "").strip()
    return cid, secret


def is_configured():
    """True if the Spotify Client ID + Secret are present in .env."""
    cid, secret = _creds()
    return bool(cid and secret)


def _load_tokens():
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _save_tokens(tokens):
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(tokens, f)


def is_connected():
    """True if Apollo has a saved Spotify login (refresh token)."""
    tokens = _load_tokens()
    return bool(tokens and tokens.get("refresh_token"))


# ---- OAuth -------------------------------------------------------------------
def get_auth_url():
    """The Spotify 'allow access' URL the user approves once."""
    cid, _ = _creds()
    return AUTH_URL + "?" + urlencode({
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
    })


def start_login():
    """Open the Spotify permission page in the user's browser."""
    try:
        webbrowser.open(get_auth_url())
    except Exception:
        pass


def exchange_code(code):
    """Exchange the one-time code (from the callback) for tokens, and save them."""
    cid, secret = _creds()
    r = httpx.post(
        TOKEN_URL,
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI},
        auth=(cid, secret),
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    _save_tokens({
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token"),
        "expires_at": time.time() + data.get("expires_in", 3600),
    })


def _get_access_token():
    """Return a valid access token, refreshing it if it's expired."""
    tokens = _load_tokens()
    if not tokens:
        raise RuntimeError("Spotify is not connected.")
    if time.time() < tokens.get("expires_at", 0) - 30:
        return tokens["access_token"]
    # Refresh
    cid, secret = _creds()
    r = httpx.post(
        TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
        auth=(cid, secret),
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    tokens["access_token"] = data["access_token"]
    tokens["expires_at"] = time.time() + data.get("expires_in", 3600)
    if data.get("refresh_token"):
        tokens["refresh_token"] = data["refresh_token"]
    _save_tokens(tokens)
    return tokens["access_token"]


# ---- Low-level Spotify Web API helper ---------------------------------------
def _api(method, path, token, **kwargs):
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    return httpx.request(method, API_BASE + path, headers=headers, timeout=15, **kwargs)


def _search(token, query, type_, limit=3):
    r = _api("GET", "/search", token, params={"q": query, "type": type_, "limit": limit})
    r.raise_for_status()
    return r.json()


def _first(search_json, key):
    """Return the first non-null item of a search result section (tracks/playlists)."""
    items = (search_json.get(key) or {}).get("items") or []
    for item in items:
        if item:
            return item
    return None


def _device_id(token):
    r = _api("GET", "/me/player/devices", token)
    if r.status_code != 200:
        return None
    devices = r.json().get("devices", [])
    if not devices:
        return None
    active = next((d for d in devices if d.get("is_active")), devices[0])
    return active.get("id")


def _play_error(r):
    if r.status_code == 403:
        return "Spotify says that needs Premium, or the action isn't allowed right now."
    if r.status_code == 404:
        return _NO_DEVICE
    return f"Spotify wouldn't start playback (error {r.status_code})."


def _start(token, body, label):
    """Start playback of a uris list or a context (playlist) on the active device."""
    did = _device_id(token)
    if not did:
        return _NO_DEVICE
    r = _api("PUT", "/me/player/play", token, params={"device_id": did}, json=body)
    if r.status_code in (200, 202, 204):
        return f"Now playing {label}."
    return _play_error(r)


# ---- Guard shared by every public action ------------------------------------
def _ready():
    """Returns (token, None) if good to go, or (None, message) to send back."""
    if not is_configured():
        return None, ("Spotify isn't set up yet — its Client ID and Secret are "
                      "missing from the .env file.")
    if not is_connected():
        start_login()
        return None, ("I've opened Spotify's permission page in your browser. "
                      "Click Agree, then ask me again.")
    try:
        return _get_access_token(), None
    except Exception:
        start_login()
        return None, ("I need to reconnect to Spotify — I've opened the permission "
                      "page. Click Agree, then ask me again.")


# ---- Public actions (these are what Apollo calls) ---------------------------
def play(query, kind="any"):
    """
    Play music on Spotify.
      query: a song+artist, a playlist name, or a genre/mood.
      kind:  "track" | "playlist" | "genre" | "any"
    Returns a short status message Apollo speaks back.
    """
    token, msg = _ready()
    if msg:
        return msg
    query = (query or "").strip()
    if not query:
        return "What would you like me to play?"
    kind = (kind or "any").lower()

    try:
        if kind == "track":
            track = _first(_search(token, query, "track"), "tracks")
            if not track:
                return f"I couldn't find a track for '{query}'."
            label = f"{track['name']} by {track['artists'][0]['name']}"
            return _start(token, {"uris": [track["uri"]]}, label)

        if kind in ("playlist", "genre"):
            pl = _first(_search(token, query, "playlist"), "playlists")
            if not pl:
                return f"I couldn't find a playlist for '{query}'."
            return _start(token, {"context_uri": pl["uri"]}, pl["name"])

        # "any": prefer an exact track, else a playlist
        results = _search(token, query, "track,playlist")
        track = _first(results, "tracks")
        if track:
            label = f"{track['name']} by {track['artists'][0]['name']}"
            return _start(token, {"uris": [track["uri"]]}, label)
        pl = _first(results, "playlists")
        if pl:
            return _start(token, {"context_uri": pl["uri"]}, pl["name"])
        return f"I couldn't find anything for '{query}'."
    except httpx.HTTPError:
        return "I had trouble reaching Spotify just now — try again in a moment."


def play_named_playlist(name):
    """Play one of the user's OWN playlists by (fuzzy) name; falls back to search."""
    token, msg = _ready()
    if msg:
        return msg
    name = (name or "").strip()
    try:
        r = _api("GET", "/me/playlists", token, params={"limit": 50})
        if r.status_code == 200:
            lowered = name.lower()
            best = None
            for pl in r.json().get("items", []):
                if pl and lowered in (pl.get("name", "").lower()):
                    best = pl
                    break
            if best:
                return _start(token, {"context_uri": best["uri"]}, best["name"])
    except httpx.HTTPError:
        pass
    # Fall back to a public playlist search
    return play(name, "playlist")


def control(action):
    """Control playback: pause | resume | next | previous | current."""
    token, msg = _ready()
    if msg:
        return msg
    action = (action or "").lower()

    try:
        if action == "current":
            r = _api("GET", "/me/player/currently-playing", token)
            if r.status_code == 204 or not r.text:
                return "Nothing is playing right now."
            if r.status_code == 200:
                item = r.json().get("item")
                if item:
                    return f"Currently playing {item['name']} by {item['artists'][0]['name']}."
                return "Nothing is playing right now."
            return "I couldn't check what's playing."

        endpoints = {
            "pause": ("PUT", "/me/player/pause"),
            "resume": ("PUT", "/me/player/play"),
            "next": ("POST", "/me/player/next"),
            "previous": ("POST", "/me/player/previous"),
        }
        if action not in endpoints:
            return "I can pause, resume, skip, go back, or tell you what's playing."
        method, path = endpoints[action]
        r = _api(method, path, token)
        if r.status_code in (200, 202, 204):
            return {
                "pause": "Paused.",
                "resume": "Resumed.",
                "next": "Skipped to the next track.",
                "previous": "Went back a track.",
            }[action]
        return _play_error(r)
    except httpx.HTTPError:
        return "I had trouble reaching Spotify just now — try again in a moment."
