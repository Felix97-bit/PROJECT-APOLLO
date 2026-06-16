"""
Apollo configuration.

These are the simple knobs that control how Apollo behaves.
Change a value here and restart Apollo (run.bat) for it to take effect.
"""

# Apollo's brain — the Claude model used to think and reply.
#   "claude-sonnet-4-6"        -> balanced intelligence + cost (default, recommended)
#   "claude-opus-4-8"          -> smarter, but pricier
#   "claude-haiku-4-5-20251001"-> faster + cheaper, a little less capable
MODEL = "claude-sonnet-4-6"

# How many past messages (user + Apollo) to send to Claude as context each turn.
# Higher = Apollo remembers more of the recent conversation, but costs a bit more.
MAX_HISTORY = 20

# The maximum length of a single Apollo reply, measured in tokens (~ words).
MAX_TOKENS = 1024

# The port the local Apollo server listens on. http://localhost:8000
PORT = 8000
