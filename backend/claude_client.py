"""
Apollo's connection to Claude (the AI brain).

ALL Anthropic / Claude API code lives in this one file. If you ever want to change
how Apollo talks to Claude (or swap to a different provider), this is the only place
you need to look.

Key safety behavior:
  - The API key is read from the environment (loaded from your local .env file).
  - If there is NO key, Apollo does NOT crash. It runs in a friendly "no key yet"
    mode so you can still open the app and test the interface. (See get_reply.)
"""

import os

from anthropic import Anthropic

from . import config

# Read the system prompt (Apollo's personality) from the editable text file.
_PROMPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts"
)
_SYSTEM_PROMPT_PATH = os.path.join(_PROMPTS_DIR, "apollo_system.txt")


def _load_system_prompt():
    """Read Apollo's persona from prompts/apollo_system.txt every call, so edits
    take effect on the next message without restarting."""
    try:
        with open(_SYSTEM_PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        # A sensible fallback if the file is missing.
        return "You are Apollo, a sharp, capable, warm and concise personal assistant."


def has_api_key():
    """True if an Anthropic API key is present in the environment."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    # Treat the placeholder text from .env.example as "no real key".
    return bool(key) and key != "paste-your-key-here"


def get_reply(history, user_message):
    """
    Ask Claude for a reply.

      history:      list of past messages like [{"role": "user"/"assistant", "content": ...}]
      user_message: the new text the user just sent

    Returns the reply text (a string).

    - No API key?  -> returns a friendly "add my key" placeholder (no network call).
    - API error?   -> returns a friendly error message and logs the real error.
    """
    # --- Graceful "no key yet" mode -------------------------------------------
    if not has_api_key():
        return (
            "I need my API key to think. Add your Anthropic API key to the .env "
            "file in the Apollo folder, then restart me with run.bat."
        )

    # --- TODO: tool/router registration plugs in here -------------------------
    # In a future version, this is where Apollo's available "tools" (routers like
    # Printify, Gmail, n8n, etc.) would be passed to Claude so it can take real
    # actions. v1 is pure chat — see backend/routers/README.md for how to extend.
    # --------------------------------------------------------------------------

    # Build the message list Claude expects: the recent history + the new message.
    messages = list(history) + [{"role": "user", "content": user_message}]

    try:
        client = Anthropic()  # reads ANTHROPIC_API_KEY from the environment
        response = client.messages.create(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=_load_system_prompt(),
            messages=messages,
        )
        # Concatenate any text blocks in the response into one string.
        parts = [block.text for block in response.content if block.type == "text"]
        return "".join(parts).strip() or "(Apollo had nothing to say.)"
    except Exception as error:
        # Log the real error to the terminal so you can debug it...
        print(f"[Apollo] Claude API error: {error}")
        # ...but show the user something friendly.
        return (
            "Apollo had trouble thinking — check your internet connection or that "
            "your API key in .env is correct."
        )
