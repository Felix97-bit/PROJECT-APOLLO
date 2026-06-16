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
from fastapi.responses import HTMLResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import claude_client, config, memory  # noqa: E402

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
