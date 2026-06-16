# Apollo Routers — how to add a new integration

A **router** is how you give Apollo a new ability: connecting it to Printify, Gmail,
n8n, Make.com, market data, GitHub, your Obsidian vault — anything with an API.

The whole design goal here is simple: **adding a new capability = one new file + one
Claude Code session.** You don't have to redesign Apollo each time.

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
# --- TODO: tool/router registration plugs in here ---
```

That's where a future version of Apollo will hand your routers to Claude as
**tools** (using Claude "tool use" / function-calling), so Apollo can actually
decide to call them during a conversation. **That part is intentionally not built
in v1** — v1 is pure chat + voice. The routers folder just keeps the door open so
adding it later is clean.

---

## The shape of a router

Keep each router self-contained and easy to read:

- One file per integration.
- Each action is a plain function with a clear **docstring**, simple **inputs**,
  and a simple **return value** (usually a `dict` or a `str`).
- No secrets hardcoded — read them from the environment.

See `example_router.py` for a working template.
