"""
Apollo's web server (FastAPI).

This single server does two jobs:
  1. Serves the Apollo interface (the HTML/CSS/JS in the 'frontend' folder).
  2. Provides the small API the interface talks to (chat, history, etc).

Because the interface and the API are served from the SAME place (localhost),
there are no cross-origin / CORS headaches. Keep it that way.
"""

import os

from dotenv import load_dotenv

# Load the .env file (your API key) into the environment BEFORE anything else.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))

from fastapi import FastAPI  # noqa: E402  (imported after load_dotenv on purpose)
from fastapi.responses import HTMLResponse, RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import claude_client, config, memory  # noqa: E402
from .routers import spotify_router  # noqa: E402

app = FastAPI(title="Apollo")

_FRONTEND_DIR = os.path.join(_PROJECT_ROOT, "frontend")


# Apollo is an app you actively tweak, so we never want the browser serving a
# stale cached page ("I changed it but still see the old version"). Tell the
# browser not to cache anything Apollo serves — every reload gets the latest.
@app.middleware("http")
async def _no_cache(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.on_event("startup")
def _startup():
    """Make sure the memory database is ready before we handle any requests."""
    memory.init_db()


# ---- Request body shapes -----------------------------------------------------
class ChatRequest(BaseModel):
    message: str


# ---- API endpoints -----------------------------------------------------------
@app.get("/api/health")
def health():
    """A tiny endpoint used to confirm the server is alive."""
    return {"status": "ok"}


@app.post("/api/chat")
def chat(request: ChatRequest):
    """
    The heart of Apollo:
      1. Load recent conversation from memory.
      2. Ask Claude for a reply (using Apollo's persona + that history).
      3. Save both your message and Apollo's reply.
      4. Send the reply back to the interface.
    """
    user_message = (request.message or "").strip()
    if not user_message:
        return {"reply": "I didn't catch that — try typing something."}

    history = memory.get_recent(config.MAX_HISTORY)
    reply = claude_client.get_reply(history, user_message)

    # Save the exchange so Apollo remembers it next time.
    memory.save_message("user", user_message)
    memory.save_message("assistant", reply)

    return {"reply": reply}


@app.get("/api/history")
def history():
    """Return recent messages so the chat repopulates when Apollo reloads."""
    return {"messages": memory.get_recent(config.MAX_HISTORY)}


@app.post("/api/clear")
def clear():
    """Wipe all conversation history for a fresh start."""
    memory.clear_all()
    return {"status": "cleared"}


# ---- Spotify connector (OAuth login flow) ------------------------------------
@app.get("/api/spotify/status")
def spotify_status():
    """Used by Apollo to know if Spotify is set up and connected."""
    return {
        "configured": spotify_router.is_configured(),
        "connected": spotify_router.is_connected(),
    }


@app.get("/spotify/login")
def spotify_login():
    """Send the user to Spotify's 'allow access' page."""
    if not spotify_router.is_configured():
        return HTMLResponse(
            "<h2>Spotify isn't configured yet</h2><p>Add SPOTIFY_CLIENT_ID and "
            "SPOTIFY_CLIENT_SECRET to your .env file, then relaunch Apollo.</p>"
        )
    return RedirectResponse(spotify_router.get_auth_url())


@app.get("/spotify/callback")
def spotify_callback(code: str = None, error: str = None):
    """Spotify redirects here after the user clicks Agree. We swap the code for tokens."""
    if error or not code:
        return HTMLResponse(
            f"<h2>Spotify connection cancelled</h2><p>{error or 'No code was returned.'} "
            "You can close this tab.</p>"
        )
    try:
        spotify_router.exchange_code(code)
    except Exception as e:
        print(f"[Apollo] Spotify token exchange failed: {e}")
        return HTMLResponse(
            "<h2>Couldn't finish connecting</h2><p>Something went wrong exchanging the "
            "code. Go back to Apollo and try again.</p>"
        )
    return HTMLResponse(
        "<!doctype html><html><body style='font-family:sans-serif;text-align:center;"
        "padding-top:60px;background:#FAF8F2;color:#2A2620'>"
        "<h1 style='color:#B8902E'>Apollo is connected to Spotify &#10003;</h1>"
        "<p>You can close this tab and go back to Apollo. Try saying "
        "&ldquo;play thunderstruck by acdc&rdquo;.</p></body></html>"
    )


# ---- Serve the frontend ------------------------------------------------------
def _asset_version(filename):
    """A version tag that changes whenever the file changes (its modified time).
    Appended to the CSS/JS URLs so the browser always fetches the latest after an
    edit, instead of reusing a stale cached copy."""
    try:
        return str(int(os.path.getmtime(os.path.join(_FRONTEND_DIR, filename))))
    except OSError:
        return "1"


@app.get("/")
def index():
    """Serve the main Apollo page, stamping the CSS/JS links with a version tag
    so edits always show up (defeats stale browser caching)."""
    with open(os.path.join(_FRONTEND_DIR, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()
    html = html.replace("/static/styles.css", f"/static/styles.css?v={_asset_version('styles.css')}")
    html = html.replace("/static/app.js", f"/static/app.js?v={_asset_version('app.js')}")
    return HTMLResponse(html)


# Serve everything else in the frontend folder (styles.css, app.js, etc.) at /static.
# index.html references these files as /static/styles.css and /static/app.js.
app.mount("/static", StaticFiles(directory=_FRONTEND_DIR), name="static")
