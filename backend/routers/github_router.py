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

import os

import httpx

API = "https://api.github.com"


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
