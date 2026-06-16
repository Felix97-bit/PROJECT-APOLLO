"""
Apollo's memory.

This stores every message (yours and Apollo's) in a small database file called
'apollo.db' that lives in the project folder. Because it's a real file on disk,
Apollo remembers your conversations even after you close and reopen the app.

It uses SQLite, which is built into Python — there's no database server to install
or manage. The whole "database" is just that one file.

NOTE: apollo.db is listed in .gitignore, so your private conversations are NEVER
uploaded to GitHub. They stay on your machine.
"""

import os
import sqlite3
from datetime import datetime, timezone

# Put apollo.db in the project root (one level up from this 'backend' folder).
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_PROJECT_ROOT, "apollo.db")


def _connect():
    """Open a connection to the database file."""
    return sqlite3.connect(DB_PATH)


def init_db():
    """
    Create the 'messages' table if it doesn't exist yet.
    Safe to call every time Apollo starts.
    """
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                role      TEXT NOT NULL,      -- "user" or "assistant"
                content   TEXT NOT NULL,      -- the message text
                timestamp TEXT NOT NULL       -- when it was saved (ISO 8601)
            )
            """
        )
        conn.commit()


def save_message(role, content):
    """
    Save one message.
      role:    "user" (you) or "assistant" (Apollo)
      content: the text of the message
    """
    timestamp = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)",
            (role, content, timestamp),
        )
        conn.commit()


def get_recent(limit):
    """
    Return the most recent 'limit' messages, oldest-first, as a list of dicts:
        [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hey"}]
    Oldest-first is the order Claude expects the conversation in.
    """
    with _connect() as conn:
        # Grab the newest 'limit' rows, then flip them back to chronological order.
        rows = conn.execute(
            "SELECT role, content FROM messages ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    rows.reverse()
    return [{"role": role, "content": content} for (role, content) in rows]


def clear_all():
    """Delete every saved message — gives Apollo a completely fresh start."""
    with _connect() as conn:
        conn.execute("DELETE FROM messages")
        conn.commit()
