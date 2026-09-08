# Apollo

Apollo is your personal AI assistant — a calm white-and-gold app with a glowing
golden compass at its heart. You type (or speak) to it, and Apollo replies **out
loud and in writing**. It remembers your past conversations, it can already act on
your behalf through **live integrations** (Spotify, email, GitHub, web search), and
it's built so new abilities can be added later by dropping in a file.

---

## 1. Where Apollo lives

Apollo isn't installed from an app store. It's a **folder of code on your PC**:

```
C:\Users\feerp\Projects\apollo\
```

When you run `run.bat`, Python reads those files and starts Apollo in its own window.

That folder is also backed up to a **private GitHub repository**
(`github.com/Felix97-bit/PROJECT-APOLLO`). GitHub keeps a safe copy and a full
history of changes — but **GitHub never sees your API key or your conversations**.
Those stay only on this machine (see the security note below).

> **In short:** local folder = where Apollo runs. Private GitHub repo = backup +
> version history. Git keeps the two in sync.

---

## 2. Install Python (one time)

Apollo runs on Python. To check whether you have it, open **PowerShell** and type:

```powershell
python --version
```

If you see something like `Python 3.12.x`, you're good. If not, install it from
<https://www.python.org/downloads/> and **tick "Add python.exe to PATH"** during
setup. (On this machine it's already installed.)

---

## 3. Get an Anthropic API key (Apollo's brain)

Apollo thinks using **Claude**, reached over the internet with an API key.

1. Go to **<https://console.anthropic.com>** and sign in / sign up.
   - ⚠️ This is a **separate account** from a Claude.ai Pro subscription. **Pro does
     NOT include API usage** — the API is pay-as-you-go, billed per use, no monthly fee.
2. Add a payment method.
3. Create an API key and copy it (it starts with `sk-ant-...`).

### 💰 Realistic cost
On the default model (`claude-sonnet-4-6`), normal personal use runs about
**$1–15/month**. A single back-and-forth costs a fraction of a cent.

### ⚠️ MOST IMPORTANT SAFETY STEP — set a spending limit
In the Anthropic Console go to **Settings → Limits** and set a **monthly limit of
$30–50** while you're learning. This guarantees Apollo can never cost more than you
allow, even if something runs away. **Do this before you start.**

### 🔑 Back up your key
Your key lives **only** in the local `.env` file and is **never** uploaded to GitHub.
So save a copy somewhere safe too (e.g. a password manager). If your PC ever dies,
the code restores from GitHub but the key must be re-added.

---

## 4. Set it up and run it

**Step 1 — one-time setup.** Double-click:

```
setup.bat
```

This creates a private Python environment and installs what Apollo needs.

**Step 2 — add your key.** Open the file `.env` (created by setup) in this folder and
paste your key after the `=`:

```
ANTHROPIC_API_KEY=sk-ant-your-real-key-here
```

Save the file.

**Step 3 — launch Apollo.** Double-click:

```
run.bat
```

Apollo opens in its own clean window. 🎉

> **No key yet?** Apollo still opens and the whole interface works — it just replies
> with a friendly "add my key" message until you paste a real key and relaunch.

---

## 5. How to use Apollo

- **Type** in the chat panel (top-left) and press **Enter**. Apollo replies in the
  chat **and speaks out loud**.
- The **golden compass glows** while Apollo is speaking — that's its signature.
- **Mute button** (speaker icon): silences Apollo's voice. It still replies in text,
  and the compass gives a gentle glow pulse. Your choice is remembered.
- **Mic button**: click it, speak, and your words appear in the input box. Review/edit
  them, then press Enter to send. (Voice input works best in Chrome/Edge — which is
  how Apollo launches.)
- **Collapse the chat** with the `—` button in the chat header to enjoy just the
  compass; a small button restores it.
- Apollo **remembers** past conversations — close it and reopen it, and your history
  is still there.

---

## 6. Make Apollo your own (personality + routines)

Open **`prompts/apollo_system.txt`**. The `PERSONA` section controls how Apollo talks
— edit it freely. The `ROUTINES` section is where you'll later add named shortcuts
(e.g. "run store weekly"). Changes take effect on Apollo's next reply.

---

## 7. Integrations (what Apollo can already do)

Apollo doesn't just chat — Claude can decide, on its own, to use real tools during a
conversation. These are **live** today:

- **Spotify** — play a song, artist, one of your own playlists, or a genre; queue a
  track; and pause/resume/skip/say what's playing.
- **Email (iCloud)** — read your most recent inbox mail (or unread only) and search it
  by keyword, sender, or topic, so Apollo can summarize and flag what matters.
- **GitHub** — list and search your repos, create a new repo, and look inside a repo
  (list its files, read a file).
- **Web** — live web search and page-reading (run server-side by Anthropic).
- **Memory & workflows** — Apollo can save durable facts about you and named workflows
  to its permanent knowledge base.

Each capability is a small self-contained file in `backend/routers/`, registered as a
Claude tool in `backend/claude_client.py`. Every integration reads its credentials
from `.env` (see `.env.example`) — **no secrets ever live in code or on GitHub**.

Want to add another (Printify, n8n, Make.com, your Obsidian vault, …)? See
**`backend/routers/README.md`**: copy `example_router.py`, then ask Claude Code to wire
it in, and put any new API key in `.env`.

---

## 8. Backup & restore (git)

**Save your changes** to GitHub whenever you want a backup:

```powershell
cd C:\Users\feerp\Projects\apollo
git add .
git commit -m "Describe what you changed"
git push
```

**Restore on a new/repaired PC:**

```powershell
git clone https://github.com/Felix97-bit/PROJECT-APOLLO.git apollo
cd apollo
setup.bat
```

Then re-add your API key to `.env` (it was never on GitHub), and run `run.bat`.

---

## What's protected from GitHub

These never leave your machine (they're listed in `.gitignore`):

| File | What it is |
|---|---|
| `.env` | Your secret API key |
| `apollo.db` | Your private conversation history |
| `venv/` | The local Python environment (rebuilt by `setup.bat`) |

---

## Project layout

```
apollo/
├── backend/        FastAPI server, Claude connection, memory, routers
├── frontend/       The interface: HTML, CSS, JS, the compass
├── prompts/        Apollo's editable personality + routines
├── setup.bat       One-time setup
├── run.bat         Launch Apollo
└── README.md       You're reading it
```
