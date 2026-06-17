"""
Apollo's memory.

Three layers, all stored in the single file 'apollo.db' (gitignored — private):

  1. messages  — every message you and Apollo exchange, saved forever.
  2. facts     — durable things Apollo should always remember (your preferences,
                 your business, work it has done). Always fed back into Apollo.
  3. search    — a keyword index over all past messages, so Apollo can pull up
                 RELEVANT older messages even when they've scrolled out of the
                 recent window. Uses SQLite's built-in full-text search (FTS5),
                 with a plain keyword fallback if FTS5 isn't available.

SQLite is built into Python — no database server to install.
"""

import os
import re
import sqlite3
from datetime import datetime, timezone

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(_PROJECT_ROOT, "apollo.db")

# Set during init_db(): True if SQLite full-text search is available.
_FTS_AVAILABLE = False

# Small set of common words we ignore when picking search keywords.
_STOPWORDS = {
    "the", "and", "for", "are", "was", "were", "you", "your", "yours", "mine",
    "what", "whats", "who", "whom", "when", "where", "why", "how", "did", "does",
    "doing", "that", "this", "with", "from", "have", "has", "had", "can", "could",
    "would", "should", "will", "please", "remember", "about", "his", "her", "him",
    "she", "they", "them", "their", "get", "got", "tell", "told", "into", "than",
    "then", "there", "here", "been", "being", "just", "like", "want", "need",
}


def _connect():
    return sqlite3.connect(DB_PATH)


def init_db():
    """Create the tables (and the search index) if they don't exist yet.
    Safe to call every time Apollo starts."""
    global _FTS_AVAILABLE
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                role      TEXT NOT NULL,
                content   TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS facts (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                content   TEXT NOT NULL,
                timestamp TEXT NOT NULL
            )
            """
        )
        # Try to set up full-text search. If this SQLite build lacks FTS5, we
        # quietly fall back to keyword matching in search_memory().
        try:
            conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts "
                "USING fts5(content, msg_id UNINDEXED)"
            )
            _FTS_AVAILABLE = True
        except sqlite3.OperationalError:
            _FTS_AVAILABLE = False
        conn.commit()

        # Backfill the search index from any existing messages (first upgrade).
        if _FTS_AVAILABLE:
            indexed = conn.execute("SELECT count(*) FROM messages_fts").fetchone()[0]
            total = conn.execute("SELECT count(*) FROM messages").fetchone()[0]
            if indexed == 0 and total > 0:
                for mid, content in conn.execute("SELECT id, content FROM messages").fetchall():
                    conn.execute(
                        "INSERT INTO messages_fts(content, msg_id) VALUES (?, ?)",
                        (content, mid),
                    )
                conn.commit()


# ---- Messages ----------------------------------------------------------------
def save_message(role, content):
    """Save one message (role is 'user' or 'assistant') and index it for search."""
    timestamp = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (role, content, timestamp) VALUES (?, ?, ?)",
            (role, content, timestamp),
        )
        if _FTS_AVAILABLE:
            try:
                conn.execute(
                    "INSERT INTO messages_fts(content, msg_id) VALUES (?, ?)",
                    (content, cur.lastrowid),
                )
            except sqlite3.OperationalError:
                pass
        conn.commit()


def get_recent(limit):
    """Recent messages oldest-first as [{'role','content'}] (used by the chat UI)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    rows.reverse()
    return [{"role": role, "content": content} for role, content in rows]


def get_recent_full(limit):
    """Recent messages oldest-first WITH their ids (so search can skip them)."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM messages ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    rows.reverse()
    return [{"id": r[0], "role": r[1], "content": r[2]} for r in rows]


def clear_all():
    """Delete every saved message (and its search index). Facts are kept."""
    with _connect() as conn:
        conn.execute("DELETE FROM messages")
        if _FTS_AVAILABLE:
            try:
                conn.execute("DELETE FROM messages_fts")
            except sqlite3.OperationalError:
                pass
        conn.commit()


# ---- Facts (durable long-term memory) ---------------------------------------
def save_fact(content):
    """Store a durable fact Apollo should always remember."""
    content = (content or "").strip()
    if not content:
        return
    timestamp = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO facts (content, timestamp) VALUES (?, ?)", (content, timestamp)
        )
        conn.commit()


def get_facts(limit=60):
    """Return up to `limit` of the most recent facts, oldest-first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT content FROM facts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    rows.reverse()
    return [r[0] for r in rows]


def clear_facts():
    """Wipe all stored facts (not wired to any UI button by default)."""
    with _connect() as conn:
        conn.execute("DELETE FROM facts")
        conn.commit()


# ---- Keyword search over past messages --------------------------------------
def _keywords(text):
    """Pull the meaningful search words out of a question."""
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    out = []
    for w in words:
        if len(w) >= 3 and w not in _STOPWORDS and w not in out:
            out.append(w)
    return out[:12]


def search_memory(query, limit=4, exclude_ids=None):
    """
    Find older messages relevant to `query` (by keyword), skipping any whose id
    is in `exclude_ids` (the messages already in the recent window). Returns a
    list of {'role','content'}.
    """
    exclude_ids = exclude_ids or set()
    terms = _keywords(query)
    if not terms:
        return []

    with _connect() as conn:
        rows = []
        if _FTS_AVAILABLE:
            match = " OR ".join('"%s"' % t for t in terms)
            try:
                rows = conn.execute(
                    "SELECT messages_fts.msg_id, m.role, m.content "
                    "FROM messages_fts JOIN messages m ON m.id = messages_fts.msg_id "
                    "WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?",
                    (match, limit + len(exclude_ids) + 5),
                ).fetchall()
            except sqlite3.OperationalError:
                rows = []

        if not rows:
            # Fallback: plain LIKE matching, scored by how many terms appear.
            like = " OR ".join(["content LIKE ?"] * len(terms))
            params = ["%%%s%%" % t for t in terms]
            candidates = conn.execute(
                f"SELECT id, role, content FROM messages WHERE {like} ORDER BY id DESC LIMIT 80",
                params,
            ).fetchall()
            scored = []
            for mid, role, content in candidates:
                low = content.lower()
                score = sum(1 for t in terms if t in low)
                scored.append((score, mid, role, content))
            scored.sort(key=lambda x: (-x[0], -x[1]))
            rows = [(mid, role, content) for _, mid, role, content in scored]

    out, seen = [], set()
    for mid, role, content in rows:
        if mid in exclude_ids or mid in seen:
            continue
        seen.add(mid)
        out.append({"role": role, "content": content})
        if len(out) >= limit:
            break
    return out
