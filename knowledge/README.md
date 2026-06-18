# Apollo's knowledge base (the "brain")

Every `.md` file you put in this folder is loaded into Apollo's context on **every
message**, so Apollo always knows your durable facts — who you are, your business,
clients, tools, workflows, goals, and preferences.

## How to use it
- Drop a Markdown note in here (e.g. `felix_brain.md`, `workflows.md`, `clients.md`).
  Write it by hand, in Obsidian, or have Claude generate it.
- Apollo reads them all automatically on the next message — no restart needed
  (the files are read fresh each time).
- Keep notes focused and reasonably short; everything here is sent with every
  request, so very large vaults will cost more tokens (we can switch to on-demand
  retrieval later if it grows big).

## Privacy
The actual brain notes are **gitignored** — they stay on this machine and are
**never** committed to GitHub, because they contain private personal and client
information. Only this README is committed. Keep your own backup of your notes.

(This file, `README.md`, is ignored by the loader — it isn't treated as knowledge.)
