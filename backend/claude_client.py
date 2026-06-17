"""
Apollo's connection to Claude (the AI brain) + its tools.

ALL Anthropic / Claude API code lives in this one file. This is also where
Apollo's "tools" (its real-world abilities, like Spotify) are registered, so
Claude can decide on its own to call them when you ask for something.

How tool-use works (the agentic loop):
  1. We send your message to Claude along with the list of available tools.
  2. If Claude wants to use a tool, it replies with stop_reason == "tool_use".
  3. We run that tool (e.g. Spotify play), send the result back to Claude.
  4. Claude then replies in words, which Apollo speaks/shows.

Key safety behavior:
  - The API key is read from the environment (loaded from your local .env file).
  - If there is NO key, Apollo runs in a friendly "no key yet" mode.
"""

import os

from anthropic import Anthropic

from . import config, memory
from .routers import spotify_router

_PROMPTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts"
)
_SYSTEM_PROMPT_PATH = os.path.join(_PROMPTS_DIR, "apollo_system.txt")

# How many tool round-trips we allow before forcing a final answer (safety net).
_MAX_TOOL_LOOPS = 6


def _load_system_prompt():
    try:
        with open(_SYSTEM_PROMPT_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return "You are Apollo, a sharp, capable, warm and concise personal assistant."


def has_api_key():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return bool(key) and key != "paste-your-key-here"


# --- TOOL / ROUTER REGISTRATION ----------------------------------------------
# To give Apollo a new ability: add a tool definition here, and a matching branch
# in _execute_tool() that calls your router. (See backend/routers/README.md.)
def _tools():
    return [
        {
            "name": "play_music",
            "description": (
                "Play music on the user's Spotify. Use whenever the user asks to "
                "play a song, artist, playlist, genre, or mood. Examples: "
                "'play thunderstruck by acdc' -> kind=track; "
                "'play my workout playlist' -> kind=playlist; "
                "'play some rock' -> kind=genre."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to play: a song (+artist), playlist name, or genre/mood.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["track", "playlist", "genre", "any"],
                        "description": "track = a specific song; playlist = a named playlist; "
                                       "genre = a style/mood; any = unsure.",
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "control_playback",
            "description": "Control current Spotify playback: pause, resume, skip to the "
                           "next or previous track, or report what's currently playing.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["pause", "resume", "next", "previous", "current"],
                    }
                },
                "required": ["action"],
            },
        },
        {
            "name": "remember",
            "description": (
                "Save a durable fact to long-term memory so you ALWAYS remember it in "
                "future conversations. Use it when you learn something lasting about "
                "Felix (his business, clients, preferences, goals) or when you complete "
                "a piece of work for him. Examples: 'Felix's main client is Henderson "
                "Roofing', 'Felix prefers dark, minimal UIs', 'Built Felix a landing "
                "page for his roofing client on 2026-06-17'. Don't save trivial or "
                "one-off chit-chat — only things worth remembering long-term."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description": "One concise, standalone fact or accomplishment to remember.",
                    }
                },
                "required": ["fact"],
            },
        },
    ]


def _execute_tool(name, tool_input):
    """Run a tool Claude asked for, and return a short text result."""
    try:
        if name == "play_music":
            return spotify_router.play(tool_input.get("query", ""), tool_input.get("kind", "any"))
        if name == "control_playback":
            return spotify_router.control(tool_input.get("action", ""))
        if name == "remember":
            fact = (tool_input.get("fact") or "").strip()
            if not fact:
                return "There was nothing to remember."
            memory.save_fact(fact)
            return "Saved to long-term memory."
        return f"Unknown tool: {name}"
    except Exception as error:
        print(f"[Apollo] Tool '{name}' error: {error}")
        return "That action hit an error on my end."


def _text_of(response):
    """Pull the plain text out of a Claude response."""
    parts = [block.text for block in response.content if block.type == "text"]
    return "".join(parts).strip()


def _build_system(facts, relevant):
    """Assemble Apollo's system prompt: persona + long-term facts + any older
    messages the keyword search pulled up as relevant to this question."""
    parts = [_load_system_prompt()]

    if facts:
        parts.append(
            "\n\n=== LONG-TERM MEMORY — durable facts about Felix and work you've "
            "done. Treat these as things you already know. ==="
        )
        parts.extend(f"- {f}" for f in facts)

    if relevant:
        parts.append(
            "\n\n=== EARLIER MESSAGES (retrieved from older history by keyword search; "
            "they're outside the recent conversation and MAY be relevant — use them "
            "only if they actually help answer Felix). ==="
        )
        for m in relevant:
            who = "Felix" if m["role"] == "user" else "You (Apollo)"
            snippet = " ".join(m["content"].split())
            if len(snippet) > 300:
                snippet = snippet[:300] + "…"
            parts.append(f"- {who}: {snippet}")

    return "\n".join(parts)


def get_reply(user_message):
    """
    Ask Claude for a reply, with Apollo's full memory:
      - the recent conversation window (config.MAX_HISTORY messages),
      - durable facts (always remembered),
      - relevant OLDER messages found by keyword search,
    and let it use tools (Spotify, remember) when appropriate.

    Returns the reply text (a string).
    """
    # --- Graceful "no key yet" mode -------------------------------------------
    if not has_api_key():
        return (
            "I need my API key to think. Add your Anthropic API key to the .env "
            "file in the Apollo folder, then restart me with run.bat."
        )

    # Recent conversation (with ids so we don't re-surface them via search).
    recent = memory.get_recent_full(config.MAX_HISTORY)
    recent_ids = {m["id"] for m in recent}
    history = [{"role": m["role"], "content": m["content"]} for m in recent]

    # Long-term facts + relevant older messages.
    facts = memory.get_facts(60)
    try:
        relevant = memory.search_memory(user_message, limit=4, exclude_ids=recent_ids)
    except Exception as error:
        print(f"[Apollo] memory search error: {error}")
        relevant = []

    system = _build_system(facts, relevant)
    messages = history + [{"role": "user", "content": user_message}]
    tools = _tools()

    try:
        client = Anthropic()
        response = None
        for _ in range(_MAX_TOOL_LOOPS):
            response = client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=system,
                tools=tools,
                messages=messages,
            )

            if response.stop_reason != "tool_use":
                break

            # Claude wants to use one or more tools. Run them, feed results back.
            messages.append({"role": "assistant", "content": response.content})
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    result = _execute_tool(block.name, block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })
            messages.append({"role": "user", "content": tool_results})

        return _text_of(response) or "(Apollo had nothing to say.)"
    except Exception as error:
        print(f"[Apollo] Claude API error: {error}")
        return (
            "Apollo had trouble thinking — check your internet connection or that "
            "your API key in .env is correct."
        )
