# Apollo Routers — how to add a new integration

A **router** is how you give Apollo a new ability: connecting it to Printify, Gmail,
n8n, Make.com, market data, GitHub, your Obsidian vault — anything with an API.

The whole design goal here is simple: **adding a new capability = one new file + one
Claude Code session.** You don't have to redesign Apollo each time.

**Already built and live** (registered as Claude tools in `backend/claude_client.py`):

- `spotify_router.py` — play / queue / control playback.
- `email_router.py` — read and search the iCloud inbox.
- `github_router.py` — list / search / create repos and read repo files.

`example_router.py` is the template for adding the next one.

---

## To add a new integration to Apollo

1. **Copy the template.** Duplicate `example_router.py` and rename it for your
   integration, e.g. `printify_router.py`.

2. **Tell Claude Code what you want.** For example:
   > "Add a router for Printify that creates a product listing, following the
   > pattern in `example_router.py`. Here's the API doc / endpoint / key I want to use."

3. **Claude Code wires it in** and tells you how to call it from Apollo.

4. **Secrets go in `.env`, never in code.** If the new router needs an API key,
   read it from the environment (`os.environ.get("SOME_KEY")`), add the real value
   to your local `.env`, and add a matching empty line to `.env.example` (e.g.
   `PRINTIFY_API_KEY=`) so it's documented for the future.

---

## Where it plugs in

In `backend/claude_client.py` there is a clearly marked spot:

```python
# --- TOOL / ROUTER REGISTRATION ---
```

That's where Apollo hands your routers to Claude as **tools** (using Claude "tool
use" / function-calling), so Apollo can decide on its own to call them during a
conversation. To wire in a new router you do two things there:

1. Add a **tool definition** (name, description, input schema) in `_tools()`.
2. Add a matching branch in `_execute_tool()` that calls your router function.

The agentic loop already handles the rest: Claude asks for a tool, Apollo runs it,
feeds the result back, and Claude replies in words.

---

## The shape of a router

Keep each router self-contained and easy to read:

- One file per integration.
- Each action is a plain function with a clear **docstring**, simple **inputs**,
  and a simple **return value** (usually a `dict` or a `str`).
- No secrets hardcoded — read them from the environment.

See `example_router.py` for a working template.
