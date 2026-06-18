"""
Apollo's knowledge base ("the brain").

Every Markdown file in the project's `knowledge/` folder is loaded and fed to
Apollo as base context on EVERY message — so Apollo always knows the durable
facts about Felix, his business, clients, tools, and preferences.

This is the foundation of the "second brain": drop more .md notes into
knowledge/ (write them by hand, in Obsidian, or have Claude generate them) and
Apollo will read them automatically. The files are kept LOCAL (gitignored) since
they hold private personal and client information.
"""

import glob
import os

_KNOWLEDGE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "knowledge"
)


def load_brain():
    """Read and concatenate every .md file in knowledge/. Returns '' if none."""
    if not os.path.isdir(_KNOWLEDGE_DIR):
        return ""
    parts = []
    for path in sorted(glob.glob(os.path.join(_KNOWLEDGE_DIR, "*.md"))):
        # The committed README isn't knowledge about Felix — skip it.
        if os.path.basename(path).lower() == "readme.md":
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read().strip()
            if text:
                parts.append(text)
        except OSError:
            continue
    return "\n\n".join(parts)
