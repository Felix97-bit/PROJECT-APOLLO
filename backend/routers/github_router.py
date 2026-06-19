"""
github_router.py — Apollo's GitHub connector.

Lets Apollo see and work with Felix's repositories via the GitHub REST API.
This is also the foundation for the future website-build workflow (create a repo
per client, push the build, etc.).

Capabilities now:
  - list_repos   : list the repos Felix has access to (read)
  - search_repos : find a repo by name/keyword (read)
  - create_repo  : create a new repository (write — only on explicit request)

Security:
  - Reads GITHUB_TOKEN (a Personal Access Token) from the environment (.env).
  - The token gives full repo access — it lives ONLY in .env (gitignored).

Uses httpx (already a dependency).
"""

import base64
import os

import httpx

API = "https://api.github.com"
_MAX_FILE_CHARS = 6000  # cap a single file's content so it doesn't blow up the context


def _token():
    return os.environ.get("GITHUB_TOKEN", "").strip()


def is_configured():
    t = _token()
    return bool(t) and not t.startswith(("ghp_your", "paste"))


def _headers():
    return {
        "Authorization": f"Bearer {_token()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _api(method, path, **kwargs):
    return httpx.request(method, API + path, headers=_headers(), timeout=20, **kwargs)


def whoami():
    """Return the authenticated GitHub username, or None."""
    if not is_configured():
        return None
    try:
        r = _api("GET", "/user")
        if r.status_code == 200:
            return r.json().get("login")
    except httpx.HTTPError:
        pass
    return None


def _all_repos():
    """Fetch the user's repositories (owner + collaborator + org), newest first."""
    r = _api("GET", "/user/repos", params={
        "per_page": 100,
        "sort": "updated",
        "affiliation": "owner,collaborator,organization_member",
    })
    return r


def list_repos(count=20):
    """List the repositories Felix can access (most recently updated first)."""
    if not is_configured():
        return "GitHub isn't set up yet — add your GITHUB_TOKEN to the .env file."
    count = max(1, min(int(count or 20), 50))
    try:
        r = _all_repos()
        if r.status_code == 401:
            return "GitHub rejected the token — check GITHUB_TOKEN in .env (it may be wrong or revoked)."
        if r.status_code != 200:
            return f"GitHub returned an error ({r.status_code})."
        repos = r.json()
    except httpx.HTTPError:
        return "I couldn't reach GitHub just now, sir — try again in a moment."
    if not repos:
        return "You don't seem to have any repositories."
    shown = repos[:count]
    lines = [f"You have {len(repos)} repositories. Showing the {len(shown)} most recently updated:"]
    for rp in shown:
        vis = "private" if rp.get("private") else "public"
        desc = rp.get("description") or ""
        lines.append(f"\n- {rp['full_name']} ({vis})" + (f" — {desc}" if desc else ""))
    return "\n".join(lines)


def search_repos(query, count=20):
    """Find repositories by name or description keyword."""
    if not is_configured():
        return "GitHub isn't set up yet — add your GITHUB_TOKEN to .env first."
    query = (query or "").strip().lower()
    if not query:
        return "What repository should I look for?"
    count = max(1, min(int(count or 20), 50))
    try:
        r = _all_repos()
        if r.status_code != 200:
            return f"GitHub returned an error ({r.status_code})."
        repos = r.json()
    except httpx.HTTPError:
        return "I couldn't reach GitHub just now, sir."
    matches = [
        rp for rp in repos
        if query in rp["name"].lower() or query in (rp.get("description") or "").lower()
    ]
    if not matches:
        return f"No repositories matching '{query}'."
    lines = [f"Repositories matching '{query}':"]
    for rp in matches[:count]:
        vis = "private" if rp.get("private") else "public"
        lines.append(f"\n- {rp['full_name']} ({vis}) — {rp.get('html_url')}")
    return "\n".join(lines)


def create_repo(name, description="", private=True):
    """Create a new repository (write action — use only when explicitly asked)."""
    if not is_configured():
        return "GitHub isn't set up yet — add your GITHUB_TOKEN to .env first."
    name = (name or "").strip()
    if not name:
        return "What should the new repository be called?"
    try:
        r = _api("POST", "/user/repos", json={
            "name": name,
            "description": description or "",
            "private": bool(private),
            "auto_init": True,
        })
        if r.status_code in (200, 201):
            data = r.json()
            vis = "private" if data.get("private") else "public"
            return f"Created the {vis} repo {data['full_name']}: {data.get('html_url')}"
        if r.status_code == 422:
            return f"Couldn't create '{name}' — a repository with that name probably already exists."
        if r.status_code == 401:
            return "GitHub rejected the token — check GITHUB_TOKEN in .env."
        return f"GitHub wouldn't create the repo (error {r.status_code})."
    except httpx.HTTPError:
        return "I couldn't reach GitHub just now, sir."


def _resolve_full_name(repo):
    """Turn a short repo name into 'owner/name' (handles owned + collaborator repos)."""
    repo = (repo or "").strip().rstrip("/")
    if "/" in repo:
        return repo
    me = whoami()
    if me:
        r = _api("GET", f"/repos/{me}/{repo}")
        if r.status_code == 200:
            return r.json().get("full_name")
    r = _all_repos()
    if r.status_code == 200:
        for rp in r.json():
            if rp["name"].lower() == repo.lower():
                return rp["full_name"]
    return None


def list_files(repo):
    """List every file inside a repository (the full structure), so Apollo can
    see what's in it."""
    if not is_configured():
        return "GitHub isn't set up yet — add your GITHUB_TOKEN to .env first."
    full = _resolve_full_name(repo)
    if not full:
        return f"I couldn't find a repository called '{repo}'."
    try:
        info = _api("GET", f"/repos/{full}")
        if info.status_code != 200:
            return f"I couldn't open {full} (error {info.status_code})."
        branch = info.json().get("default_branch", "main")
        r = _api("GET", f"/repos/{full}/git/trees/{branch}", params={"recursive": "1"})
        if r.status_code != 200:
            return f"{full} looks empty, or I couldn't read its files (error {r.status_code})."
        files = [t["path"] for t in r.json().get("tree", []) if t.get("type") == "blob"]
    except httpx.HTTPError:
        return "I couldn't reach GitHub just now, sir."
    if not files:
        return f"{full} has no files yet."
    shown = files[:250]
    body = "\n".join(f"- {p}" for p in shown)
    extra = "" if len(files) <= 250 else f"\n…and {len(files) - 250} more"
    return f"{full} contains {len(files)} files:\n{body}{extra}"


def read_file(repo, path):
    """Read the contents of a specific file in a repository (or list a folder)."""
    if not is_configured():
        return "GitHub isn't set up yet — add your GITHUB_TOKEN to .env first."
    full = _resolve_full_name(repo)
    if not full:
        return f"I couldn't find a repository called '{repo}'."
    path = (path or "").strip().lstrip("/")
    if not path:
        return "Which file should I read?"
    try:
        r = _api("GET", f"/repos/{full}/contents/{path}")
        if r.status_code == 404:
            return f"I couldn't find '{path}' in {full}."
        if r.status_code != 200:
            return f"GitHub error reading '{path}' ({r.status_code})."
        data = r.json()
    except httpx.HTTPError:
        return "I couldn't reach GitHub just now, sir."
    if isinstance(data, list):  # it's a folder
        items = [f"{i['name']} ({i['type']})" for i in data]
        return f"'{path}' is a folder in {full}:\n" + "\n".join(f"- {i}" for i in items)
    if data.get("encoding") == "base64":
        try:
            raw = base64.b64decode(data.get("content", ""))
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return f"'{path}' is a binary file ({data.get('size', 0)} bytes) — I can't show its contents."
        except Exception:
            return f"I couldn't decode '{path}'."
    else:
        text = data.get("content", "")
    if len(text) > _MAX_FILE_CHARS:
        text = text[:_MAX_FILE_CHARS] + "\n…[truncated]"
    return f"{full}/{path}:\n\n{text}"
