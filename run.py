"""
Apollo launcher.

This does three things, in order:
  1. Makes sure Apollo's memory database is ready.
  2. Starts the local Apollo web server.
  3. Opens Apollo in a clean, borderless standalone window (Chrome/Edge "app mode"),
     so it looks like a real desktop app instead of a browser tab.

You normally don't run this directly — just double-click run.bat.
"""

import os
import sys
import shutil
import subprocess
import threading
import time
import urllib.request

# IMPORTANT: when launched via pythonw.exe (the no-console launcher the desktop
# shortcut uses), sys.stdout and sys.stderr are None. Any print() or log write
# then raises an error and the app dies SILENTLY — nothing opens. So redirect
# output to a log file. This is what makes double-clicking the shortcut work.
if sys.stdout is None or sys.stderr is None:
    _log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apollo_launch.log")
    _log_file = open(_log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = _log_file
    sys.stderr = _log_file

import uvicorn

from backend import config, memory

URL = f"http://127.0.0.1:{config.PORT}"


def _find_browser():
    """Find Chrome, then Edge, by checking the usual Windows install spots.
    Returns the path to the .exe, or None if neither is found."""
    candidates = [
        # Google Chrome
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        # Microsoft Edge
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    # Last resort: maybe one is on the PATH.
    return shutil.which("chrome") or shutil.which("msedge")


def _wait_until_up(timeout=20):
    """Poll the health endpoint until the server answers (or we give up)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{URL}/api/health", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def _open_window():
    """Wait for the server, then open Apollo in a standalone app window."""
    if not _wait_until_up():
        print("[Apollo] Server didn't respond in time — open this in your browser:")
        print(f"          {URL}")
        return

    browser = _find_browser()
    if browser:
        # --app= launches a borderless window with no tabs/address bar.
        subprocess.Popen([browser, f"--app={URL}"])
        print(f"[Apollo] Opened in a standalone window. (If it didn't appear, visit {URL})")
    else:
        # No Chrome/Edge found: fall back to the default browser.
        import webbrowser
        webbrowser.open(URL)
        print(f"[Apollo] Opened in your default browser: {URL}")
        print("[Apollo] Tip: Chrome or Edge gives the nicer standalone-window look.")


def main():
    memory.init_db()
    print("Apollo is starting…")
    print(f"  Local address: {URL}")
    # Open the window on a background thread once the server is ready.
    threading.Thread(target=_open_window, daemon=True).start()
    # Start the server (this call blocks until you close Apollo).
    uvicorn.run("backend.main:app", host="127.0.0.1", port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
