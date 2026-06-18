"""
email_router.py — Apollo's email connector (read access via IMAP).

Lets Apollo read Felix's inbox so it can summarize mail, find client requests, etc.
Works with any IMAP provider; defaults to iCloud Mail (imap.mail.me.com).

Security:
  - Reads IMAP_EMAIL / IMAP_APP_PASSWORD / IMAP_HOST from the environment (.env).
  - The app-specific password gives full mailbox access — it lives ONLY in .env
    (gitignored, never on GitHub), exactly like the API key.
  - This module is READ-ONLY (it never deletes, sends, or marks mail as read —
    it uses BODY.PEEK so checking your mail doesn't change its read status).

Uses Python's built-in imaplib + email — no extra dependencies.
"""

import email as email_mod
import imaplib
import os
import re
from email.header import decode_header


def _settings():
    addr = os.environ.get("IMAP_EMAIL", "").strip()
    pw = os.environ.get("IMAP_APP_PASSWORD", "").strip()
    host = os.environ.get("IMAP_HOST", "").strip() or "imap.mail.me.com"
    return addr, pw, host


def is_configured():
    addr, pw, _ = _settings()
    return bool(addr and pw and pw != "paste-your-app-password-here")


def _decode(value):
    """Decode an email header (handles =?utf-8?...?= encoded words)."""
    if not value:
        return ""
    out = ""
    for text, enc in decode_header(value):
        if isinstance(text, bytes):
            try:
                out += text.decode(enc or "utf-8", errors="replace")
            except (LookupError, TypeError):
                out += text.decode("utf-8", errors="replace")
        else:
            out += text
    return " ".join(out.split())


def _strip_html(html):
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    return " ".join(text.split())


def _body_excerpt(msg, limit=700):
    """Pull a short plain-text excerpt from an email (text/plain preferred)."""
    plain, html = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                continue
            try:
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                decoded = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            except (LookupError, TypeError, ValueError):
                continue
            if ctype == "text/plain" and not plain:
                plain = decoded
            elif ctype == "text/html" and not html:
                html = decoded
    else:
        try:
            payload = msg.get_payload(decode=True)
            decoded = payload.decode(msg.get_content_charset() or "utf-8", errors="replace") if payload else ""
        except (LookupError, TypeError, ValueError):
            decoded = ""
        if msg.get_content_type() == "text/html":
            html = decoded
        else:
            plain = decoded
    text = " ".join(plain.split()) if plain.strip() else _strip_html(html)
    return text[:limit]


def _login():
    """Log into IMAP. Retries with hyphens/spaces stripped from the app password."""
    addr, pw, host = _settings()
    try:
        M = imaplib.IMAP4_SSL(host)
        M.login(addr, pw)
        return M
    except imaplib.IMAP4.error:
        M = imaplib.IMAP4_SSL(host)
        M.login(addr, pw.replace("-", "").replace(" ", ""))
        return M


def _fetch(message_ids, M, count):
    ids = message_ids[-count:]
    ids = list(reversed(ids))  # newest first
    out = []
    for mid in ids:
        typ, data = M.fetch(mid, "(BODY.PEEK[])")  # PEEK = don't mark as read
        if typ != "OK" or not data or not data[0]:
            continue
        msg = email_mod.message_from_bytes(data[0][1])
        out.append({
            "from": _decode(msg.get("From")),
            "subject": _decode(msg.get("Subject")) or "(no subject)",
            "date": (msg.get("Date") or "").strip(),
            "excerpt": _body_excerpt(msg),
        })
    return out


def _format(emails, header):
    if not emails:
        return "No matching emails found."
    lines = [header]
    for i, m in enumerate(emails, 1):
        lines.append(
            f"\n{i}. From: {m['from']}\n   Subject: {m['subject']}\n   Date: {m['date']}\n   {m['excerpt']}"
        )
    return "\n".join(lines)


def check_email(count=10, unread_only=False):
    """Return Felix's most recent emails (or only unread ones) for Apollo to read."""
    if not is_configured():
        return ("Email isn't set up yet — add your iCloud address and an app-specific "
                "password to the .env file, then relaunch me.")
    count = max(1, min(int(count or 10), 25))
    try:
        M = _login()
        try:
            M.select("INBOX")
            typ, data = M.search(None, "UNSEEN" if unread_only else "ALL")
            ids = data[0].split() if data and data[0] else []
            emails = _fetch(ids, M, count)
        finally:
            try:
                M.logout()
            except Exception:
                pass
    except imaplib.IMAP4.error as ex:
        return ("I couldn't log into your email — double-check the app-specific password "
                f"in .env (and that it's your iCloud address). [{ex}]")
    except Exception as ex:
        print(f"[Apollo] email error: {ex}")
        return "I had trouble reaching your email just now, sir — try again in a moment."
    label = "unread " if unread_only else ""
    return _format(emails, f"Your {len(emails)} most recent {label}emails:")


def search_email(query, count=10):
    """Search recent inbox for emails matching a keyword/sender/topic."""
    if not is_configured():
        return "Email isn't set up yet — add your iCloud credentials to .env first."
    query = (query or "").strip()
    if not query:
        return "What should I search your email for?"
    count = max(1, min(int(count or 10), 25))
    terms = [t for t in re.findall(r"[A-Za-z0-9@._-]+", query.lower()) if len(t) > 1]
    try:
        M = _login()
        try:
            M.select("INBOX")
            typ, data = M.search(None, "ALL")
            ids = data[0].split() if data and data[0] else []
            recent = _fetch(ids, M, 40)  # pull recent, filter in Python (robust)
        finally:
            try:
                M.logout()
            except Exception:
                pass
    except imaplib.IMAP4.error as ex:
        return f"I couldn't log into your email — check the app password in .env. [{ex}]"
    except Exception as ex:
        print(f"[Apollo] email search error: {ex}")
        return "I had trouble reaching your email just now, sir."
    matches = []
    for m in recent:
        hay = f"{m['from']} {m['subject']} {m['excerpt']}".lower()
        if all(t in hay for t in terms) if terms else False:
            matches.append(m)
        if len(matches) >= count:
            break
    return _format(matches, f"Emails matching '{query}':")
