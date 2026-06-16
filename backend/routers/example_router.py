"""
example_router.py  —  the TEMPLATE for adding new abilities to Apollo.

This file does nothing important on its own. It exists to show you (and Claude Code)
THE PATTERN for adding a new integration — a "router" — to Apollo. A router is just
a self-contained Python file that exposes one or more simple functions Apollo could
call to do something useful in the real world (create a product, send an email,
look something up, etc.).

In v1, Apollo does NOT call these automatically yet (that's a future upgrade using
Claude "tool use"). For now this is the clean, documented shape to copy.

------------------------------------------------------------------------------
HOW TO ADD YOUR OWN ROUTER (the whole point of this architecture):

  1. Copy this file to a new name, e.g.  printify_router.py
  2. Replace the function below with your real action.
  3. If it needs a secret (an API key), read it from the environment:
         import os
         key = os.environ.get("PRINTIFY_API_KEY")
     ...and add a line  PRINTIFY_API_KEY=  to .env.example, and the real value
     to your local .env (which is never committed).
  4. Ask Claude Code: "Wire this router into Apollo."

Each router function should have:
  - a clear docstring (what it does)
  - obvious inputs (plain arguments)
  - a simple return value (usually a dict or string)
------------------------------------------------------------------------------
"""


def get_weather(city: str) -> dict:
    """
    EXAMPLE ACTION (fake data — not real).

    What it does:  pretends to look up the weather for a city.
    Input:         city  — the name of a city, e.g. "London"
    Returns:       a dict with the (fake) weather, e.g.
                       {"city": "London", "temperature_c": 18, "condition": "Cloudy"}

    A real router would call an actual weather API here instead of returning
    fixed data. This is only here to demonstrate the shape of a router function.
    """
    return {
        "city": city,
        "temperature_c": 18,
        "condition": "Cloudy",
        "note": "This is example data from example_router.py — not a real forecast.",
    }


def echo(text: str) -> str:
    """
    The simplest possible action: returns whatever text you give it.
    Useful as a sanity check when learning how routers plug in.
    """
    return text
