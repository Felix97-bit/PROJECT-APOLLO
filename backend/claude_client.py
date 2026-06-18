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

from . import config, knowledge, memory
from .routers import email_router, spotify_router

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
                "Play music on the user's Spotify. Use whenever the user asks to play a "
                "song, an artist's music, one of THEIR OWN playlists, or a genre/mood. "
                "Choose kind carefully:\n"
                "- kind=track: a specific song, e.g. 'play thunderstruck by acdc'.\n"
                "- kind=artist: an artist's songs, e.g. 'play some morgan wallen' or "
                "'play songs from my favourite country artist' (put the artist's name in "
                "query). This starts a running queue of that artist's music.\n"
                "- kind=playlist: one of the USER'S OWN playlists by name, e.g. 'play my "
                "workout playlist' -> query='workout'. It searches the user's own library "
                "first, so prefer this whenever they say 'my ... playlist'.\n"
                "- kind=genre: a style or mood, e.g. 'play some rock'.\n"
                "Use kind=any only if you genuinely can't tell."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to play: a song (+artist), an artist name, a "
                                       "playlist name, or a genre/mood.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["track", "artist", "playlist", "genre", "any"],
                    },
                },
                "required": ["query"],
            },
        },
        {
            "name": "queue_music",
            "description": "Add a specific song to the user's Spotify queue WITHOUT "
                           "interrupting what's currently playing. Use for 'queue up X', "
                           "'add X to the queue', or 'play X next'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The song (ideally with the artist) to add to the queue.",
                    }
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
            "name": "check_email",
            "description": (
                "Read Felix's most recent emails from his inbox so you can summarize them, "
                "pull out client requests, flag anything urgent, etc. Returns sender, "
                "subject, date, and a body excerpt for each. Set unread_only=true to only "
                "look at unread mail. Use this whenever Felix asks about his email/inbox."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "count": {
                        "type": "integer",
                        "description": "How many recent emails to fetch (default 10, max 25).",
                    },
                    "unread_only": {
                        "type": "boolean",
                        "description": "If true, only return unread emails.",
                    },
                },
            },
        },
        {
            "name": "search_email",
            "description": "Search Felix's recent inbox for emails matching a keyword, "
                           "sender, or topic (e.g. a client name). Returns matching emails "
                           "with sender, subject, date, and excerpt.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Keyword, sender, or topic to look for.",
                    },
                    "count": {
                        "type": "integer",
                        "description": "Max emails to return (default 10).",
                    },
                },
                "required": ["query"],
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
        {
            "name": "save_workflow",
            "description": (
                "Save a named workflow / standard operating procedure / repeatable job to "
                "Felix's permanent knowledge base, so you ALWAYS know how to do it in every "
                "future session. Use this (not 'remember') whenever Felix teaches you a "
                "multi-step process or says things like 'here's how I do X, remember it' or "
                "'remember this workflow'. Capture the FULL steps, tools, and details clearly "
                "enough that you could follow them later. Confirm back to him what you saved."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Short title, e.g. 'Client onboarding' or 'Cold outreach build'.",
                    },
                    "content": {
                        "type": "string",
                        "description": "The full workflow — steps, tools, and details, written clearly.",
                    },
                },
                "required": ["name", "content"],
            },
        },
    ]


def _execute_tool(name, tool_input):
    """Run a tool Claude asked for, and return a short text result."""
    try:
        if name == "play_music":
            return spotify_router.play(tool_input.get("query", ""), tool_input.get("kind", "any"))
        if name == "queue_music":
            return spotify_router.queue(tool_input.get("query", ""))
        if name == "control_playback":
            return spotify_router.control(tool_input.get("action", ""))
        if name == "check_email":
            return email_router.check_email(
                tool_input.get("count", 10), tool_input.get("unread_only", False)
            )
        if name == "search_email":
            return email_router.search_email(
                tool_input.get("query", ""), tool_input.get("count", 10)
            )
        if name == "remember":
            fact = (tool_input.get("fact") or "").strip()
            if not fact:
                return "There was nothing to remember."
            memory.save_fact(fact)
            return "Saved to long-term memory."
        if name == "save_workflow":
            ok = knowledge.add_workflow(tool_input.get("name", ""), tool_input.get("content", ""))
            if ok:
                return f"Saved the '{tool_input.get('name', '').strip()}' workflow to your knowledge base."
            return "I need both a name and the steps to save a workflow."
        return f"Unknown tool: {name}"
    except Exception as error:
        print(f"[Apollo] Tool '{name}' error: {error}")
        return "That action hit an error on my end."


def _text_of(response):
    """Pull the plain text out of a Claude response."""
    parts = [block.text for block in response.content if block.type == "text"]
    return "".join(parts).strip()


def _build_system(brain, facts, relevant):
    """Assemble Apollo's system prompt: persona + the knowledge-base brain +
    long-term facts + any older messages the keyword search pulled up."""
    parts = [_load_system_prompt()]

    if brain:
        parts.append(
            "\n\n=== YOUR KNOWLEDGE OF FELIX (your brain — durable, always true "
            "unless he updates it) ===\n" + brain
        )

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

    # Long-term knowledge (the brain) + facts + relevant older messages.
    brain = knowledge.load_brain()
    facts = memory.get_facts(60)
    try:
        relevant = memory.search_memory(user_message, limit=4, exclude_ids=recent_ids)
    except Exception as error:
        print(f"[Apollo] memory search error: {error}")
        relevant = []

    system = _build_system(brain, facts, relevant)
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
