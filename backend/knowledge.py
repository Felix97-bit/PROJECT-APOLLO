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
from datetime import date

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


def add_workflow(name, content):
    """Append a named workflow/SOP to knowledge/workflows.md. Because that file
    lives in knowledge/, it's automatically loaded into Apollo's context every
    session — so a workflow taught once is remembered permanently."""
    name = (name or "").strip()
    content = (content or "").strip()
    if not name or not content:
        return False
    os.makedirs(_KNOWLEDGE_DIR, exist_ok=True)
    path = os.path.join(_KNOWLEDGE_DIR, "workflows.md")
    new_file = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as f:
        if new_file:
            f.write(
                "# Felix's Workflows & Standard Procedures\n\n"
                "Workflows Apollo has been taught. Loaded into context every session.\n"
            )
        f.write(f"\n\n## {name}\n_(saved {date.today().isoformat()})_\n\n{content}\n")
    return True
